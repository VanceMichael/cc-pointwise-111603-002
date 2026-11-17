import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecord, expectedSignature, DEFAULT_SIGNING_KEY } from '../src/verify.js';

const baseItem = {
  voyageId: 'V-17',
  sequence: 1,
  kind: 'position',
  deviceTime: '2026-11-16T08:00:00Z',
  offsetSeconds: 80,
  value: { latitude: 10, longitude: 20 },
};

function signed(item = baseItem, key = DEFAULT_SIGNING_KEY) {
  return { ...item, signature: expectedSignature(item, key) };
}

test('契约规定的 HMAC-SHA256 签名可以通过验证', () => {
  assert.equal(verifyRecord(signed()).ok, true);
});

test('篡改内容后原签名无法通过验证且不计入有效日志', () => {
  const tampered = { ...signed(), value: { latitude: 99, longitude: 20 } };
  const result = verifyRecord(tampered);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature-mismatch');
});

test('非十六进制或长度错误的签名直接判定为格式错误', () => {
  assert.equal(verifyRecord({ ...signed(), signature: 'invalid-signature' }).reason, 'malformed-signature');
});

test('演练密钥之外的签名不予通过', () => {
  const foreign = signed(baseItem, 'other-key');
  assert.equal(verifyRecord(foreign).reason, 'signature-mismatch');
  assert.equal(verifyRecord(foreign, 'other-key').ok, true);
});

test('缺少身份字段或设备时间无法验证', () => {
  assert.equal(verifyRecord({ ...signed(), voyageId: '' }).reason, 'missing-voyage-id');
  assert.equal(verifyRecord({ ...signed(), sequence: 0 }).reason, 'missing-sequence');
  assert.equal(verifyRecord({ ...signed(), sequence: 1.5 }).reason, 'missing-sequence');
  assert.equal(verifyRecord({ ...signed(), deviceTime: 'not-a-date' }).reason, 'missing-device-time');
  assert.equal(verifyRecord({ ...signed(), kind: '' }).reason, 'missing-kind');
});
