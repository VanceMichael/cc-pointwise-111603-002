export const entryPath = "/voyages/V-17/logs?after=0";

export function manifestPath(voyageId) {
  return `/voyages/${encodeURIComponent(voyageId)}/manifest`;
}

export function logsPath(voyageId, after = 0) {
  return `/voyages/${encodeURIComponent(voyageId)}/logs?after=${after}`;
}

// 保留原始来源属性，供签名校验与来路追溯使用。
export function parseItems(response) {
  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.items)) throw new Error('source items missing');
  return {
    items: payload.items.map((item) => structuredClone(item)),
    next: payload.next ?? null,
    etag: response.etag ?? null,
  };
}

export function parseManifest(response) {
  const payload = JSON.parse(response.text);
  if (typeof payload.voyageId !== 'string' || !Number.isInteger(payload.through) || payload.through < 0) {
    throw new Error('source manifest malformed');
  }
  const noRecord = payload.noRecord ?? [];
  if (!Array.isArray(noRecord) || noRecord.some((value) => !Number.isInteger(value) || value < 1 || value > payload.through)) {
    throw new Error('source manifest noRecord malformed');
  }
  return {
    voyageId: payload.voyageId,
    through: payload.through,
    noRecord: [...noRecord],
    etag: response.etag ?? null,
  };
}

export function parsePage(response) {
  const { items, next } = parseItems(response);
  return { next, records: items.map((item) => ({
    sourceId: String(item["sequence"]),
    source: "航次记录接收器",
    observedAt: item["deviceTime"],
    label: String(item["kind"]),
    attributes: structuredClone(item),
  })) };
}
