import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNING_KEY = 'local-voyage-key';

// 签名契约：对 JSON.stringify([voyageId,sequence,kind,deviceTime,value]) 的 UTF-8 字节
// 计算 HMAC-SHA256 十六进制摘要。offsetSeconds、signature 等传输字段不参与签名。
export function signedBytes({ voyageId, sequence, kind, deviceTime, value }) {
  return Buffer.from(JSON.stringify([voyageId, sequence, kind, deviceTime, value]), 'utf8');
}

export function expectedSignature(fields, key = SIGNING_KEY) {
  return createHmac('sha256', key).update(signedBytes(fields)).digest('hex');
}

// 校验一条来源记录。返回 { ok: true } 或 { ok: false, reason }。
// 只有 ok 的记录才允许计入有效日志；其余全部视为验证未通过的内容。
export function verifyRecord(item, key = SIGNING_KEY) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, reason: 'malformed' };
  }
  const { voyageId, sequence, kind, deviceTime, signature } = item;
  if (typeof voyageId !== 'string' || voyageId.length === 0) return { ok: false, reason: 'malformed' };
  if (!Number.isInteger(sequence) || sequence < 1) return { ok: false, reason: 'malformed' };
  if (typeof kind !== 'string' || kind.length === 0) return { ok: false, reason: 'malformed' };
  if (typeof deviceTime !== 'string' || !Number.isFinite(Date.parse(deviceTime))) {
    return { ok: false, reason: 'malformed' };
  }
  if (!Object.hasOwn(item, 'value')) return { ok: false, reason: 'malformed' };
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) {
    return { ok: false, reason: 'signature-format' };
  }
  const expected = expectedSignature({ voyageId, sequence, kind, deviceTime, value: item.value }, key);
  const actual = Buffer.from(signature, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) {
    return { ok: false, reason: 'signature-mismatch' };
  }
  return { ok: true };
}
