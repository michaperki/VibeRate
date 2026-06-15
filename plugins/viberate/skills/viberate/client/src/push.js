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
// Endpoint is configurable so the same client points at local dev or production.
export function apiBase() {
  return (process.env.VBRT_API_URL || '').replace(/\/+$/, '');
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

export async function pushBundle(bundle, { apiUrl = apiBase(), token = loadToken(apiBase()), isPublic = false } = {}) {
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
  return { ...out, token: out.token || token || null, newToken, dashboardUrl: `${apiUrl}/app`, tokenPath: credsPath() };
}
