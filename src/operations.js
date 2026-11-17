import { buildReconciliation } from './sync-state.js';

const fields = ["voyageId", "sequence", "deviceTime", "signature"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "航次记录接收器", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}

// 监管核对入口：基于同步状态重新推导缺口、无记录区间与验证失败内容。
export async function readReconciliation(syncRepository, voyageId) {
  const state = await syncRepository.read();
  return buildReconciliation(state, voyageId);
}
