// 核对（reconcile）是作用在同步状态上的纯函数：每次补传、重传后重新计算，
// 判断跟着最新状态走，不依赖到达时间或批次大小。

// 把升序序号列表压缩成区间，便于监管阅读“声明无记录的区间”和“待补的缺口”。
export function toIntervals(sequences) {
  const intervals = [];
  for (const sequence of [...sequences].sort((left, right) => left - right)) {
    const last = intervals[intervals.length - 1];
    if (last && sequence === last.to + 1) last.to = sequence;
    else intervals.push({ from: sequence, to: sequence });
  }
  return intervals;
}

// 单个航次的核对视图。序号状态互斥，优先级：
//   verified   已有通过签名校验的有效记录
//   no-record  来源 manifest 明确声明该序号无记录（且没有有效记录）
//   rejected   收到过内容但验证未通过（且没有有效记录）
//   pending    待补的缺口：声明范围内既无有效记录、来源也未声明无记录
export function reconcileVoyage(voyage) {
  const through = voyage.manifest?.through ?? 0;
  const declared = new Set(voyage.manifest?.noRecord ?? []);
  const verifiedSequences = Object.keys(voyage.verified ?? {}).map(Number).sort((a, b) => a - b);
  const verifiedSet = new Set(verifiedSequences);
  const rejectedBySequence = new Map();
  for (const entry of voyage.rejected ?? []) {
    // 只有本航次的被拒内容参与逐序号状态；外航次或无法识别序号的内容
    // 仍保留在下方的 rejected 清单中，但不影响本航次的缺口判断。
    if (entry.payload?.voyageId !== voyage.voyageId) continue;
    const sequence = entry.payload?.sequence;
    if (!Number.isInteger(sequence)) continue;
    if (!rejectedBySequence.has(sequence)) rejectedBySequence.set(sequence, []);
    rejectedBySequence.get(sequence).push(entry);
  }
  const sequences = {};
  for (let sequence = 1; sequence <= through; sequence += 1) {
    if (verifiedSet.has(sequence)) sequences[sequence] = 'verified';
    else if (declared.has(sequence)) sequences[sequence] = 'no-record';
    else if (rejectedBySequence.has(sequence)) sequences[sequence] = 'rejected';
    else sequences[sequence] = 'pending';
  }
  // 已验证但超出 manifest 声明视野的序号同样列出，不做缺口判断。
  for (const sequence of verifiedSequences) {
    if (sequence > through) sequences[sequence] = 'verified';
  }
  const pending = [];
  const declaredNoRecord = [];
  for (let sequence = 1; sequence <= through; sequence += 1) {
    if (sequences[sequence] === 'pending') pending.push(sequence);
    if (sequences[sequence] === 'no-record') declaredNoRecord.push(sequence);
  }
  const provenance = {};
  for (const [sequence, entry] of Object.entries(voyage.verified ?? {})) {
    provenance[sequence] = {
      receivedCount: entry.receivedCount,
      firstReceivedAt: entry.firstReceivedAt,
      lastReceivedAt: entry.lastReceivedAt,
      sightings: entry.provenance,
    };
  }
  return {
    voyageId: voyage.voyageId,
    through,
    sequences,
    verified: verifiedSequences,
    pending,
    pendingIntervals: toIntervals(pending),
    declaredNoRecord,
    noRecordIntervals: toIntervals(declaredNoRecord),
    rejected: (voyage.rejected ?? []).map((entry) => ({
      sequence: Number.isInteger(entry.payload?.sequence) ? entry.payload.sequence : null,
      reason: entry.reason,
      receivedCount: entry.receivedCount,
      firstReceivedAt: entry.firstReceivedAt,
      lastReceivedAt: entry.lastReceivedAt,
      provenance: entry.provenance,
      payload: entry.payload,
    })),
    conflicts: (voyage.conflicts ?? []).map((entry) => structuredClone(entry)),
    provenance,
    manifest: voyage.manifest ?? null,
    manifestHistory: voyage.manifestHistory ?? [],
    lastSyncAt: voyage.lastSyncAt ?? null,
  };
}
