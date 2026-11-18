import { reconcileVoyage } from './reconcile.js';

const fields = ["voyageId", "sequence", "deviceTime", "signature"];

// 业务读取入口。传入同步状态仓库时附带各航次的核对视图，
// 监管查询由此分清待补缺口、来源声明无记录的区间与验证未通过的内容。
export async function readOperations(repository, syncStore = null) {
  const records = await repository.read();
  const view = {
    product: "航次记录接收器",
    rows: records.map((record) => ({
      sourceId: record.sourceId,
      source: record.source,
      observedAt: record.observedAt,
      attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
    })),
  };
  if (syncStore) {
    const state = await syncStore.read();
    view.voyages = Object.values(state.voyages).map((voyage) => reconcileVoyage(voyage));
  }
  return view;
}
