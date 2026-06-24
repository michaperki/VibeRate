import crypto from 'node:crypto';

// Gist-style ownership: a push mints a random secret "owner token" that stands in
// for an account (no email/password in v1). The server stores only the SHA-256
// hash; the raw token lives client-side and is sent as `Authorization: Bearer` to
// scope the project list to its owner. A later "claim your account" flow can bind
// an owner hash to a real identity (e.g. GitHub) without reshaping storage.

export function newToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 url-safe chars
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Pull a bearer token out of an Express request's Authorization header.
export function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// --- signed values + cookies (web sessions + OAuth state), no external deps ---
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-session-secret';

// HMAC-sign a small JSON payload into a `body.sig` string with an expiry.
export function signValue(obj, maxAgeMs) {
  const payload = { ...obj, exp: Date.now() + (maxAgeMs || 0) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyValue(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- symmetric encryption for secrets at rest (e.g. a user's GitHub OAuth token) ---
// AES-256-GCM with a key derived from SESSION_SECRET. We store third-party access
// tokens encrypted on the user record so a leaked data volume doesn't hand out live
// GitHub credentials; the plaintext only exists in memory while we clone/push. Format
// is `iv.tag.ciphertext`, all base64url. Returns null on any tamper/!decrypt.
const ENC_KEY = crypto.createHash('sha256').update(SESSION_SECRET).digest(); // 32 bytes
export function encryptSecret(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}
export function decryptSecret(blob) {
  if (!blob || typeof blob !== 'string' || blob.split('.').length !== 3) return null;
  try {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setCookie(res, name, value, { maxAgeMs } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', 'HttpOnly', 'Secure'];
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; SameSite=Lax; HttpOnly; Secure; Max-Age=0`);
}
