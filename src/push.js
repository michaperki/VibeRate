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

// Outbox: a redacted bundle is written here *before* we attempt the upload and
// removed on success — so a 429, a network blip, or a crash mid-push never loses the
// captured work. `vbrt push --retry` drains it. (Watch deltas opt out: they're
// ephemeral, the next tick re-sends current state.)
const outboxDir = () => path.join(DATA_DIR, 'outbox');

function queueBundle(safe, apiUrl, isPublic) {
  try {
    fs.mkdirSync(outboxDir(), { recursive: true });
    const slug = (safe.project && safe.project.slug) || 'project';
    const file = path.join(outboxDir(), `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
    fs.writeFileSync(file, JSON.stringify({ apiUrl, isPublic, bundle: safe }));
    return file;
  } catch {
    return null; // best-effort; upload still proceeds
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST a project, retrying on 429 / 5xx with exponential backoff. Honors a numeric
// `Retry-After` (seconds) when the server sends one. Returns the final Response;
// the caller decides what a non-ok terminal status means.
async function postProject(target, body, { token, isPublic = false, retries = 3 } = {}) {
  const url = `${target}/api/projects${isPublic ? '?public=1' : ''}`;
  const headers = {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body });
    } catch (err) {
      if (attempt >= retries) throw err; // network error — let it propagate (bundle is queued)
      await sleep(Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250);
      attempt++;
      continue;
    }
    if (res.ok) return res;
    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable || attempt >= retries) return res;
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30000, 500 * 2 ** attempt) + Math.random() * 250;
    await sleep(wait);
    attempt++;
  }
}

export async function pushBundle(bundle, { apiUrl = resolveApi(), token = loadToken(apiUrl), isPublic = false, queue = true, retries = 3 } = {}) {
  if (!apiUrl) {
    throw new Error(
      'No hosted endpoint configured. Set VBRT_API_URL (e.g. https://vbrt.fly.dev) to push.',
    );
  }
  const safe = redactBundle(bundle); // scrub secrets before leaving the machine
  // Persist first (unless a caller opts out, e.g. watch deltas); remove on success
  // so a 429/network failure leaves a resendable copy in the outbox.
  const queuedAt = queue ? queueBundle(safe, apiUrl, isPublic) : null;

  let res;
  try {
    res = await postProject(apiUrl, JSON.stringify(safe), { token, isPublic, retries });
  } catch (err) {
    err.queuedAt = queuedAt; // network error after retries — bundle is safe in the outbox
    throw err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const e = new Error(`Upload failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
    e.status = res.status;
    e.queuedAt = queuedAt;
    throw e;
  }
  if (queuedAt) { try { fs.unlinkSync(queuedAt); } catch { /* already gone */ } }
  // Expected: { id, url, token? } — token present only on the first push (mint).
  const out = await res.json();
  let newToken = false;
  if (out.token) {
    saveToken(apiUrl, out.token);
    newToken = true;
  }
  const effToken = out.token || token || null;
  // A self-view link the pusher can open immediately, even on a private project —
  // the `#v=` fragment is redeemed client-side into a short-lived view cookie.
  const viewUrl = out.view ? `${out.url}#v=${out.view}` : out.url;
  return {
    ...out,
    token: effToken,
    newToken,
    viewUrl,
    dashboardUrl: `${apiUrl}/app`,
    tokenPath: credsPath(),
    linkUrl: effToken ? `${apiUrl}/link#${effToken}` : null,
  };
}

// Remember the project a repo pushes to, so `vbrt publish` / `vbrt status` know the
// share URL + current visibility without a network round-trip or a re-upload. Lives
// in the (gitignored) sidecar next to evidence.
const projectRefPath = (cwd) => path.join(cwd, '.vbrt', 'project.json');

function ensureVbrtIgnored(cwd) {
  try {
    const gi = path.join(cwd, '.gitignore');
    const body = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (/^\.vbrt\/?\s*$/m.test(body)) return;
    const prefix = body && !body.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(gi, `${prefix}# VibeRate runtime state (project ref, evidence, watch lock)\n.vbrt/\n`);
  } catch { /* best-effort */ }
}

export function saveProjectRef(cwd, ref) {
  try {
    ensureVbrtIgnored(cwd);
    fs.mkdirSync(path.join(cwd, '.vbrt'), { recursive: true });
    const prev = loadProjectRef(cwd) || {};
    fs.writeFileSync(projectRefPath(cwd), JSON.stringify({ ...prev, ...ref }, null, 2));
  } catch { /* best-effort */ }
}

export function loadProjectRef(cwd) {
  try {
    return JSON.parse(fs.readFileSync(projectRefPath(cwd), 'utf8'));
  } catch {
    return null;
  }
}

// Flip an already-uploaded project's visibility without re-sending the bundle — the
// fix for "push private, realize, re-push --public". Uses the saved project ref +
// owner token against the existing visibility endpoint.
export async function publishProject(cwd, { visibility = 'public', apiUrl } = {}) {
  const ref = loadProjectRef(cwd);
  if (!ref || !ref.id) {
    throw new Error('No published project for this repo yet — run `vbrt push --all` first.');
  }
  const target = apiUrl || ref.apiUrl || resolveApi();
  const token = loadToken(target);
  const res = await fetch(`${target}/api/projects/${ref.id}/visibility`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ visibility }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Publish failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
  }
  const out = await res.json();
  saveProjectRef(cwd, { visibility: out.visibility });
  return { ...out, url: ref.url || `${target}/p/${ref.id}` };
}

// How many bundles are sitting in the outbox waiting to be resent.
export function outboxCount() {
  try {
    return fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// Resend every queued bundle (already redacted at queue time — don't re-redact).
// Removes each file on a successful send; leaves the rest for the next `--retry`.
export async function flushOutbox({ apiUrl = resolveApi() } = {}) {
  let files;
  try {
    files = fs.readdirSync(outboxDir()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { sent: 0, failed: 0, results: [] };
  }
  const results = [];
  for (const f of files) {
    const full = path.join(outboxDir(), f);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      try { fs.unlinkSync(full); } catch { /* corrupt — drop it */ }
      continue;
    }
    const target = payload.apiUrl || apiUrl;
    const token = loadToken(target);
    try {
      const res = await postProject(target, JSON.stringify(payload.bundle), { token, isPublic: payload.isPublic, retries: 2 });
      if (res.ok) {
        const out = await res.json().catch(() => ({}));
        if (out.token) saveToken(target, out.token);
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        results.push({ file: f, ok: true, url: out.url || `${target}/p/${out.id || ''}` });
      } else {
        results.push({ file: f, ok: false, status: res.status });
      }
    } catch (err) {
      results.push({ file: f, ok: false, error: err.message });
    }
  }
  return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}
