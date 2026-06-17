import fs from 'node:fs';
import path from 'node:path';
import { redactBundle } from './redact.js';
import { DATA_DIR } from './paths.js';

// Push sink: upload a capture bundle to the hosted VibeRate. The bundle is
// redacted, then sent as the request body unchanged. Ownership is gist-style: the
// first push to a host mints an owner token (returned by the server); we save it
// locally and send it on every later push so all your projects share one owner
// and show up together on the dashboard.
//
// The deployed host. `resolveApi()` falls back to this so push/watch "just work"
// with no config; override it for local dev with VBRT_API_URL=http://localhost:4317.
export const DEFAULT_API = 'https://vbrt.fly.dev';

// Endpoint is configurable so the same client points at local dev or production.
// After `vbrt login`, fall back to the single saved endpoint so `vbrt push` works
// without re-exporting VBRT_API_URL each session.
//
// `apiBase()` reports only an **explicitly chosen** endpoint (env var or a saved
// login) — never the default. `vbrt add` keys its push-vs-save-locally decision on
// this, so a plain `vbrt add` with no config still saves to the local store for
// `vbrt serve` instead of silently uploading to production.
export function apiBase() {
  const env = (process.env.VBRT_API_URL || '').replace(/\/+$/, '');
  if (env) return env;
  const urls = Object.keys(readCreds());
  return urls.length === 1 ? urls[0] : '';
}

// The endpoint commands that *actively upload* (push/watch) should hit: an explicit
// choice if set, else the deployed host. So `vbrt push`/`vbrt watch` need no env var,
// but VBRT_API_URL still points them at a local host for VibeRate's own dev loop.
export function resolveApi() {
  return apiBase() || DEFAULT_API;
}

// `vbrt login <token>`: save an account-bound token (minted from the dashboard's
// "Connect CLI") for an endpoint, so pushes from this machine attach to that account.
export function login(apiUrl, token) {
  const url = (apiUrl || '').replace(/\/+$/, '');
  if (!url) throw new Error('No endpoint. Pass --api <url> or set VBRT_API_URL.');
  if (!token) throw new Error('Missing token.');
  saveToken(url, token);
  return { apiUrl: url, tokenPath: credsPath() };
}

// Owner tokens live in one file keyed by endpoint, so dev and prod don't collide.
const credsPath = () => path.join(DATA_DIR, 'credentials.json');

function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(credsPath(), 'utf8'));
  } catch {
    return {};
  }
}

export function loadToken(apiUrl) {
  return process.env.VBRT_TOKEN || readCreds()[apiUrl] || null;
}

function saveToken(apiUrl, token) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const creds = readCreds();
    creds[apiUrl] = token;
    fs.writeFileSync(credsPath(), JSON.stringify(creds, null, 2));
  } catch {
    /* non-fatal: the push still succeeded; we just couldn't remember the token */
  }
}

export async function pushBundle(bundle, { apiUrl = resolveApi(), token = loadToken(resolveApi()), isPublic = false } = {}) {
  if (!apiUrl) {
    throw new Error(
      'No hosted endpoint configured. Set VBRT_API_URL (e.g. https://vbrt.fly.dev) to push.',
    );
  }
  const safe = redactBundle(bundle); // scrub secrets before leaving the machine
  const res = await fetch(`${apiUrl}/api/projects${isPublic ? '?public=1' : ''}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(safe),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Upload failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  // Expected: { id, url, token? } — token present only on the first push (mint).
  const out = await res.json();
  let newToken = false;
  if (out.token) {
    saveToken(apiUrl, out.token);
    newToken = true;
  }
  const effToken = out.token || token || null;
  return {
    ...out,
    token: effToken,
    newToken,
    dashboardUrl: `${apiUrl}/app`,
    tokenPath: credsPath(),
    linkUrl: effToken ? `${apiUrl}/link#${effToken}` : null,
  };
}
