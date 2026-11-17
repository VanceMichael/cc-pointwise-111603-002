import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SyncRepository } from './sync-repository.js';
import { VoyageSyncService } from './sync-service.js';
import { readOperations, readReconciliation } from './operations.js';

const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const syncSource = await startSource(new URL('../fixtures/sync-source.json', import.meta.url));
let tick = 0;
const clock = () => `2026-11-16T09:00:${String(tick++).padStart(2, '0')}Z`;
try {
  // 既有本地来源读取、首批导入、重启回读、重放与业务查询
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

  // 船岸同步接收与核对
  const syncPath = join(directory, 'sync-state.json');
  const syncRepository = new SyncRepository(syncPath);
  const sync = new VoyageSyncService(syncRepository, { client: new SourceClient(syncSource.url), clock });

  const opening = await sync.sync('V-20');
  assert.equal(opening.fetchedPages, 2, '分页拉取两页日志');
  assert.equal(opening.counts.accepted, 2);
  assert.deepEqual(opening.gaps, [{ from: 3, to: 3 }], '序号 3 是待补缺口');
  assert.deepEqual(opening.noRecordRanges, [{ from: 2, to: 2 }], '序号 2 是来源声明无记录');
  assert.equal(opening.complete, false);

  const replay = await sync.sync('V-20');
  assert.equal(replay.counts.accepted, 0, '重放不产生新的有效日志');
  assert.equal(replay.counts.replay, 2);
  const replayedView = await readReconciliation(syncRepository, 'V-20');
  assert.equal(replayedView.canonicalLogs.length, 2, '重放不重复计数');
  assert.ok(replayedView.canonicalLogs.every((log) => log.provenance.length === 2), '每次重放都保留来路');

  syncSource.publish('corrupted');
  const corrupted = await sync.sync('V-20');
  assert.equal(corrupted.counts.rejected, 1, '无效签名不计入有效日志');
  const failedView = await readReconciliation(new SyncRepository(syncPath), 'V-20');
  assert.deepEqual(failedView.verificationFailures.map((entry) => entry.sequence), [3]);
  assert.equal(failedView.canonicalLogs.length, 2);

  syncSource.publish('backfill');
  const backfill = await sync.sync('V-20');
  assert.equal(backfill.counts.accepted, 1, '补传后缺口序号通过验证并计入');
  assert.deepEqual(backfill.gaps, []);
  assert.equal(backfill.complete, true);

  const restartedView = await readReconciliation(new SyncRepository(syncPath), 'V-20');
  assert.deepEqual(restartedView.verificationFailures, [], '补传后验证失败判断更新');
  assert.deepEqual(restartedView.canonicalLogs.map((log) => log.sequence), [1, 3, 4], '按原始序号而非到达时间排序');
  const seq3 = restartedView.canonicalLogs.find((log) => log.sequence === 3);
  assert.equal(seq3.deviceTime, '2026-11-16T08:00:00Z');
  assert.equal(seq3.provenance.length, 2, '损坏副本与有效补传的来路都保留');
  assert.deepEqual(await new VoyageSyncService(new SyncRepository(syncPath), { client: null }).voyages(), ['V-20']);

  console.log(JSON.stringify({
    accepted: first.accepted,
    persisted: stored.length,
    replayStored: second.stored,
    operationRows: operations.rows.length,
    sync: {
      opening: opening.counts,
      replay: replay.counts,
      rejected: corrupted.counts.rejected,
      backfill: backfill.counts,
      complete: restartedView.complete,
      canonicalLogs: restartedView.canonicalLogs.length,
    },
    status: 'ok',
  }));
} finally {
  await source.close();
  await syncSource.close();
  await rm(directory, { recursive: true, force: true });
}
