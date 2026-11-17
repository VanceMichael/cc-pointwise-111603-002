import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { SyncRepository } from '../src/sync-repository.js';
import { VoyageSyncService } from '../src/sync-service.js';
import { readReconciliation } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/sync-source.json', import.meta.url);
const v17Path = new URL('../fixtures/source.json', import.meta.url);

let now = 0;
const fakeClock = () => `2026-11-16T09:00:${String(now++).padStart(2, '0')}Z`;

async function harness() {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'voyage-sync-'));
  const repository = new SyncRepository(join(directory, 'sync-state.json'));
  const service = new VoyageSyncService(repository, {
    client: new SourceClient(source.url),
    clock: fakeClock,
  });
  return {
    source,
    directory,
    repository,
    service,
    async close() { await source.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('首次同步分页拉取并区分缺口、无记录区间与有效日志', async () => {
  const h = await harness();
  try {
    const result = await h.service.sync('V-20');
    assert.equal(result.fetchedPages, 2);
    assert.equal(result.counts.accepted, 2);
    assert.deepEqual(result.gaps, [{ from: 3, to: 3 }]);
    assert.deepEqual(result.noRecordRanges, [{ from: 2, to: 2 }]);
    assert.equal(result.complete, false);
    const view = await readReconciliation(h.repository, 'V-20');
    assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [1, 4]);
    assert.ok(view.canonicalLogs.every((log) => log.provenance.length === 1));
  } finally { await h.close(); }
});

test('重复同步是重放：不新增有效日志，来路记录增加', async () => {
  const h = await harness();
  try {
    await h.service.sync('V-20');
    const replay = await h.service.sync('V-20');
    assert.equal(replay.counts.accepted, 0);
    assert.equal(replay.counts.replay, 2);
    const view = await h.service.reconciliation('V-20');
    assert.equal(view.canonicalLogs.length, 2);
    assert.ok(view.canonicalLogs.every((log) => log.replayCount === 1 && log.provenance.length === 2));
  } finally { await h.close(); }
});

test('补传后缺口关闭，先前的重放与来路都保留', async () => {
  const h = await harness();
  try {
    await h.service.sync('V-20');
    h.source.publish('backfill');
    const backfill = await h.service.sync('V-20');
    assert.equal(backfill.counts.accepted, 1);
    assert.equal(backfill.counts.replay, 2);
    assert.deepEqual(backfill.gaps, []);
    assert.equal(backfill.complete, true);
    const view = await h.service.reconciliation('V-20');
    assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [1, 3, 4]);
    const seq3 = view.canonicalLogs.find((log) => log.sequence === 3);
    // 设备时间早于序号 1，排序仍按原始序号
    assert.equal(seq3.deviceTime, '2026-11-16T08:00:00Z');
    assert.equal(seq3.firstVerifiedAt, seq3.provenance[0].receivedAt);
  } finally { await h.close(); }
});

test('损坏观察计入验证失败且不算有效日志，恢复来源后自动转回已验证', async () => {
  const h = await harness();
  try {
    await h.service.sync('V-20');
    h.source.publish('corrupted');
    const corrupted = await h.service.sync('V-20');
    assert.equal(corrupted.counts.rejected, 1);
    const failedView = await h.service.reconciliation('V-20');
    assert.deepEqual(failedView.verificationFailures.map((entry) => entry.sequence), [3]);
    assert.equal(failedView.verificationFailures[0].reason, 'malformed-signature');
    assert.equal(failedView.canonicalLogs.length, 2);
    h.source.publish('backfill');
    const recovered = await h.service.sync('V-20');
    assert.equal(recovered.counts.accepted, 1);
    const view = await h.service.reconciliation('V-20');
    assert.deepEqual(view.verificationFailures, []);
    const seq3 = view.canonicalLogs.find((log) => log.sequence === 3);
    // 失败副本仍保留在来路中，补传后成为该序号的第二条观察
    assert.equal(seq3.provenance.length, 2);
  } finally { await h.close(); }
});

test('同步状态持久化后重启仍给出相同核对结论', async () => {
  const h = await harness();
  try {
    await h.service.sync('V-20');
    const reopenedService = new VoyageSyncService(
      new SyncRepository(join(h.directory, 'sync-state.json')),
      { client: new SourceClient(h.source.url), clock: fakeClock },
    );
    const view = await reopenedService.reconciliation('V-20');
    assert.deepEqual(view.gaps, [{ from: 3, to: 3 }]);
    assert.deepEqual(await reopenedService.voyages(), ['V-20']);
  } finally { await h.close(); }
});

test('来源临时故障时本次同步不落盘，既有状态保持不变', async () => {
  const h = await harness();
  try {
    await h.service.sync('V-20');
    h.source.failNext('/voyages/V-20/logs?after=0', 503);
    await assert.rejects(h.service.sync('V-20'), /503/);
    const view = await h.service.reconciliation('V-20');
    assert.equal(view.canonicalLogs.length, 2);
    assert.deepEqual(view.gaps, [{ from: 3, to: 3 }]);
  } finally { await h.close(); }
});

test('V-17 场景：无效签名观察被拒绝，切换到有效观察后补入', async () => {
  const source = await startSource(v17Path);
  const directory = await mkdtemp(join(tmpdir(), 'voyage-v17-'));
  try {
    const repository = new SyncRepository(join(directory, 'sync.json'));
    const service = new VoyageSyncService(repository, { client: new SourceClient(source.url), clock: fakeClock });
    source.publish('corrupted');
    const failed = await service.sync('V-17');
    assert.equal(failed.counts.rejected, 1);
    let view = await service.reconciliation('V-17');
    assert.deepEqual(view.verificationFailures.map((entry) => entry.sequence), [3]);
    assert.deepEqual(view.gaps, [{ from: 1, to: 1 }]);
    source.publish('updated');
    const recovered = await service.sync('V-17');
    assert.equal(recovered.counts.accepted, 1);
    view = await service.reconciliation('V-17');
    assert.deepEqual(view.verificationFailures, []);
    assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [3]);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
