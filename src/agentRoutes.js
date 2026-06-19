// HTTP surface for the local agent runtime (src/agent.js). Kept in its own file
// because this is the RCE-sensitive control plane (PLAN_AGENT_RUNTIME.md): every
// route here can cause shell + file ops on the dev machine, so it is mounted
// only in local mode and every request is additionally loopback-guarded.

import path from 'node:path';
import { startSession, sendMessage, stopSession, subscribe, getSession, listSessions } from './agent.js';

// Hard gate: refuse any request whose TCP peer isn't loopback. We deliberately
// read socket.remoteAddress (the real peer) rather than req.ip, so a spoofed
// X-Forwarded-For can't pass even though the app trusts proxies for link minting.
function loopbackOnly(req, res, next) {
  const addr = req.socket && req.socket.remoteAddress;
  const ok = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  if (!ok) return res.status(403).json({ error: 'agent control plane is loopback-only' });
  next();
}

function fail(res, err) {
  res.status(400).json({ error: err && err.message ? err.message : String(err) });
}

export function mountAgent(app, publicDir) {
  const guard = loopbackOnly;

  // Is the runtime usable here? (UI uses this to show a clear banner.)
  app.get('/api/agent/health', guard, (_req, res) => {
    res.json({ ok: true, bin: process.env.VBRT_CLAUDE_BIN || 'claude', defaultCwd: process.cwd() });
  });

  app.get('/api/agent/sessions', guard, (_req, res) => {
    res.json(listSessions());
  });

  // Start a new driven session (spawns the real claude binary for turn 1).
  app.post('/api/agent/sessions', guard, (req, res) => {
    try {
      const { cwd, prompt, permissionMode } = req.body || {};
      res.json(startSession({ cwd: cwd || process.cwd(), prompt, permissionMode }));
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

  // The drive UI itself (standalone, local-only page).
  app.get('/drive', guard, (_req, res) => {
    res.sendFile(path.join(publicDir, 'drive.html'));
  });
}
