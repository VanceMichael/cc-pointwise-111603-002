import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncRepository } from '../src/sync-repository.js';
import { VoyageSyncService } from '../src/sync-service.js';
import { expectedSignature } from '../src/verify.js';

const signed = (overrides) => {
  const item = {
    voyageId: 'V-30',
    sequence: 1,
    kind: 'position',
    deviceTime: '2026-11-16T08:00:00Z',
    value: { latitude: 1 },
    ...overrides,
  };
  return { ...item, signature: expectedSignature(item) };
};

function fakeClient(pages, manifest = { voyageId: 'V-30', through: 2, noRecord: [] }) {
  let pageIndex = 0;
  return {
    async read(path) {
      if (path.endsWith('/manifest')) {
        return { text: JSON.stringify(manifest), etag: null, status: 200 };
      }
      const page = pages[pageIndex++];
      return { text: JSON.stringify(page), etag: null, status: 200 };
    },
  };
}

test('畸形记录被单独计为 malformed 且不影响同批次有效记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voyage-malformed-'));
  try {
    const repository = new SyncRepository(join(directory, 'state.json'));
    const pages = [{
      items: [
        signed({}),
        { voyageId: 'OTHER', sequence: 1, kind: 'x', deviceTime: '2026-11-16T08:00:00Z', value: {}, signature: 'a'.repeat(64) },
        { voyageId: 'V-30', sequence: null, kind: 'x', deviceTime: '2026-11-16T08:00:00Z', value: {} },
      ],
      next: null,
    }];
    const service = new VoyageSyncService(repository, { client: fakeClient(pages) });
    const result = await service.sync('V-30');
    assert.equal(result.counts.accepted, 1);
    assert.equal(result.counts.malformed, 2);
    const view = await service.reconciliation('V-30');
    assert.deepEqual(view.canonicalLogs.map((log) => log.sequence), [1]);
    assert.deepEqual(view.gaps, [{ from: 2, to: 2 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('分页循环和超限被拒绝且不写入状态', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voyage-loop-'));
  try {
    const repository = new SyncRepository(join(directory, 'state.json'));
    const loopingClient = {
      async read(path) {
        if (path.endsWith('/manifest')) {
          return { text: JSON.stringify({ voyageId: 'V-30', through: 1, noRecord: [] }), etag: null, status: 200 };
        }
        return { text: JSON.stringify({ items: [], next: '/voyages/V-30/logs?after=0' }), etag: null, status: 200 };
      },
    };
    const service = new VoyageSyncService(repository, { client: loopingClient });
    await assert.rejects(service.sync('V-30'), /paging loop/);
    assert.deepEqual(await service.voyages(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
