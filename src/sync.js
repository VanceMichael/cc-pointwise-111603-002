import { verifyRecord } from './verify.js';
import { reconcileVoyage } from './reconcile.js';
import { toCollectionRecord } from './adapter.js';

const logsEntry = (voyageId) => `/voyages/${voyageId}/logs?after=0`;
const manifestPath = (voyageId) => `/voyages/${voyageId}/manifest`;

// 同一次重传的字节内容相同，解析后的键序也相同，可以用规范化 JSON 识别同一副本；
// 判断新旧只看记录身份与内容本身，绝不看到达时间。
const canonical = (payload) => JSON.stringify(payload);

function emptyVoyage(voyageId) {
  return {
    voyageId,
    manifest: null,
    manifestHistory: [],
    verified: {},
    rejected: [],
    conflicts: [],
    lastSyncAt: null,
  };
}

function parseManifest(text) {
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object'
    || !Number.isInteger(payload.through) || payload.through < 0) {
    throw new Error('manifest through invalid');
  }
  if (!Array.isArray(payload.noRecord)
    || !payload.noRecord.every((sequence) => Number.isInteger(sequence) && sequence >= 1)) {
    throw new Error('manifest noRecord invalid');
  }
  return { through: payload.through, noRecord: [...new Set(payload.noRecord)].sort((a, b) => a - b) };
}

function parseLogPage(text) {
  const payload = JSON.parse(text);
  if (!payload || !Array.isArray(payload.items)) throw new Error('source items missing');
  const next = payload.next ?? null;
  if (next !== null && typeof next !== 'string') throw new Error('source next invalid');
  return { items: payload.items, next };
}

// 来路按 (path, etag) 归并：保留首次/最近一次见到的时间与累计次数，
// 重传不会把同一条来路刷成“新记录”。
function addSighting(sightings, { path, etag, receivedAt }) {
  const found = sightings.find((entry) => entry.path === path && entry.etag === etag);
  if (found) {
    found.count += 1;
    found.lastReceivedAt = receivedAt;
  } else {
    sightings.push({ path, etag, firstReceivedAt: receivedAt, lastReceivedAt: receivedAt, count: 1 });
  }
}

export class SyncService {
  constructor({ client = null, store, collection = null, key = undefined }) {
    if (!store) throw new TypeError('sync store required');
    this.client = client;
    this.store = store;
    this.collection = collection;
    this.key = key;
  }

  // 拉取一个航次的 manifest 与全部日志分页，更新本地同步状态。
  // 单次同步要么完整落盘要么不改动状态；弱网中断后重试即可，重放天然幂等。
  async syncVoyage(voyageId) {
    if (!this.client) throw new Error('sync client required');
    const state = await this.store.read();
    const voyage = state.voyages[voyageId] ??= emptyVoyage(voyageId);
    const syncedAt = new Date().toISOString();

    const manifestResponse = await this.client.read(manifestPath(voyageId));
    const manifest = parseManifest(manifestResponse.text);
    const current = voyage.manifest && { through: voyage.manifest.through, noRecord: voyage.manifest.noRecord };
    if (!current || canonical(current) !== canonical(manifest)) {
      if (voyage.manifest) voyage.manifestHistory.push(voyage.manifest);
      voyage.manifest = {
        ...manifest,
        provenance: { path: manifestPath(voyageId), etag: manifestResponse.etag ?? null, receivedAt: syncedAt },
      };
    }

    const summary = {
      voyageId, syncedAt, pages: 0, received: 0,
      newVerified: 0, replays: 0, rejected: 0, conflicts: 0,
    };
    const seen = new Set();
    let path = logsEntry(voyageId);
    while (path) {
      if (seen.has(path)) throw new Error(`pagination loop at ${path}`);
      seen.add(path);
      const response = await this.client.read(path);
      const page = parseLogPage(response.text);
      summary.pages += 1;
      const sighting = { path, etag: response.etag ?? null, receivedAt: syncedAt };
      for (const item of page.items) {
        summary.received += 1;
        this.#applyItem(voyage, item, sighting, summary);
      }
      path = page.next;
    }

    voyage.lastSyncAt = syncedAt;
    await this.store.write(state);
    if (this.collection) await this.#project(voyage);
    summary.reconciliation = reconcileVoyage(voyage);
    return summary;
  }

  async reconcile(voyageId) {
    const state = await this.store.read();
    const voyage = state.voyages[voyageId];
    if (!voyage) {
      const known = Object.keys(state.voyages);
      throw new Error(`unknown voyage: ${voyageId}${known.length ? ` (known: ${known.join(', ')})` : ''}`);
    }
    return reconcileVoyage(voyage);
  }

  #applyItem(voyage, item, sighting, summary) {
    const verdict = verifyRecord(item, this.key);
    if (!verdict.ok) {
      this.#recordRejected(voyage, item, verdict.reason, sighting);
      summary.rejected += 1;
      return;
    }
    if (item.voyageId !== voyage.voyageId) {
      this.#recordRejected(voyage, item, 'voyage-mismatch', sighting);
      summary.rejected += 1;
      return;
    }
    const sequence = String(item.sequence);
    const existing = voyage.verified[sequence];
    if (!existing) {
      voyage.verified[sequence] = {
        payload: structuredClone(item),
        receivedCount: 1,
        firstReceivedAt: sighting.receivedAt,
        lastReceivedAt: sighting.receivedAt,
        provenance: [],
      };
      addSighting(voyage.verified[sequence].provenance, sighting);
      summary.newVerified += 1;
      return;
    }
    if (canonical(existing.payload) === canonical(item)) {
      // 重传/补传的同一副本：只登记来路，不重复计数。
      existing.receivedCount += 1;
      existing.lastReceivedAt = sighting.receivedAt;
      addSighting(existing.provenance, sighting);
      summary.replays += 1;
      return;
    }
    // 同一 (voyageId, sequence) 的不同有效内容：到达时间不能决定新旧，
    // 保留首次验证通过的记录，把分歧副本登记为冲突等待处置。
    voyage.conflicts.push({
      sequence: item.sequence,
      kept: structuredClone(existing.payload),
      incoming: structuredClone(item),
      provenance: { ...sighting },
    });
    summary.conflicts += 1;
  }

  #recordRejected(voyage, item, reason, sighting) {
    const dedupeKey = `${reason}:${canonical(item)}`;
    const existing = voyage.rejected.find((entry) => entry.dedupeKey === dedupeKey);
    if (existing) {
      existing.receivedCount += 1;
      existing.lastReceivedAt = sighting.receivedAt;
      addSighting(existing.provenance, sighting);
      return;
    }
    const entry = {
      dedupeKey,
      reason,
      payload: structuredClone(item),
      receivedCount: 1,
      firstReceivedAt: sighting.receivedAt,
      lastReceivedAt: sighting.receivedAt,
      provenance: [],
    };
    addSighting(entry.provenance, sighting);
    voyage.rejected.push(entry);
  }

  // 有效记录投影进业务集合，让业务读取入口看到一致状态；
  // 集合按 sourceId 幂等合并，重复投影不会重复计数。
  async #project(voyage) {
    const records = Object.values(voyage.verified).map((entry) => toCollectionRecord(entry.payload));
    if (records.length > 0) await this.collection.ingest(records);
  }
}
