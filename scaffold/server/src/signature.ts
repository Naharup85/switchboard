import crypto from 'node:crypto';

// Helper for Pigeon webhook signature verification
export function verifyPigeonSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const parts = signatureHeader.split(',').map((p) => p.trim());
  let tStr: string | undefined;
  let v1: string | undefined;

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx);
    const value = part.slice(eqIdx + 1);
    if (key === 't') tStr = value;
    else if (key === 'v1') v1 = value;
  }

  if (!tStr || !v1) {
    return false;
  }

  if (!/^\d+$/.test(tStr)) {
    return false;
  }

  if (!/^[0-9a-fA-F]{64}$/.test(v1)) {
    return false;
  }

  const t = Number(tStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > 300) {
    return false;
  }

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${tStr}.`);
  hmac.update(rawBody);
  const computedHex = hmac.digest('hex');

  const v1Buf = Buffer.from(v1, 'hex');
  const compBuf = Buffer.from(computedHex, 'hex');

  if (v1Buf.length !== 32 || compBuf.length !== 32) {
    return false;
  }

  return crypto.timingSafeEqual(v1Buf, compBuf);
}
