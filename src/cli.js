import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { SyncRepository } from './sync-repository.js';
import { VoyageSyncService } from './sync-service.js';
import { SourceClient } from './source-client.js';
import { readReconciliation } from './operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const statePath = process.env.VOYAGE_STATE_PATH ?? resolve(here, '../var/sync-state.json');
const recordsPath = process.env.VOYAGE_RECORDS_PATH ?? resolve(here, '../var/records.json');
const sourceUrl = process.env.VOYAGE_SOURCE_URL;
const signingKey = process.env.VOYAGE_SIGNING_KEY;

const action = process.argv[2] ?? '--help';
if (action === '--help' || action === '-h') {
  console.log(JSON.stringify({
    usage: 'npm start -- ingest [文件] | query [来源] | sync <航次> [来源URL] | status <航次> | voyages',
    commands: ['ingest', 'query', 'sync', 'status', 'voyages'],
    env: ['VOYAGE_STATE_PATH', 'VOYAGE_RECORDS_PATH', 'VOYAGE_SOURCE_URL', 'VOYAGE_SIGNING_KEY'],
  }));
  process.exit(0);
}

if (action === 'ingest') {
  const service = new CollectionService(new RecordRepository(recordsPath));
  const records = JSON.parse(await readFile(process.argv[3] ?? resolve(here, '../fixtures/records.json'), 'utf8'));
  console.log(JSON.stringify(await service.ingest(records), null, 2));
} else if (action === 'query') {
  const service = new CollectionService(new RecordRepository(recordsPath));
  console.log(JSON.stringify(await service.query({ source: process.argv[3] }), null, 2));
} else if (action === 'sync') {
  const voyageId = process.argv[3];
  if (!voyageId) throw new Error('sync requires a voyageId');
  const url = process.argv[4] ?? sourceUrl;
  if (!url) throw new Error('sync requires a source URL argument or VOYAGE_SOURCE_URL');
  const service = new VoyageSyncService(new SyncRepository(statePath), {
    client: new SourceClient(url),
    ...(signingKey ? { signingKey } : {}),
  });
  console.log(JSON.stringify(await service.sync(voyageId), null, 2));
} else if (action === 'status') {
  const voyageId = process.argv[3];
  if (!voyageId) throw new Error('status requires a voyageId');
  console.log(JSON.stringify(await readReconciliation(new SyncRepository(statePath), voyageId), null, 2));
} else if (action === 'voyages') {
  const service = new VoyageSyncService(new SyncRepository(statePath), { client: null });
  console.log(JSON.stringify(await service.voyages(), null, 2));
} else {
  throw new Error('action must be ingest, query, sync, status or voyages');
}
