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
