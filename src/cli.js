import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SourceClient } from './source-client.js';
import { SyncStore } from './sync-store.js';
import { SyncService } from './sync.js';

const here = dirname(fileURLToPath(import.meta.url));
const service = new CollectionService(new RecordRepository(resolve(here, '../var/records.json')));
const commands = ['ingest', 'query', 'sync', 'reconcile'];
const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | sync <来源url> [航次] | reconcile [航次]',
    commands,
  }));
  process.exit(0);
}
if (action === 'ingest') {
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'sync') {
  const url = process.argv[3];
  if (!url) throw new Error('sync requires a source url');
  const voyageId = process.argv[4] ?? 'V-17';
  const sync = new SyncService({
    client: new SourceClient(url),
    store: new SyncStore(resolve(here, '../var/sync-state.json')),
    collection: service,
  });
  console.log(JSON.stringify(await sync.syncVoyage(voyageId), null, 2));
} else if (action === 'reconcile') {
  const voyageId = process.argv[3] ?? 'V-17';
  const sync = new SyncService({ store: new SyncStore(resolve(here, '../var/sync-state.json')) });
  console.log(JSON.stringify(await sync.reconcile(voyageId), null, 2));
} else {
  throw new Error('action must be ingest, query, sync or reconcile');
}
