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
