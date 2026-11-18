import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyRecord, expectedSignature, SIGNING_KEY } from '../src/verify.js';

async function sourceItem(stage, index = 0) {
  const scenario = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
  return structuredClone(scenario.stages[stage].routes['/voyages/V-17/logs?after=0'].body.items[index]);
}

test('valid signatures verify against the contract payload tuple', async () => {
  const item = await sourceItem('opening');
  assert.deepEqual(verifyRecord(item), { ok: true });
  assert.equal(item.signature, expectedSignature(item, SIGNING_KEY));
});

test('malformed, foreign-format and tampered records are rejected with distinct reasons', async () => {
  assert.equal(verifyRecord(null).reason, 'malformed');
  assert.equal(verifyRecord({ voyageId: 'V-17' }).reason, 'malformed');
  const foreign = await sourceItem('corrupted');
  assert.equal(verifyRecord(foreign).reason, 'signature-format');
  const tampered = await sourceItem('opening');
  tampered.value = { latitude: 11, longitude: 20 };
  assert.equal(verifyRecord(tampered).reason, 'signature-mismatch');
  const wrongKey = await sourceItem('opening');
  assert.equal(verifyRecord(wrongKey, 'another-key').reason, 'signature-mismatch');
});
