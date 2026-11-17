import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSyncState,
  applyItem,
  applyManifest,
  buildReconciliation,
  toSerializable,
  fromSerializable,
} from '../src/sync-state.js';
import { verifyRecord, expectedSignature } from '../src/verify.js';

let tick = 0;
const clock = () => `2026-11-16T08:0${tick++}:00Z`;

function item(overrides = {}) {
  const built = {
    voyageId: 'V-17',
    sequence: 1,
    kind: 'position',
    deviceTime: '2026-11-16T08:00:00Z',
    offsetSeconds: 80,
    value: { latitude: 10, longitude: 20 },
    ...overrides,
  };
  return { ...built, signature: overrides.signature ?? expectedSignature(built) };
}

function receive(state, raw, options = {}) {
  const verification = options.verification ?? verifyRecord(raw);
  return applyItem(
    state,
    { voyageId: raw.voyageId, sequence: raw.sequence, item: raw, verification },
    { now: options.now ?? clock() },
  );
}

test('首次同步按序号区分已验证记录、无记录区间与待补缺口', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { voyageId: 'V-17', through: 3, noRecord: [2] }, { now: clock() });
  const result = receive(state, item());
  assert.equal(result.outcome, 'accepted');
  const view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.gaps, [{ from: 3, to: 3 }]);
  assert.deepEqual(view.noRecordRanges, [{ from: 2, to: 2 }]);
  assert.equal(view.complete, false);
  assert.equal(view.canonicalLogs.length, 1);
});

test('重放同一有效负载不重复计数且保留每次来路', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 3, noRecord: [2] }, { now: clock() });
  const raw = item();
  assert.equal(receive(state, raw).outcome, 'accepted');
  assert.equal(receive(state, raw, { now: clock() }).outcome, 'replay');
  assert.equal(receive(state, raw, { now: clock() }).outcome, 'replay');
  const view = buildReconciliation(state, 'V-17');
  assert.equal(view.canonicalLogs.length, 1);
  assert.equal(view.canonicalLogs[0].replayCount, 2);
  assert.equal(view.canonicalLogs[0].provenance.length, 3);
});

test('补传后缺口关闭，核对判断随之更新且不按到达时间重排', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 3, noRecord: [2] }, { now: clock() });
  receive(state, item({ sequence: 1, deviceTime: '2026-11-16T08:05:00Z' }));
  const before = buildReconciliation(state, 'V-17');
  assert.deepEqual(before.gaps, [{ from: 3, to: 3 }]);
  // 序号 3 的设备时间早于序号 1（时钟漂移），但仍按序号归位
  receive(state, item({ sequence: 3, kind: 'engine', deviceTime: '2026-11-16T08:00:00Z', value: { rpm: 1100 } }), { now: clock() });
  const after = buildReconciliation(state, 'V-17');
  assert.deepEqual(after.gaps, []);
  assert.equal(after.complete, true);
  assert.deepEqual(after.canonicalLogs.map((log) => log.sequence), [1, 3]);
  assert.equal(after.canonicalLogs[1].deviceTime, '2026-11-16T08:00:00Z');
});

test('未通过验证的内容单独归类，有效补传后转为已验证', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 3, noRecord: [2] }, { now: clock() });
  receive(state, item({ sequence: 3, signature: 'deadbeef'.repeat(8) }), {
    verification: { ok: false, reason: 'signature-mismatch' },
  });
  const failed = buildReconciliation(state, 'V-17');
  assert.deepEqual(failed.verificationFailures.map((entry) => entry.sequence), [3]);
  assert.deepEqual(failed.gaps, [{ from: 1, to: 1 }]);
  assert.equal(failed.complete, false);
  // 失败尝试保留在来路中
  assert.equal(failed.rows.find((row) => row.sequence === 3).status, 'verification-failed');
  receive(state, item({ sequence: 3, kind: 'engine', value: { rpm: 1100 } }), { now: clock() });
  const recovered = buildReconciliation(state, 'V-17');
  assert.deepEqual(recovered.verificationFailures, []);
  const log = recovered.canonicalLogs.find((entry) => entry.sequence === 3);
  assert.equal(log.provenance.length, 2);
  assert.equal(log.firstVerifiedAt, log.provenance[1].receivedAt);
});

test('同序号不同有效负载标记冲突且保留两个版本的来路', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 1, noRecord: [] }, { now: clock() });
  receive(state, item());
  const conflict = receive(state, item({ value: { latitude: 30, longitude: 40 } }), { now: clock() });
  assert.equal(conflict.outcome, 'conflicting-replay');
  const view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.conflictingSequences, [1]);
  assert.equal(view.canonicalLogs[0].conflict, true);
  assert.deepEqual(view.canonicalLogs[0].value, { latitude: 10, longitude: 20 });
  assert.equal(view.canonicalLogs[0].provenance.length, 2);
});

test('manifest 未声明的序号仍属未知缺口，声明无记录的序号不算缺口', () => {
  const state = createSyncState();
  // 没有 manifest 时：任何未验证序号都无法被判定为完整
  assert.equal(buildReconciliation(state, 'V-99').complete, false);
  applyManifest(state, 'V-17', { through: 4, noRecord: [2] }, { now: clock() });
  receive(state, item({ sequence: 1 }));
  receive(state, item({ sequence: 3, kind: 'engine', value: { rpm: 1 } }));
  receive(state, item({ sequence: 4, kind: 'alarm', value: { code: 'X' } }));
  const view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.gaps, []);
  assert.deepEqual(view.noRecordRanges, [{ from: 2, to: 2 }]);
  assert.equal(view.complete, true);
});

test('超过 manifest 范围的记录单独列示且不影响声明区间完整性', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 2, noRecord: [2] }, { now: clock() });
  receive(state, item({ sequence: 1 }));
  receive(state, item({ sequence: 5, kind: 'alarm', value: { code: 'X' } }), { now: clock() });
  const view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.outsideManifest, [{ from: 5, to: 5 }]);
  assert.equal(view.complete, true);
  assert.equal(view.canonicalLogs.length, 2);
});

test('无记录声明后又收到有效记录时以验证通过的记录为准', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 2, noRecord: [2] }, { now: clock() });
  receive(state, item({ sequence: 1 }));
  let view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.noRecordRanges, [{ from: 2, to: 2 }]);
  receive(state, item({ sequence: 2, kind: 'engine', value: { rpm: 700 } }), { now: clock() });
  view = buildReconciliation(state, 'V-17');
  assert.deepEqual(view.noRecordRanges, []);
  assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [1, 2]);
  assert.equal(view.complete, true);
});

test('状态可序列化并在重启后恢复全部核对结论', () => {
  const state = createSyncState();
  applyManifest(state, 'V-17', { through: 3, noRecord: [2] }, { now: clock() });
  receive(state, item());
  receive(state, item({ sequence: 3, signature: 'ab'.repeat(32) }), {
    verification: { ok: false, reason: 'signature-mismatch' },
  });
  const restored = fromSerializable(toSerializable(state));
  assert.deepEqual(buildReconciliation(restored, 'V-17'), buildReconciliation(state, 'V-17'));
});
