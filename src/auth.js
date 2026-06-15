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
