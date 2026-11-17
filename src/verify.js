import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SIGNING_KEY = 'local-voyage-key';

// 契约：对 JSON.stringify([voyageId, sequence, kind, deviceTime, value]) 的 UTF-8 字节做 HMAC-SHA256
export function canonicalPayload(item) {
  return JSON.stringify([
    item.voyageId,
    item.sequence,
    item.kind,
    item.deviceTime,
    item.value,
  ]);
}

export function expectedSignature(item, key = DEFAULT_SIGNING_KEY) {
  return createHmac('sha256', key).update(canonicalPayload(item), 'utf8').digest('hex');
}

export function verifyRecord(item, key = DEFAULT_SIGNING_KEY) {
  if (!item || typeof item !== 'object') return { ok: false, reason: 'malformed-item' };
  const { voyageId, sequence, kind, deviceTime, value, signature } = item;
  if (typeof voyageId !== 'string' || voyageId.length === 0) {
    return { ok: false, reason: 'missing-voyage-id' };
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    return { ok: false, reason: 'missing-sequence' };
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    return { ok: false, reason: 'missing-kind' };
  }
  if (typeof deviceTime !== 'string' || Number.isNaN(Date.parse(deviceTime))) {
    return { ok: false, reason: 'missing-device-time' };
  }
  if (value === undefined || value === null) {
    return { ok: false, reason: 'missing-value' };
  }
  if (typeof signature !== 'string' || !/^[0-9a-fA-F]{64}$/.test(signature)) {
    return { ok: false, reason: 'malformed-signature' };
  }
  const actual = Buffer.from(signature, 'hex');
  const expected = Buffer.from(expectedSignature(item, key), 'hex');
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true, reason: null };
}
