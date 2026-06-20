// HTTP surface for the agent runtime (src/agent.js). Kept in its own file because
// this is the RCE-sensitive control plane (PLAN_AGENT_RUNTIME.md): every route
// here can cause shell + file ops on the host. Two guard modes:
//   - local (`vbrt serve`): loopback-only, single trusted user.
//   - hosted (Fly): the routes are reachable over the internet, so they are gated
//     to a signed-in account whose email is in the admin allowlist. Deny-by-default
//     — an empty/missing allowlist locks the control plane entirely.

import fs from 'node:fs';
import { startSession, sendMessage, stopSession, subscribe, getSession, listSessions, registerAsk, resolveAsk } from './agent.js';
import { startClone, syncWorkspace, workspaceStatus, resolveProjectCwd } from './workspaces.js';
import { currentUser } from './oauth.js';

// Local guard: refuse any request whose TCP peer isn't loopback. We deliberately
// read socket.remoteAddress (the real peer) rather than req.ip, so a spoofed
// X-Forwarded-For can't pass even though the app trusts proxies for link minting.
function loopbackOnly(req, res, next) {
  const addr = req.socket && req.socket.remoteAddress;
  const ok = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!ok) return res.status(403).json({ error: 'agent control plane is loopback-only' });
  next();
}

// Hosted guard: a signed-in account whose email is in the admin allowlist. The
// loopback check is meaningless behind Fly's proxy, so identity is the gate.
function makeAdminGuard(adminEmails) {
  const allow = new Set((adminEmails || []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  return function requireAdmin(req, res, next) {
    const user = currentUser(req);
    const email = user && user.email ? user.email.toLowerCase() : null;
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
  const guard = hosted ? makeAdminGuard(adminEmails) : loopbackOnly;

  // Make sure the default working directory exists so the very first session can
  // start (on Fly this is a dir on the persistent volume, not the app source).
  try { fs.mkdirSync(defaultCwd, { recursive: true }); } catch { /* best effort */ }

  // Is the runtime usable here? (UI uses this to show a clear banner.)
  app.get('/api/agent/health', guard, (_req, res) => {
    res.json({ ok: true, bin: process.env.VBRT_CLAUDE_BIN || 'claude', defaultCwd });
  });

  app.get('/api/agent/sessions', guard, (_req, res) => {
    res.json(listSessions());
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
      res.json(startSession({ cwd: workdir, prompt, permissionMode, projectSlug: projectSlug || null }));
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
      const ws = await startClone(req.params.slug, { repo, branch });
      res.json(ws);
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

  // The Drive UI replies to an `ask` picker here (guarded like the rest of the
  // control plane). Resolves the parked sidecar request.
  app.post('/api/agent/sessions/:id/answer', guard, (req, res) => {
    const { askId, selections } = req.body || {};
    const ok = resolveAsk(askId, selections);
    res.json({ ok });
  });

  // Live event stream (SSE). `?after=N` backfills everything past seq N first, so
  // a reconnecting client resumes without gaps or dupes.
  app.get('/api/agent/sessions/:id/stream', guard, (req, res) => {
    const after = Number(req.query.after || 0) || 0;
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
        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
