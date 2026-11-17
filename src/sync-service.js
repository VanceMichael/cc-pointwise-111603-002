import { parseItems, parseManifest, logsPath, manifestPath } from './adapter.js';
import { verifyRecord, DEFAULT_SIGNING_KEY } from './verify.js';
import {
  applyItem,
  applyManifest,
  buildReconciliation,
  listVoyages,
} from './sync-state.js';

const MAX_PAGES = 100;

// 同步接收与核对服务：
// - 按 voyageId + sequence 识别记录，先验证 HMAC 签名再计入有效日志；
// - 重放/补传不产生新身份，旧副本保留在来路中，不按到达时间当作新记录；
// - manifest 声明的无记录区间与未知缺口、验证失败分开维护。
export class VoyageSyncService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.client = options.client;
    this.signingKey = options.signingKey ?? DEFAULT_SIGNING_KEY;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async fetchManifest(voyageId) {
    const response = await this.client.read(manifestPath(voyageId));
    return parseManifest(response);
  }

  async fetchLogPages(voyageId) {
    const pages = [];
    let path = logsPath(voyageId, 0);
    const seen = new Set();
    while (path) {
      if (seen.has(path)) throw new Error(`source paging loop at ${path}`);
      seen.add(path);
      if (pages.length >= MAX_PAGES) throw new Error('source paging exceeded page limit');
      const response = await this.client.read(path);
      const page = parseItems(response);
      pages.push(page);
      path = page.next;
    }
    return pages;
  }

  // 一次同步：先完整拉取 manifest 与全部日志页，再统一落盘；拉取失败不破坏既有状态。
  async sync(voyageId) {
    if (!voyageId || typeof voyageId !== 'string') throw new TypeError('voyageId required');
    const manifest = await this.fetchManifest(voyageId);
    const pages = await this.fetchLogPages(voyageId);

    const state = await this.repository.read();
    const now = this.clock();
    applyManifest(state, voyageId, manifest, { now });

    const counts = { accepted: 0, replay: 0, rejected: 0, rejectedReplay: 0, conflictingReplay: 0, malformed: 0 };
    const outcomes = [];
    for (const page of pages) {
      for (const item of page.items) {
        if (item?.voyageId !== voyageId || !Number.isInteger(item.sequence) || item.sequence < 1) {
          counts.malformed += 1;
          outcomes.push({ sequence: item?.sequence ?? null, outcome: 'malformed' });
          continue;
        }
        const verification = verifyRecord(item, this.signingKey);
        const outcome = applyItem(
          state,
          { voyageId, sequence: item.sequence, item, verification },
          { now: this.clock() },
        );
        counts[outcome.outcome] = (counts[outcome.outcome] ?? 0) + 1;
        outcomes.push({ sequence: item.sequence, outcome: outcome.outcome, reason: outcome.reason ?? null });
      }
    }

    await this.repository.write(state);
    const reconciliation = buildReconciliation(state, voyageId);
    return {
      voyageId,
      fetchedPages: pages.length,
      fetchedItems: pages.reduce((total, page) => total + page.items.length, 0),
      counts,
      outcomes,
      complete: reconciliation.complete,
      gaps: reconciliation.gaps,
      noRecordRanges: reconciliation.noRecordRanges,
      verificationFailures: reconciliation.verificationFailures,
    };
  }

  async reconciliation(voyageId) {
    const state = await this.repository.read();
    return buildReconciliation(state, voyageId);
  }

  async voyages() {
    const state = await this.repository.read();
    return listVoyages(state);
  }
}
