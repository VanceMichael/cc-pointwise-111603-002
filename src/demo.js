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

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const syncSource = await startSource(new URL('../fixtures/sync-source.json', import.meta.url));
let tick = 0;
const clock = () => `2026-11-16T09:00:${String(tick++).padStart(2, '0')}Z`;
try {
  // 既有首批导入与业务查询保持不变
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  const repository = new RecordRepository(join(directory, 'records.json'));
  await new CollectionService(repository).ingest(page.records);
  console.log('首批业务查询：');
  console.log(JSON.stringify(await readOperations(repository), null, 2));

  // 船岸同步接收与核对
  const syncRepository = new SyncRepository(join(directory, 'sync-state.json'));
  const sync = new VoyageSyncService(syncRepository, { client: new SourceClient(syncSource.url), clock });

  const opening = await sync.sync('V-20');
  console.log('首次同步（缺口 3，序号 2 声明无记录）：');
  console.log(JSON.stringify({ counts: opening.counts, gaps: opening.gaps, noRecordRanges: opening.noRecordRanges }, null, 2));

  const replay = await sync.sync('V-20');
  console.log('弱网重传后再同步（不重复计数）：');
  console.log(JSON.stringify({ counts: replay.counts }, null, 2));

  syncSource.publish('corrupted');
  const corrupted = await sync.sync('V-20');
  console.log('收到损坏副本（验证未通过，单独列示）：');
  console.log(JSON.stringify({ counts: corrupted.counts, failures: corrupted.verificationFailures }, null, 2));

  syncSource.publish('backfill');
  const backfill = await sync.sync('V-20');
  console.log('补传后同步（缺口关闭，核对更新为完整）：');
  console.log(JSON.stringify({ counts: backfill.counts, gaps: backfill.gaps, complete: backfill.complete }, null, 2));

  const view = await readReconciliation(syncRepository, 'V-20');
  console.log('监管核对视图（含每个序号的来路）：');
  console.log(JSON.stringify({
    complete: view.complete,
    noRecordRanges: view.noRecordRanges,
    canonicalLogs: view.canonicalLogs.map((log) => ({
      sequence: log.sequence,
      deviceTime: log.deviceTime,
      replayCount: log.replayCount,
      provenanceCount: log.provenance.length,
    })),
  }, null, 2));
} finally {
  await source.close();
  await syncSource.close();
  await rm(directory, { recursive: true, force: true });
}
