export const entryPath = "/voyages/V-17/logs?after=0";

export function parsePage(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  const items = payload.items;
  const next = payload.next ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["sequence"]),
    source: "航次记录接收器",
    observedAt: item["deviceTime"],
    label: String(item["kind"]),
    attributes: structuredClone(item),
  })) };
}
