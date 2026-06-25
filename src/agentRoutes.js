// HTTP surface for the agent runtime (src/agent.js). Kept in its own file because
// this is the RCE-sensitive control plane (PLAN_AGENT_RUNTIME.md): every route
// here can cause shell + file ops on the host. Two guard modes:
//   - local (`vbrt serve`): loopback-only, single trusted user.
//   - hosted (Fly): the routes are reachable over the internet, so they are gated
//     to a signed-in account whose email is in the admin allowlist. Deny-by-default
//     — an empty/missing allowlist locks the control plane entirely.

import fs from 'node:fs';
import { startSession, adoptSession, sendMessage, stopSession, endSession, subscribe, subscribeRoster, getSession, listSessions, registerAsk, resolveAsk, recordReport } from './agent.js';
import { startCodexSession, sendCodexMessage, stopCodexSession, endCodexSession, subscribeCodex, subscribeCodexRoster, getCodexSession, listCodexSessions } from './codexAgent.js';
import { harnessReport, invalidateHost } from './harness.js';
import { startClone, syncWorkspace, workspaceStatus, resolveProjectCwd } from './workspaces.js';
import { listWorkspaceSessions } from './driveIngest.js';
import { currentUser } from './oauth.js';
import { bearer, hashToken } from './auth.js';
import { findUserByOwnerHash, getGithubToken } from './accounts.js';
import { getProject } from './storage.js';
import { registerDevice, unregisterDevice, pushEnabled } from './apns.js';

// The decrypted per-user GitHub token to clone/push a project with, or null. We use
// the project OWNER's connected token (not the requester's) so the repo is always
// accessed as the person it belongs to — correct for the single-admin case today and
// for multi-tenant later. Never logged; handed only to git via an env var. Slice 2.
function githubTokenForProject(slug) {
  try {
    const proj = slug && getProject(slug);
    if (!proj || !proj.owner) return null;
    const user = findUserByOwnerHash(proj.owner);
    return user ? getGithubToken(user) : null;
  } catch {
    return null;
  }
}

// Is the TCP peer loopback? We deliberately read socket.remoteAddress (the real
// peer) rather than req.ip, so a spoofed X-Forwarded-For can't pass even though the
// app trusts proxies for link minting. A loopback peer means the request originated
// *inside this container* (e.g. the driven agent's own headless browser) — the
// internet always arrives via Fly's proxy, which is not loopback.
function isLoopbackPeer(req) {
  const addr = req.socket && req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Local guard: refuse any request whose TCP peer isn't loopback.
function loopbackOnly(req, res, next) {
  if (!isLoopbackPeer(req)) return res.status(403).json({ error: 'agent control plane is loopback-only' });
  next();
}

// The admin identity behind a request: an OAuth session, OR a bearer token linked
// to an account (the native/TestFlight app can't complete OAuth, so it signs in
// with a token — see PLAN_NATIVE_AUTH.md). Returns the account email or null.
function adminEmailFor(req) {
  const user = currentUser(req);
  if (user && user.email) return user.email.toLowerCase();
  const token = bearer(req);
  if (token) {
    const acct = findUserByOwnerHash(hashToken(token));
    if (acct && acct.email) return acct.email.toLowerCase();
  }
  return null;
}

// Hosted guard: the request must resolve to an account whose email is in the admin
// allowlist. The loopback check is meaningless behind Fly's proxy, so identity is the
// gate. Accepting an admin-linked token makes that token RCE-capable — acceptable for
// the single-user instance; revisit for multi-user (PLAN_NATIVE_AUTH.md).
function makeAdminGuard(adminEmails) {
  const allow = new Set((adminEmails || []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  return function requireAdmin(req, res, next) {
    const email = adminEmailFor(req);
    if (!email || !allow.has(email)) {
      return res.status(403).json({ error: 'drive is restricted to the instance admin; sign in at /auth' });
    }
    next();
  };
}

function fail(res, err) {
  res.status(400).json({ error: err && err.message ? err.message : String(err) });
}

// opts: { hosted, adminEmails, defaultCwd }. In hosted mode the control plane is
// internet-reachable, so the admin guard (not loopback) is the protection. The
// Drive UI itself is now part of the dashboard SPA (public/app.js), so there's no
// page to serve here — only the JSON/SSE control plane.
export function mountAgent(app, opts = {}) {
  const { hosted = false, adminEmails = [], defaultCwd = process.cwd() } = opts;
  const adminGuard = makeAdminGuard(adminEmails);
  const guard = hosted ? adminGuard : loopbackOnly;

  // The preview route only serves static workspace files read-only (no RCE), so it can
  // safely admit the in-container agent capturing its own preview (loopback peer) even
  // in hosted mode, while the internet still needs admin. This is what unblocks
  // `vbrt shot $VBRT_PREVIEW_BASE/...` headless — a headless browser carries no admin
  // cookie, but it reaches the route over loopback (see childEnv's VBRT_PREVIEW_LOOPBACK).
  const previewGuard = hosted
    ? (req, res, next) => (isLoopbackPeer(req) ? next() : adminGuard(req, res, next))
    : loopbackOnly;

  // EventSource can't set an Authorization header, and the native/TestFlight app has no
  // OAuth session cookie (PLAN_NATIVE_AUTH.md) — so the live SSE stream would 403 there
  // even though every fetch-based call authenticates fine with the Bearer token. Let the
  // stream route ALSO accept the admin token as an `?access_token=` query param: we fold
  // it into the Authorization header so the normal guard still does the real check. Token-
  // in-URL gets logged, but the instance is single-user and that token is already RCE-
  // capable, so this widens no trust boundary. Scoped to this one route; everything else
  // stays header/cookie-only.
  const streamGuard = (req, res, next) => {
    if (!req.headers['authorization'] && req.query && req.query.access_token) {
      req.headers['authorization'] = 'Bearer ' + req.query.access_token;
    }
    return guard(req, res, next);
  };

  // Make sure the default working directory exists so the very first session can
  // start (on Fly this is a dir on the persistent volume, not the app source).
  try { fs.mkdirSync(defaultCwd, { recursive: true }); } catch { /* best effort */ }

  // Is the runtime usable here? (UI uses this to show a clear banner.)
  app.get('/api/agent/health', guard, (_req, res) => {
    res.json({
      ok: true,
      bin: process.env.VBRT_CLAUDE_BIN || 'claude',
      codexBin: process.env.VBRT_CODEX_BIN || 'codex',
      defaultCwd,
    });
  });

  // Harness rail data (PLAN_HARNESS_VERSIONING.md WS1/WS5): per harness — installed
  // version + source, upstream latest + release date, and drift ("N behind" /
  // outdated). The read surface over the version we now capture, plus the npm-
  // registry "latest" poll (cached in harness.js). Operator-scoped like the rest of
  // the control plane — it describes *this instance's* binaries. `?refresh=host`
  // forces a re-sample (use after a deploy that swapped the binary).
  app.get('/api/agent/harness', guard, async (req, res) => {
    try {
      if (req.query.refresh === 'host') invalidateHost();
      res.json(await harnessReport());
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/agent/sessions', guard, (_req, res) => {
    res.json([...listSessions(), ...listCodexSessions()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  });

  // Aggregate roster stream (PLAN_COCKPIT.md §3.1c): one project-scoped SSE that
  // sends a snapshot then every roster-relevant change — so the cockpit "Now" zone
  // ticks live instead of polling /api/agent/sessions every 2.5 s. `?project=slug`
  // scopes it; omitted → all sessions. Token rides the query like the per-session
  // stream (EventSource carries no Authorization header).
  app.get('/api/agent/roster/stream', streamGuard, (req, res) => {
    const project = req.query.project ? String(req.query.project) : null;
    const matches = (s) => !project || s.projectSlug === project;
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Snapshot first, so a fresh/reconnecting client paints the whole roster at once.
    res.write(`data: ${JSON.stringify({ kind: 'snapshot', sessions: [...listSessions(), ...listCodexSessions()].filter(matches) })}\n\n`);
    const unsub = subscribeRoster((msg) => {
      // 'agent' frames carry a full view we can filter by project; 'removed' carries
      // only an id (the session is already gone), so we forward it unfiltered — the
      // client harmlessly ignores an id it never had.
      if (msg.kind === 'agent' && !matches(msg.session)) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const unsubCodex = subscribeCodexRoster((msg) => {
      if (msg.kind === 'agent' && !matches(msg.session)) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); unsub(); unsubCodex(); });
  });

  // Start a new driven session (spawns the real claude binary for turn 1). When a
  // `projectSlug` is given, the session runs in that project's bound workspace
  // (PLAN_DRIVE_WORKSPACES.md) — the checkout cloned onto the volume — instead of
  // the global default cwd, so driving "in project X" actually works on X's code.
  app.post('/api/agent/sessions', guard, (req, res) => {
    try {
      const { cwd, prompt, permissionMode, projectSlug } = req.body || {};
      let workdir = cwd || defaultCwd;
      if (projectSlug) {
        const resolved = resolveProjectCwd(projectSlug);
        if (!resolved) return res.status(409).json({ error: 'project workspace is not set up yet; clone it first' });
        workdir = resolved;
      }
      // Pass the bound slug through so the runtime can ingest each finished turn
      // back into this project's rail (driveIngest.js). Only set when driving a
      // real project — ad-hoc sessions on the default cwd have nowhere to land.
      // githubToken lets the agent push with the owner's connected GitHub (Slice 2).
      res.json(startSession({ cwd: workdir, prompt, permissionMode, projectSlug: projectSlug || null, githubToken: githubTokenForProject(projectSlug) }));
    } catch (err) {
      fail(res, err);
    }
  });

  // Start a Codex-driven session in the same project workspace shape as Claude Drive.
  // Kept under /codex so existing iOS/web clients continue to hit the Claude runtime
  // until they deliberately opt into Codex.
  app.post('/api/agent/codex/sessions', guard, (req, res) => {
    try {
      const { cwd, prompt, permissionMode, projectSlug } = req.body || {};
      let workdir = cwd || defaultCwd;
      if (projectSlug) {
        const resolved = resolveProjectCwd(projectSlug);
        if (!resolved) return res.status(409).json({ error: 'project workspace is not set up yet; clone it first' });
        workdir = resolved;
      }
      res.json(startCodexSession({ cwd: workdir, prompt, permissionMode, projectSlug: projectSlug || null, githubToken: githubTokenForProject(projectSlug) }));
    } catch (err) {
      fail(res, err);
    }
  });

  // Re-adopt a session whose in-memory record a server restart / redeploy wiped.
  // The browser kept the durable claude session id (localStorage), so we rebind a
  // fresh local handle to it and replay the saved transcript — the "/resume" path
  // that survives a redeploy, so "return to Drive" reconnects instead of dying.
  // Defined BEFORE /sessions/:id so "adopt" isn't swallowed by the :id param. cwd
  // resolves from the bound project's workspace checkout, like the start route.
  app.post('/api/agent/sessions/adopt', guard, async (req, res) => {
    try {
      const { claudeSessionId, cwd, projectSlug, permissionMode } = req.body || {};
      let workdir = cwd || defaultCwd;
      if (projectSlug) {
        const resolved = resolveProjectCwd(projectSlug);
        if (resolved) workdir = resolved;
      }
      res.json(await adoptSession({
        claudeSessionId,
        cwd: workdir,
        projectSlug: projectSlug || null,
        permissionMode: permissionMode || 'default',
        githubToken: githubTokenForProject(projectSlug),
      }));
    } catch (err) {
      fail(res, err);
    }
  });

  // --- Drive workspaces: bind a project to a checkout on the host -----------------
  app.get('/api/agent/workspace/:slug', guard, (req, res) => {
    const status = workspaceStatus(req.params.slug);
    if (!status) return res.status(404).json({ error: 'unknown project' });
    res.json(status);
  });

  // Clone (or re-clone) the project's repo onto the volume. Returns immediately with
  // status `cloning`; the UI polls GET above until it flips to ready/error.
  app.post('/api/agent/workspace/:slug/setup', guard, async (req, res) => {
    try {
      const { repo, branch } = req.body || {};
      const token = githubTokenForProject(req.params.slug); // owner's connected token (Slice 2), or null → instance token
      const ws = await startClone(req.params.slug, { repo, branch, token });
      res.json(ws);
    } catch (err) {
      fail(res, err);
    }
  });

  // Cross-device Drive session index: every session ever driven in this project's
  // workspace, read from the durable on-disk transcripts (driveIngest), not the
  // in-memory Map or any one browser's localStorage. This is what makes a session
  // started on a phone resumable from a laptop. We annotate each with its live
  // status (id + status) when the in-memory session still exists this process, so
  // the UI can route a still-running one straight back instead of re-adopting.
  app.get('/api/agent/workspace/:slug/sessions', guard, async (req, res) => {
    try {
      const cwd = resolveProjectCwd(req.params.slug);
      if (!cwd) return res.json({ sessions: [] }); // workspace not set up yet
      const live = new Map();
      for (const s of listSessions()) {
        if (s.claudeSessionId) live.set(s.claudeSessionId, s);
      }
      const sessions = (await listWorkspaceSessions(cwd)).map((s) => {
        const l = live.get(s.claudeSessionId);
        return l ? { ...s, liveId: l.id, status: l.status } : s;
      });
      res.json({ sessions });
    } catch (err) {
      fail(res, err);
    }
  });

  // Refresh a ready workspace to the remote tip.
  app.post('/api/agent/workspace/:slug/sync', guard, async (req, res) => {
    try {
      res.json(await syncWorkspace(req.params.slug));
    } catch (err) {
      fail(res, err);
    }
  });

  // Live preview: serve a file straight from a project's Drive workspace checkout on
  // the shared volume — no commit→push→CI→redeploy. Closes the "I built it but can't
  // show you" gap (archive/DOGFOODING.md / drive-preview-gap): the hosted server already
  // shares the Fly volume with /data/workspaces/<slug>, so a freshly-written file is
  // viewable instantly. Read-only static serve, so `previewGuard` admits the instance
  // admin *or* a loopback peer (the in-container agent capturing its own preview); the
  // internet still needs admin. `res.sendFile` with `root` rejects path traversal
  // (../ escapes) and `dotfiles:'deny'` keeps `.git` out.
  app.get('/preview/:slug/*', previewGuard, (req, res) => {
    const base = resolveProjectCwd(req.params.slug);
    if (!base) return res.status(404).json({ error: 'project workspace is not set up yet; clone it first' });
    const rel = req.params[0] || 'index.html';
    res.sendFile(rel, { root: base, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(err.status === 403 ? 403 : 404).end();
    });
  });

  app.get('/api/agent/codex/sessions/:id', guard, (req, res) => {
    const s = getCodexSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'unknown session' });
    res.json(s);
  });

  app.post('/api/agent/codex/sessions/:id/message', guard, (req, res) => {
    try {
      res.json(sendCodexMessage({ id: req.params.id, prompt: (req.body || {}).prompt }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/agent/codex/sessions/:id/stop', guard, (req, res) => {
    try {
      res.json(stopCodexSession({ id: req.params.id }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/agent/codex/sessions/:id/end', guard, (req, res) => {
    try {
      res.json(endCodexSession({ id: req.params.id }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/agent/codex/sessions/:id/stream', streamGuard, (req, res) => {
    const lastEventId = Number(req.headers['last-event-id']);
    const after = Number.isFinite(lastEventId) ? lastEventId : (Number(req.query.after || 0) || 0);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let unsub;
    try {
      unsub = subscribeCodex(req.params.id, (event) => {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }, after);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      return res.end();
    }

    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsub && unsub();
    });
  });

  app.get('/api/agent/sessions/:id', guard, (req, res) => {
    const s = getSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'unknown session' });
    res.json(s);
  });

  // Follow-up message (resumes the session by id).
  app.post('/api/agent/sessions/:id/message', guard, (req, res) => {
    try {
      res.json(sendMessage({ id: req.params.id, prompt: (req.body || {}).prompt }));
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/agent/sessions/:id/stop', guard, (req, res) => {
    try {
      res.json(stopSession({ id: req.params.id }));
    } catch (err) {
      fail(res, err);
    }
  });

  // End a session and remove it from the live roster (cockpit "swipe to end"). Kills
  // any running turn; the transcript survives on disk, so this is non-destructive.
  app.post('/api/agent/sessions/:id/end', guard, (req, res) => {
    try {
      res.json(endSession({ id: req.params.id }));
    } catch (err) {
      fail(res, err);
    }
  });

  // The MCP `ask` sidecar (src/mcpAsk.js) posts here when the driven agent calls
  // our ask tool. ALWAYS loopback-only — the sidecar runs on this host, and this
  // must never be reachable from the internet even in hosted mode. The request is
  // parked until the Drive UI answers (or registerAsk's wait times out), then we
  // respond with the selections for the sidecar to hand back to the agent.
  app.post('/api/agent/internal/ask', loopbackOnly, async (req, res) => {
    const { sessionId, questions } = req.body || {};
    const promise = registerAsk(sessionId, questions);
    if (!promise) return res.status(404).json({ error: 'unknown session', selections: [] });
    try {
      res.json(await promise);
    } catch (err) {
      res.json({ error: err && err.message, selections: [] });
    }
  });

  // The MCP `report` sidecar posts here when the driven agent self-declares the
  // plan it's advancing (PLAN_COCKPIT.md §3.1 tier 2). Loopback-only like `ask`.
  // Fire-and-forget: we stamp the session and ack immediately (no parking).
  app.post('/api/agent/internal/report', loopbackOnly, (req, res) => {
    const { sessionId, plan, status } = req.body || {};
    res.json(recordReport(sessionId, { plan, status }));
  });

  // The Drive UI replies to an `ask` picker here (guarded like the rest of the
  // control plane). Resolves the parked sidecar request.
  app.post('/api/agent/sessions/:id/answer', guard, (req, res) => {
    const { askId, selections } = req.body || {};
    const ok = resolveAsk(askId, selections);
    res.json({ ok });
  });

  // The native app registers its APNs device token here so the server can push it
  // "your agent needs you / finished / errored" (PLAN_NATIVE_REWRITE.md). Admin-guarded
  // like the rest of the control plane; the resolved admin email is stored alongside the
  // token for a future per-owner fan-out (single-user today, so notifyAll sends to all).
  app.post('/api/agent/push/register', guard, (req, res) => {
    const { deviceToken, platform, env } = req.body || {};
    if (!deviceToken || typeof deviceToken !== 'string') return res.status(400).json({ error: 'deviceToken required' });
    registerDevice({ token: deviceToken, owner: adminEmailFor(req), platform: platform || 'ios', env: env || null });
    // Report whether APNs is actually configured, so the app can tell "registered but the
    // server can't send" from "all set" without leaking the secrets.
    res.json({ ok: true, pushConfigured: pushEnabled() });
  });

  app.post('/api/agent/push/unregister', guard, (req, res) => {
    const { deviceToken } = req.body || {};
    if (deviceToken) unregisterDevice(deviceToken);
    res.json({ ok: true });
  });

  // Live event stream (SSE). `?after=N` backfills everything past seq N first, so
  // a reconnecting client resumes without gaps or dupes. We tag every frame with
  // `id: <seq>` so the browser's native auto-reconnect sends `Last-Event-ID`, which
  // we honor over the (connect-time, frozen) `?after` query param — otherwise a
  // dropped EventSource reconnects to the *original* `after=0` URL and replays the
  // whole log, doubling the client transcript. See archive/drive-reconciliation/DRIVE_LIVE_STREAM_DUP.md.
  app.get('/api/agent/sessions/:id/stream', streamGuard, (req, res) => {
    const lastEventId = Number(req.headers['last-event-id']);
    const after = Number.isFinite(lastEventId) ? lastEventId : (Number(req.query.after || 0) || 0);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let unsub;
    try {
      unsub = subscribe(req.params.id, (event) => {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }, after);
    } catch (err) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
      return res.end();
    }

    // Heartbeat so proxies/clients keep the connection open between turns.
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsub && unsub();
    });
  });
}
