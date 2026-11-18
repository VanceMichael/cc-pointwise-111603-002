import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SyncStore } from './sync-store.js';
import { SyncService } from './sync.js';
import { readOperations } from './operations.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));
  for (const row of operations.rows) {
    const original = stored.find(record => record.sourceId === row.sourceId);
    assert.equal(row.source, original.source);
    assert.equal(row.observedAt, original.observedAt);
    for (const [field, value] of Object.entries(row.attributes)) assert.deepEqual(value, original.attributes[field] ?? null);
  }

  // 同步接收与核对：弱网重传、验证未通过、补传后判断更新
  const collection = new CollectionService(reopened);
  const syncStore = new SyncStore(join(directory, 'sync-state.json'));
  const sync = new SyncService({ client: new SourceClient(source.url), store: syncStore, collection });

  const initial = await sync.syncVoyage('V-17');
  assert.equal(initial.newVerified, 1, '首批同步只计入通过校验的记录');
  assert.deepEqual(initial.reconciliation.pending, [3], '未收到的序号是待补缺口');
  assert.deepEqual(initial.reconciliation.declaredNoRecord, [2], '来源声明无记录的序号单独成类');
  assert.deepEqual(initial.reconciliation.noRecordIntervals, [{ from: 2, to: 2 }]);

  const replay = await sync.syncVoyage('V-17');
  assert.equal(replay.newVerified, 0, '重传不产生新记录');
  assert.equal(replay.replays, 1, '重传被识别为重放');
  assert.equal((await reopened.read()).length, stored.length, '重放后业务集合不重复计数');

  source.publish('corrupted');
  const corrupted = await sync.syncVoyage('V-17');
  assert.equal(corrupted.newVerified, 0, '签名无效的记录不计入有效日志');
  assert.equal(corrupted.rejected, 1, '签名无效的内容被登记为验证未通过');
  assert.equal(corrupted.reconciliation.sequences['3'], 'rejected', '验证未通过与待补缺口分清');
  assert.equal((await reopened.read()).length, stored.length, '验证未通过的内容不进入业务集合');

  source.publish('updated');
  const supplemented = await sync.syncVoyage('V-17');
  assert.equal(supplemented.newVerified, 1, '补传的有效记录计入有效日志');
  assert.deepEqual(supplemented.reconciliation.pending, [], '补传后待补缺口随之消除');
  assert.equal(supplemented.reconciliation.sequences['3'], 'verified', '补传后序号状态更新为已验证');
  assert.equal(supplemented.reconciliation.rejected.length, 1, '验证未通过的内容保留来路可查');
  assert.equal(supplemented.reconciliation.rejected[0].reason, 'signature-format');
  assert.ok(supplemented.reconciliation.rejected[0].provenance[0].path.includes('/voyages/V-17/logs'));
  assert.equal(supplemented.reconciliation.provenance['1'].receivedCount, 2, '有效记录保留累计接收轨迹');

  const supplementedReplay = await sync.syncVoyage('V-17');
  assert.equal(supplementedReplay.newVerified, 0, '补传批次重放同样不重复计数');
  assert.equal((await reopened.read()).length, stored.length + 1, '业务集合只新增有效记录');

  const restarted = new SyncService({ store: new SyncStore(join(directory, 'sync-state.json')) });
  assert.deepEqual(await restarted.reconcile('V-17'), await sync.reconcile('V-17'), '重启后核对结论一致');

  const withReconciliation = await readOperations(reopened, syncStore);
  assert.equal(withReconciliation.voyages.length, 1, '业务读取入口附带航次核对视图');
  assert.deepEqual(withReconciliation.voyages[0].verified, [1, 3]);
  assert.equal(withReconciliation.rows.length, 2, '业务行只含验证通过的记录');

  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    operationRows: operations.rows.length,
    syncVerified: supplemented.reconciliation.verified,
    syncRejected: supplemented.reconciliation.rejected.length,
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, {recursive: true, force: true});
}
