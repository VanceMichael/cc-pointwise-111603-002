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
const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
try {
  const client = new SourceClient(source.url);
  const repository = new RecordRepository(join(directory, 'records.json'));
  const collection = new CollectionService(repository);
  const page = parsePage(await client.read(entryPath));
  await collection.ingest(page.records);

  const sync = new SyncService({ client, store: new SyncStore(join(directory, 'sync-state.json')), collection });
  const firstSync = await sync.syncVoyage('V-17');
  source.publish('updated');
  const secondSync = await sync.syncVoyage('V-17');
  const operations = await readOperations(repository, sync.store);
  console.log(JSON.stringify({
    firstSync: { newVerified: firstSync.newVerified, pending: firstSync.reconciliation.pending },
    secondSync: { newVerified: secondSync.newVerified, replays: secondSync.replays, pending: secondSync.reconciliation.pending },
    operations,
  }, null, 2));
} finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
