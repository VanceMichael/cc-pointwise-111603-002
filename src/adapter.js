export const entryPath = "/voyages/V-17/logs?after=0";

// 来源项目到业务集合记录的唯一映射，首批导入与同步投影共用，
// 保证两条路径对同一条记录得到同一个 sourceId。
export function toCollectionRecord(item) {
  return {
    sourceId: String(item["sequence"]),
    source: "航次记录接收器",
    observedAt: item["deviceTime"],
    label: String(item["kind"]),
    attributes: structuredClone(item),
  };
}

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map(toCollectionRecord) };
}
