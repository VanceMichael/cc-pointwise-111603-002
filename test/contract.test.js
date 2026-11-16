import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('device source provides verifiable signatures and a distinct invalid observation', async () => {
  const row = (await observe()).records[0].attributes;
  const signed = JSON.stringify([row.voyageId, row.sequence, row.kind, row.deviceTime, row.value]);
  assert.equal(row.signature, createHmac('sha256', 'local-voyage-key').update(signed).digest('hex'));
  const invalid = (await observe('corrupted')).records[0].attributes;
  assert.notEqual(invalid.signature.length, 64);
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    const manifest = await (await fetch(`${source.url}/voyages/V-17/manifest`)).json();
    assert.deepEqual(manifest.noRecord, [2]);
    assert.equal(manifest.through, 3);
  } finally { await source.close(); }
});
