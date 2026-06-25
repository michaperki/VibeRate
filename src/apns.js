// APNs push — "your agent needs you / finished / errored" (PLAN_NATIVE_REWRITE.md).
//
// The native app's reason to exist over the web view: a Drive turn runs for minutes,
// then often *blocks on you* (the MCP `ask` picker). Without push you'd have to keep
// the app open and watch. This module fans a notification to the registered iOS
// devices when the agent asks a question, finishes a turn, or errors — so steering an
// async agent doesn't mean babysitting it. It's also the App Store 4.2 anchor (a
// native-only capability the web client can't offer).
//
// Zero third-party deps, matching the repo's lean footprint: the APNs provider JWT is
// an ES256 token signed with Node's built-in `crypto`, and the push itself is an
// HTTP/2 POST via the built-in `http2`. Config comes from env (a `.p8` auth key, the
// key id, the team id) — absent any of them, push is simply disabled and every call
// here no-ops, so a box without APNs secrets runs exactly as before.

import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.viberate.app';
const KEY_ID = process.env.APNS_KEY_ID || '';
const TEAM_ID = process.env.APNS_TEAM_ID || '';
// TestFlight + App Store builds talk to the PRODUCTION APNs host; only a build signed
// with a *development* aps-environment (Xcode run) uses the sandbox. We ship via
// TestFlight, so default to production; override with APNS_HOST for a dev build.
const APNS_HOST = process.env.APNS_HOST || 'https://api.push.apple.com';

// The .p8 private key, as PEM. The secret may arrive as real PEM (with newlines),
// PEM with literal "\n" escapes (common when pasted into a Fly secret), or base64 of
// the PEM — accept all three so setting the secret can't silently produce a key that
// won't parse.
function loadKeyPem() {
  let raw = process.env.APNS_KEY_P8 || '';
  if (!raw) return '';
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded.replace(/\\n/g, '\n');
  } catch { /* fall through */ }
  return raw.replace(/\\n/g, '\n');
}

// All three identifiers + a parseable key are required, or push is off.
export function pushEnabled() {
  if (!KEY_ID || !TEAM_ID) return false;
  try {
    return !!privateKey();
  } catch {
    return false;
  }
}

let _key = null;
function privateKey() {
  if (_key) return _key;
  const pem = loadKeyPem();
  if (!pem) throw new Error('APNS_KEY_P8 not set');
  _key = crypto.createPrivateKey(pem);
  return _key;
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The provider JWT (ES256). Apple rejects a token older than ~1h and throttles
// frequent re-minting, so cache it and refresh well inside the window.
let _jwt = null;
let _jwtAt = 0;
function providerToken() {
  const ageMs = Date.now() - _jwtAt;
  if (_jwt && ageMs < 45 * 60 * 1000) return _jwt;
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: KEY_ID }));
  const claims = b64url(JSON.stringify({ iss: TEAM_ID, iat }));
  const signingInput = `${header}.${claims}`;
  // EC signatures from crypto.sign default to DER; APNs/JOSE want raw r||s — that's
  // what `ieee-p1363` produces. (Getting this wrong yields a 403 InvalidProviderToken.)
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
  _jwt = `${signingInput}.${b64url(sig)}`;
  _jwtAt = Date.now();
  return _jwt;
}

// --- Device-token store (persisted to the data volume so it survives a redeploy) ---

const devicesPath = () => path.join(DATA_DIR, 'push-devices.json');

function readDevices() {
  try {
    const arr = JSON.parse(fs.readFileSync(devicesPath(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeDevices(list) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(devicesPath(), JSON.stringify(list, null, 2));
  } catch { /* best-effort; a lost registration just means no push until re-register */ }
}

// Upsert a device by its APNs token. `owner` is the admin email the registering
// request resolved to — kept so a future multi-user instance can fan out per-owner;
// today everything is the single operator, so notifyAll ignores it.
export function registerDevice({ token, owner = null, platform = 'ios', env = null }) {
  if (!token) return;
  const list = readDevices();
  const existing = list.find((d) => d.token === token);
  if (existing) {
    existing.owner = owner;
    existing.platform = platform;
    existing.env = env;
    existing.updatedAt = Date.now();
  } else {
    list.push({ token, owner, platform, env, updatedAt: Date.now() });
  }
  writeDevices(list);
}

export function unregisterDevice(token) {
  if (!token) return;
  writeDevices(readDevices().filter((d) => d.token !== token));
}

function pruneDevice(token) {
  unregisterDevice(token);
}

// --- Sending ---

// Build the APNs payload from our internal notification shape. Keeps custom routing
// data under `vbrt` (sessionId/askId/questions) so a tapped notification can deep-link
// to the right Drive session and render the selector even before the stream connects.
function buildPayload(n) {
  const aps = {
    alert: { title: n.title || 'VibeRate', body: n.body || '' },
    sound: 'default',
    'thread-id': n.sessionId || 'vbrt',
  };
  // An `ask` is blocking the agent on you — mark it time-sensitive so it can break
  // through Focus, and tag a category the app registers actionable buttons against.
  if (n.kind === 'ask') {
    aps.category = 'AGENT_ASK';
    aps['interruption-level'] = 'time-sensitive';
  }
  const vbrt = {
    kind: n.kind,
    sessionId: n.sessionId || null,
    projectSlug: n.projectSlug || null,
    askId: n.askId || null,
  };
  if (Array.isArray(n.questions)) vbrt.questions = n.questions;
  let body = JSON.stringify({ aps, vbrt });
  // APNs caps the payload at 4KB. If the questions blob pushes us over, drop it — the
  // app re-fetches the open question off the session stream when it opens the convo.
  if (Buffer.byteLength(body) > 3800 && vbrt.questions) {
    delete vbrt.questions;
    body = JSON.stringify({ aps, vbrt });
  }
  return body;
}

// POST one notification to one device over a short-lived HTTP/2 session. Resolves
// with { ok, status, reason } and never throws (a push failure must never affect a
// turn). A 410/410-style "gone" reason prunes the dead token.
function sendOne(deviceToken, body, { collapseId } = {}) {
  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(APNS_HOST);
    } catch (e) {
      return resolve({ ok: false, status: 0, reason: e && e.message });
    }
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch { /* ignore */ }
      resolve(r);
    };
    client.on('error', (e) => done({ ok: false, status: 0, reason: e && e.message }));
    const headers = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${providerToken()}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    };
    if (collapseId) headers['apns-collapse-id'] = String(collapseId).slice(0, 64);
    let req;
    try {
      req = client.request(headers);
    } catch (e) {
      return done({ ok: false, status: 0, reason: e && e.message });
    }
    let status = 0;
    let data = '';
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let reason = '';
      if (data) { try { reason = JSON.parse(data).reason || ''; } catch { /* non-JSON */ } }
      // 410 = the device unregistered; 400 BadDeviceToken = a stale/garbage token.
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered') pruneDevice(deviceToken);
      done({ ok: status === 200, status, reason });
    });
    req.on('error', (e) => done({ ok: false, status: 0, reason: e && e.message }));
    req.setTimeout(8000, () => { try { req.close(); } catch { /* ignore */ } done({ ok: false, status: 0, reason: 'timeout' }); });
    req.end(body);
  });
}

// Fan a notification to every registered device. Fire-and-forget from the caller's
// view (it returns a promise the turn ignores). No-ops when push isn't configured.
// Single-user today: every device belongs to the one operator, so we don't filter by
// owner — revisit when the instance goes multi-user (filter readDevices by n.owner).
export async function notifyAll(n) {
  if (!pushEnabled()) return { sent: 0, skipped: 'push-not-configured' };
  const devices = readDevices();
  if (!devices.length) return { sent: 0 };
  const body = buildPayload(n);
  const collapseId = n.kind === 'ask' ? n.askId : n.sessionId;
  const results = await Promise.all(devices.map((d) => sendOne(d.token, body, { collapseId })));
  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error('[apns] %d/%d push failed:', failed.length, results.length, failed.map((f) => f.status + (f.reason ? ` ${f.reason}` : '')).join(', '));
  }
  return { sent, failed: failed.length };
}
