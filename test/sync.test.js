import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { RecordRepository } from '../src/repository.js';
import { CollectionService } from '../src/service.js';
import { SyncStore } from '../src/sync-store.js';
import { SyncService } from '../src/sync.js';
import { readOperations } from '../src/operations.js';
import { expectedSignature } from '../src/verify.js';

const scenarioPath = new URL('../fixtures/source.json', import.meta.url);

async function setup() {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'sync-test-'));
  const repository = new RecordRepository(join(directory, 'records.json'));
  const collection = new CollectionService(repository);
  const store = new SyncStore(join(directory, 'sync-state.json'));
  const sync = new SyncService({ client: new SourceClient(source.url), store, collection });
  return { source, directory, repository, collection, store, sync };
}

async function cleanup({ source, directory }) {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}

test('sync identifies records by voyage and sequence, verifying before counting', async () => {
  const context = await setup();
  try {
    const summary = await context.sync.syncVoyage('V-17');
    assert.equal(summary.pages, 1);
    assert.equal(summary.received, 1);
    assert.equal(summary.newVerified, 1);
    assert.deepEqual(summary.reconciliation.verified, [1]);
    assert.deepEqual(summary.reconciliation.pending, [3]);
    assert.deepEqual(summary.reconciliation.declaredNoRecord, [2]);
    assert.deepEqual(summary.reconciliation.pendingIntervals, [{ from: 3, to: 3 }]);
    assert.deepEqual(summary.reconciliation.noRecordIntervals, [{ from: 2, to: 2 }]);
    assert.equal(summary.reconciliation.sequences['2'], 'no-record');
    // 有效记录投影进业务集合，业务读取入口看到一致状态
    const view = await readOperations(context.repository, context.store);
    assert.deepEqual(view.rows.map((row) => row.attributes.sequence), [1]);
    assert.equal(view.voyages.length, 1);
  } finally { await cleanup(context); }
});

test('replays do not double count and arrival time creates no new records', async () => {
  const context = await setup();
  try {
    await context.sync.syncVoyage('V-17');
    const before = await context.repository.read();
    const replay = await context.sync.syncVoyage('V-17');
    assert.equal(replay.received, 1);
    assert.equal(replay.newVerified, 0);
    assert.equal(replay.replays, 1);
    assert.deepEqual(await context.repository.read(), before, '业务集合不因重放变化');
    const reconciliation = await context.sync.reconcile('V-17');
    assert.equal(reconciliation.provenance['1'].receivedCount, 2, '同一副本只累计接收次数');
    assert.equal(reconciliation.provenance['1'].sightings.length, 1, '同一来源来路归并');
    assert.equal(reconciliation.provenance['1'].sightings[0].count, 2);
    assert.equal(reconciliation.provenance['1'].sightings[0].etag, '"opening"');
  } finally { await cleanup(context); }
});

test('failed verification stays out of valid logs until a valid copy arrives', async () => {
  const context = await setup();
  try {
    context.source.publish('corrupted');
    const first = await context.sync.syncVoyage('V-17');
    assert.equal(first.newVerified, 0);
    assert.equal(first.rejected, 1);
    assert.equal(first.reconciliation.sequences['3'], 'rejected');
    assert.deepEqual(first.reconciliation.pending, [1], '验证未通过的序号不算待补缺口，单独成类');
    assert.equal((await context.repository.read()).length, 0, '验证未通过的内容不进入业务验证日志');
    assert.equal(first.reconciliation.rejected[0].reason, 'signature-format');
    assert.equal(first.reconciliation.rejected[0].sequence, 3);

    context.source.publish('updated');
    const supplemented = await context.sync.syncVoyage('V-17');
    assert.equal(supplemented.newVerified, 1, '补传的有效副本计入有效日志');
    assert.equal(supplemented.reconciliation.sequences['3'], 'verified', '核对判断随补传更新');
    assert.equal(supplemented.reconciliation.rejected.length, 1, '验证未通过的内容保留来路');
    assert.deepEqual((await context.repository.read()).map((row) => row.sourceId), ['3']);
  } finally { await cleanup(context); }
});

test('a later conflicting copy cannot replace the verified record by arrival time', async () => {
  const context = await setup();
  try {
    await context.sync.syncVoyage('V-17');
    context.source.publish('revised');
    const summary = await context.sync.syncVoyage('V-17');
    assert.equal(summary.newVerified, 0);
    assert.equal(summary.conflicts, 1, '同一序号的不同有效内容登记为冲突');
    const reconciliation = await context.sync.reconcile('V-17');
    assert.equal(reconciliation.sequences['1'], 'verified');
    assert.equal(reconciliation.conflicts.length, 1);
    assert.equal(reconciliation.conflicts[0].kept.value.latitude, 10, '保留首次验证通过的记录');
    assert.equal(reconciliation.conflicts[0].incoming.value.latitude, 10.5, '分歧副本留痕');
    const rows = await context.repository.read();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observedAt, '2026-11-16T08:00:00Z', '业务集合不被后到的副本改写');
    assert.equal(rows[0].attributes.value.latitude, 10);
  } finally { await cleanup(context); }
});

test('sync follows pagination and persists state across restarts', async () => {
  const context = await setup();
  try {
    context.source.publish('paged');
    const summary = await context.sync.syncVoyage('V-17');
    assert.equal(summary.pages, 2, '跟随 next 拉取后续分页');
    assert.deepEqual(summary.reconciliation.verified, [1, 3]);
    assert.deepEqual(summary.reconciliation.pending, []);
    const restarted = new SyncService({ store: new SyncStore(join(context.directory, 'sync-state.json')) });
    assert.deepEqual(await restarted.reconcile('V-17'), await context.sync.reconcile('V-17'));
  } finally { await cleanup(context); }
});

test('a failed sync leaves the previous state untouched', async () => {
  const context = await setup();
  try {
    await context.sync.syncVoyage('V-17');
    const before = await context.store.read();
    context.source.failNext('/voyages/V-17/logs?after=0', 503);
    await assert.rejects(context.sync.syncVoyage('V-17'), /503/);
    assert.deepEqual(await context.store.read(), before, '同步失败不改动已落盘状态');
    const retry = await context.sync.syncVoyage('V-17');
    assert.equal(retry.replays, 1, '恢复后重试按重放处理');
  } finally { await cleanup(context); }
});

test('items from another voyage or malformed items are rejected, not stored as valid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sync-test-'));
  try {
    const foreign = { voyageId: 'V-99', sequence: 1, kind: 'position', deviceTime: '2026-11-16T08:00:00Z', value: {} };
    foreign.signature = expectedSignature(foreign);
    const page = {
      items: [
        foreign,
        { voyageId: 'V-17', sequence: 'not-a-number', kind: 'position', deviceTime: '2026-11-16T08:00:00Z', value: {}, signature: '0'.repeat(64) },
      ],
      next: null,
    };
    const client = {
      async read(path) {
        if (path.includes('manifest')) return { text: JSON.stringify({ voyageId: 'V-17', through: 2, noRecord: [] }), etag: null };
        return { text: JSON.stringify(page), etag: '"stub"' };
      },
    };
    const store = new SyncStore(join(directory, 'sync-state.json'));
    const sync = new SyncService({ client, store });
    const summary = await sync.syncVoyage('V-17');
    assert.equal(summary.newVerified, 0);
    assert.equal(summary.rejected, 2);
    const reconciliation = await sync.reconcile('V-17');
    assert.deepEqual(reconciliation.rejected.map((entry) => entry.reason).sort(), ['malformed', 'voyage-mismatch']);
    assert.deepEqual(reconciliation.pending, [1, 2], '无法验证的内容不填补缺口');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
