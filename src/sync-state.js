import { createHash } from 'node:crypto';
import { canonicalPayload } from './verify.js';

// 状态以 voyageId + sequence 为记录身份；deviceTime/receivedAt 都不参与身份判定，
// 因此弱网重传、补传与时钟漂移不会让同一序号被当成新记录。
function emptyState() {
  return { voyages: {} };
}

function ensureVoyage(state, voyageId) {
  if (!state.voyages[voyageId]) {
    state.voyages[voyageId] = { manifest: null, entries: new Map() };
  }
  return state.voyages[voyageId];
}

export function createSyncState() {
  return emptyState();
}

export function toSerializable(state) {
  const voyages = {};
  for (const [voyageId, voyage] of Object.entries(state.voyages)) {
    voyages[voyageId] = {
      manifest: voyage.manifest,
      entries: [...voyage.entries.entries()]
        .sort(([a], [b]) => a - b)
        .map(([sequence, entry]) => [sequence, entry]),
    };
  }
  return { version: 1, voyages };
}

export function fromSerializable(value) {
  if (!value || typeof value !== 'object' || !value.voyages) return emptyState();
  const state = emptyState();
  for (const [voyageId, voyage] of Object.entries(value.voyages)) {
    const target = ensureVoyage(state, voyageId);
    if (voyage.manifest) target.manifest = voyage.manifest;
    for (const [sequence, entry] of voyage.entries ?? []) {
      target.entries.set(Number(sequence), structuredClone(entry));
    }
  }
  return state;
}

function payloadKey(item) {
  return createHash('sha256').update(canonicalPayload(item), 'utf8').digest('hex');
}

function observation(item, receivedAt) {
  return {
    receivedAt,
    deviceTime: item.deviceTime,
    kind: item.kind,
    value: structuredClone(item.value),
    offsetSeconds: Number.isFinite(item.offsetSeconds) ? item.offsetSeconds : null,
    signature: item.signature,
    payloadKey: payloadKey(item),
  };
}

// 处理一条来源观察，返回该观察对状态产生的效果（不按到达时间判定新旧，只看身份与验证结果）。
export function applyItem(state, descriptor, { now = new Date().toISOString() } = {}) {
  const { voyageId, sequence, item, verification } = descriptor;
  const voyage = ensureVoyage(state, voyageId);
  const receivedAt = now;
  let entry = voyage.entries.get(sequence);
  if (!entry) {
    entry = { sequence, status: 'gap', canonical: null, observations: [] };
    voyage.entries.set(sequence, entry);
  }
  const copy = observation(item, receivedAt);
  entry.observations.push(copy);

  if (!verification.ok) {
    entry.invalid = { ...copy, reason: verification.reason };
    if (entry.status === 'verified') return { outcome: 'rejected-replay', sequence };
    entry.status = 'invalid';
    return { outcome: 'rejected', sequence, reason: verification.reason };
  }

  if (entry.status === 'verified') {
    entry.verifiedReplayCount = (entry.verifiedReplayCount ?? 0) + 1;
    if (entry.canonical.payloadKey !== copy.payloadKey) {
      entry.conflict = {
        payloadKey: copy.payloadKey,
        receivedAt,
        deviceTime: copy.deviceTime,
        kind: copy.kind,
        value: copy.value,
        signature: copy.signature,
      };
      return { outcome: 'conflicting-replay', sequence };
    }
    return { outcome: 'replay', sequence };
  }

  // 首次通过验证（可能是补传，也可能此前只收到过无效副本）
  entry.status = 'verified';
  entry.canonical = copy;
  entry.invalid = undefined;
  entry.firstVerifiedAt = receivedAt;
  return { outcome: 'accepted', sequence };
}

export function applyManifest(state, voyageId, manifest, { now = new Date().toISOString() } = {}) {
  const voyage = ensureVoyage(state, voyageId);
  voyage.manifest = {
    voyageId,
    through: manifest.through,
    noRecord: [...new Set(manifest.noRecord ?? [])].sort((a, b) => a - b),
    observedAt: now,
  };
  return voyage.manifest;
}

export function listVoyages(state) {
  return Object.keys(state.voyages).sort();
}

function toRanges(sequences) {
  const sorted = [...sequences].sort((a, b) => a - b);
  const ranges = [];
  for (const value of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && value === last.end + 1) last.end = value;
    else ranges.push({ start: value, end: value });
  }
  return ranges.map((range) => (range.start === range.end
    ? { from: range.start, to: range.start }
    : { from: range.start, to: range.end }));
}

function entryOf(state, voyageId, sequence) {
  return state.voyages[voyageId]?.entries.get(sequence);
}

// 监管核对视图：待补缺口、来源声明无记录区间、验证未通过内容彼此分开；
// 补传或新的 manifest 观察后由同一状态重新推导，判断随之更新。
export function buildReconciliation(state, voyageId) {
  const empty = {
    voyageId,
    manifest: null,
    complete: false,
    gaps: [],
    noRecordRanges: [],
    verificationFailures: [],
    conflictingSequences: [],
    outsideManifest: [],
    rows: [],
    canonicalLogs: [],
  };
  const voyage = state.voyages[voyageId];
  if (!voyage) return empty;

  const manifest = voyage.manifest;
  const through = manifest?.through ?? 0;
  const declaredNoRecord = new Set(manifest?.noRecord ?? []);
  const gaps = [];
  const noRecordConfirmed = [];
  const verificationFailures = [];
  const conflictingSequences = [];
  const outsideManifest = [];
  const rows = [];

  for (const [sequence, entry] of [...voyage.entries.entries()].sort(([a], [b]) => a - b)) {
    const declared = declaredNoRecord.has(sequence);
    const inRange = Boolean(manifest) && sequence <= through;
    if (manifest && sequence > through) outsideManifest.push(sequence);
    if (entry.conflict) conflictingSequences.push(sequence);

    if (entry.status === 'invalid') {
      verificationFailures.push({
        sequence,
        reason: entry.invalid?.reason ?? 'signature-mismatch',
        lastReceivedAt: entry.invalid?.receivedAt ?? null,
        deviceTime: entry.invalid?.deviceTime ?? null,
        signature: entry.invalid?.signature ?? null,
        attempts: entry.observations.length,
        declaredNoRecord: declared,
      });
    }

    const status = entry.status === 'verified'
      ? 'verified'
      : entry.status === 'invalid' ? 'verification-failed' : 'gap';
    rows.push({ sequence, status, declaredNoRecord: declared, inManifestRange: inRange });
  }

  if (manifest) {
    for (let sequence = 1; sequence <= through; sequence += 1) {
      const declared = declaredNoRecord.has(sequence);
      const entry = entryOf(state, voyageId, sequence);
      if (declared) {
        if (entry?.status === 'verified') continue; // 来源后补的有效记录取代无记录声明
        noRecordConfirmed.push(sequence);
      } else if (!entry || entry.status === 'gap') {
        gaps.push(sequence);
      }
    }
  }

  const unresolved = gaps.length > 0 || verificationFailures.length > 0;
  const canonicalLogs = [...voyage.entries.entries()]
    .filter(([, entry]) => entry.status === 'verified')
    .sort(([a], [b]) => a - b)
    .map(([sequence, entry]) => ({
      voyageId,
      sequence,
      kind: entry.canonical.kind,
      deviceTime: entry.canonical.deviceTime,
      offsetSeconds: entry.canonical.offsetSeconds,
      value: structuredClone(entry.canonical.value),
      signature: entry.canonical.signature,
      firstVerifiedAt: entry.firstVerifiedAt,
      lastReceivedAt: entry.canonical.receivedAt,
      replayCount: entry.verifiedReplayCount ?? 0,
      conflict: Boolean(entry.conflict),
      provenance: entry.observations.map((observation) => ({
        receivedAt: observation.receivedAt,
        deviceTime: observation.deviceTime,
        signature: observation.signature,
        payloadKey: observation.payloadKey,
      })),
    }));

  return {
    voyageId,
    manifest: manifest ? {
      through: manifest.through,
      noRecord: manifest.noRecord,
      observedAt: manifest.observedAt,
    } : null,
    complete: Boolean(manifest) && !unresolved,
    gaps: toRanges(gaps),
    noRecordRanges: toRanges(noRecordConfirmed),
    verificationFailures,
    conflictingSequences,
    outsideManifest: toRanges(outsideManifest),
    rows,
    canonicalLogs,
  };
}
