import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordLiveVersion } from './harness.js';

const CODEX_BIN = process.env.VBRT_CODEX_BIN || 'codex';
const MAX_EVENTS = Number(process.env.VBRT_AGENT_MAX_EVENTS || 2000);
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

const sessions = new Map();
const rosterSubs = new Set();
const ROSTER_KINDS = new Set([
  'status', 'tool_use', 'usage', 'user_prompt', 'result', 'turn_end', 'system', 'error', 'stopped',
]);

function now() {
  return Date.now();
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function ensureCodexHome() {
  try { fs.mkdirSync(codexHome(), { recursive: true }); } catch { /* best effort */ }
}

function authPath() {
  return path.join(codexHome(), 'auth.json');
}

function readDiskAuth() {
  try {
    return JSON.parse(fs.readFileSync(authPath(), 'utf8'));
  } catch {
    return null;
  }
}

function authRefreshTime(parsed) {
  const t = parsed && parsed.last_refresh;
  const ms = typeof t === 'string' ? Date.parse(t) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function hasSubscriptionAuth() {
  const auth = readDiskAuth();
  return auth && auth.auth_mode === 'chatgpt' && auth.tokens && auth.tokens.refresh_token;
}

// Seed a ChatGPT/Codex subscription login into CODEX_HOME for hosted Drive.
// This mirrors Claude's CLAUDE_CREDENTIALS_JSON path: the operator exports their
// local ~/.codex/auth.json as CODEX_AUTH_JSON, and the Fly volume keeps refreshed
// tokens across restarts. A newer on-disk refresh wins over an older secret.
export function ensureCodexSubscriptionCredentials() {
  ensureCodexHome();
  const raw = process.env.CODEX_AUTH_JSON;
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[codex-agent] CODEX_AUTH_JSON is not valid JSON; ignoring');
    return;
  }
  if (parsed.auth_mode !== 'chatgpt' || !parsed.tokens || !parsed.tokens.refresh_token) {
    console.error('[codex-agent] CODEX_AUTH_JSON does not look like a ChatGPT Codex login; ignoring');
    return;
  }
  const disk = readDiskAuth();
  if (disk && authRefreshTime(parsed) <= authRefreshTime(disk)) return;
  try {
    fs.mkdirSync(codexHome(), { recursive: true });
    fs.writeFileSync(authPath(), raw, { mode: 0o600 });
    console.log(`[codex-agent] seeded ChatGPT auth into ${authPath()}`);
  } catch (e) {
    console.error('[codex-agent] failed to seed Codex auth:', e && e.message);
  }
}

function summarizeAction(name, input) {
  const n = String(name || '').toLowerCase();
  let verb = 'read';
  if (/update_plan|todowrite|exit_plan|plan_mode/.test(n)) verb = 'plan';
  else if (/write|create/.test(n)) verb = 'write';
  else if (/edit|apply_patch|patch|notebook|multiedit/.test(n)) verb = 'edit';
  else if (/bash|exec|shell|\brun\b|command|terminal/.test(n)) verb = 'run';

  let file = null;
  let label = name || 'tool';
  if (input && typeof input === 'object') {
    file = input.file_path || input.path || input.notebook_path || null;
    label = file || input.command || input.cmd || input.query || input.pattern || label;
  } else if (typeof input === 'string') {
    const matched = input.match(/\b(?:cmd|command|path)\s*:\s*["'`]([^"'`]{1,160})/);
    label = matched ? matched[1] : input.replace(/\s+/g, ' ').trim().slice(0, 100);
  }
  return { verb, label: String(label).split(/[\\/]/).pop(), file: file ? String(file) : null };
}

function planDocOf(file) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop();
  return /plan/i.test(base) && /\.md$/i.test(base) ? base : null;
}

function contextWindow(model, explicit) {
  if (explicit) return explicit;
  const m = String(model || '').toLowerCase();
  if (m.includes('1m') || m.includes('1000k')) return 1_000_000;
  return 200_000;
}

function createSession({ cwd, permissionMode, projectSlug = null, githubToken = null }) {
  const id = randomUUID();
  const session = {
    id,
    cwd,
    permissionMode,
    projectSlug,
    githubToken,
    codexSessionId: null,
    claudeSessionId: null,
    status: 'starting',
    createdAt: now(),
    lastEventAt: now(),
    title: null,
    type: 'codex',
    model: null,
    harnessVersion: null,
    promptStartedAt: null,
    lastAction: null,
    currentPlan: null,
    declaredPlan: null,
    declaredNote: null,
    ctxTokens: 0,
    ctxPct: 0,
    pendingPromptEcho: null,
    events: [],
    seq: 0,
    subscribers: new Set(),
    child: null,
  };
  sessions.set(id, session);
  notifyRoster(session);
  return session;
}

function emit(session, evt) {
  const event = { seq: ++session.seq, t: now(), ...evt };
  session.lastEventAt = event.t;
  session.events.push(event);
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
  for (const fn of session.subscribers) {
    try { fn(event); } catch { /* ignore broken subscriber */ }
  }
  if (ROSTER_KINDS.has(event.kind)) notifyRoster(session);
  return event;
}

function setStatus(session, status) {
  if (session.status === status) return;
  session.status = status;
  emit(session, { kind: 'status', status });
}

export function subscribeCodexRoster(onMsg) {
  rosterSubs.add(onMsg);
  return () => rosterSubs.delete(onMsg);
}

function notifyRoster(session) {
  if (!rosterSubs.size) return;
  if (sessions.get(session.id) !== session) return;
  const view = publicView(session);
  for (const fn of rosterSubs) {
    try { fn({ kind: 'agent', session: view }); } catch { /* ignore */ }
  }
}

function notifyRosterRemoved(id) {
  for (const fn of rosterSubs) {
    try { fn({ kind: 'removed', id }); } catch { /* ignore */ }
  }
}

function childEnv(session) {
  const env = { ...process.env };
  if (hasSubscriptionAuth()) {
    delete env.OPENAI_API_KEY;
  }
  if (session && session.projectSlug) {
    env.VBRT_PROJECT_SLUG = session.projectSlug;
    const origin = process.env.VBRT_PUBLIC_URL;
    if (origin) env.VBRT_PREVIEW_BASE = `${origin.replace(/\/+$/, '')}/preview/${session.projectSlug}`;
    const port = process.env.PORT || 8080;
    env.VBRT_PREVIEW_LOOPBACK = `http://127.0.0.1:${port}/preview/${session.projectSlug}`;
  }
  if (session && session.codexSessionId) {
    env.VBRT_DRIVE_SESSION_ID = `codex-${session.codexSessionId}`;
  }
  if (session && session.githubToken) {
    env.GITHUB_TOKEN = session.githubToken;
  }
  return env;
}

function argsFor(session, prompt, { resume }) {
  const args = ['exec'];
  if (resume) args.push('resume');
  args.push('--json', '--skip-git-repo-check');
  if (!resume) args.push('--color', 'never');

  if (session.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if (!resume) {
    args.push('--sandbox', 'workspace-write', '--ask-for-approval', 'never');
  }

  if (resume) {
    args.push(session.codexSessionId, '-');
  } else {
    args.push('-');
  }
  return { args, stdin: prompt };
}

function recordUsage(session, info) {
  const usage = (info && info.last_token_usage) || info || {};
  const ctx = usage.input_tokens ?? usage.total_tokens ?? null;
  if (ctx == null) return;
  const window = contextWindow(session.model, info && info.model_context_window);
  session.ctxTokens = ctx;
  session.ctxPct = Math.min(100, Math.round((ctx / window) * 100));
  emit(session, { kind: 'usage', usage: { input_tokens: ctx, total_tokens: usage.total_tokens ?? ctx } });
}

function handleCodexEvent(session, obj) {
  const payload = obj && obj.payload ? obj.payload : {};
  const ts = obj && obj.timestamp ? Date.parse(obj.timestamp) || null : null;

  if (obj.type === 'session_meta') {
    if (payload.id && !session.codexSessionId) session.codexSessionId = String(payload.id);
    emit(session, {
      kind: 'system',
      sessionId: session.codexSessionId || null,
      model: session.model || null,
      version: session.harnessVersion || null,
      raw: obj,
    });
    return;
  }

  if (obj.type === 'turn_context') {
    session.model = payload.model || session.model;
    const version = payload.version || payload.codex_version || payload.cli_version || null;
    if (version) {
      session.harnessVersion = String(version);
      recordLiveVersion('codex', session.harnessVersion);
    }
    emit(session, { kind: 'system', model: session.model || null, version: session.harnessVersion || null, raw: obj });
    return;
  }

  if (obj.type === 'event_msg') {
    if (payload.type === 'task_started') {
      setStatus(session, 'working');
    } else if (payload.type === 'task_complete') {
      emit(session, { kind: 'result', isError: false, result: payload.message || null });
    } else if (payload.type === 'turn_aborted') {
      emit(session, { kind: 'result', isError: true, result: payload.message || 'turn aborted' });
    } else if (payload.type === 'token_count') {
      recordUsage(session, payload.info || {});
    } else if (payload.type === 'user_message') {
      const text = payload.message || '';
      if (text.trim() && !text.startsWith('<')) {
        if (session.pendingPromptEcho && text.trim() === session.pendingPromptEcho) {
          session.pendingPromptEcho = null;
        } else {
          emit(session, { kind: 'user_prompt', text });
        }
      }
    } else if (payload.type === 'agent_message') {
      if (payload.message && payload.message.trim()) emit(session, { kind: 'assistant_text', text: payload.message });
    } else if (payload.type === 'agent_reasoning') {
      if (payload.text && payload.text.trim()) emit(session, { kind: 'thinking', text: payload.text });
    } else {
      emit(session, { kind: 'raw', raw: obj });
    }
    if (ts) session.lastEventAt = ts;
    return;
  }

  if (obj.type === 'response_item') {
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      let input = payload.arguments ?? payload.input;
      try {
        if (typeof input === 'string') input = JSON.parse(input);
      } catch {
        /* keep raw string */
      }
      session.lastAction = summarizeAction(payload.name, input);
      const plan = planDocOf(session.lastAction.file);
      if (plan) session.currentPlan = plan;
      emit(session, { kind: 'tool_use', id: payload.call_id || payload.id || null, name: payload.name || 'tool', input: input || {} });
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      let text = payload.output;
      if (typeof text !== 'string') text = JSON.stringify(text ?? '');
      emit(session, { kind: 'tool_result', toolUseId: payload.call_id || payload.id || null, isError: false, text: text.slice(0, 4000) });
    } else {
      emit(session, { kind: 'raw', raw: obj });
    }
    if (ts) session.lastEventAt = ts;
    return;
  }

  emit(session, { kind: 'raw', raw: obj });
}

function runTurn(session, prompt, { resume }) {
  session.promptStartedAt = now();
  session.lastAction = null;
  session.pendingPromptEcho = String(prompt).trim();
  emit(session, { kind: 'user_prompt', text: prompt });
  setStatus(session, 'working');

  const { args, stdin } = argsFor(session, prompt, { resume });
  const child = spawn(CODEX_BIN, args, {
    cwd: session.cwd,
    env: childEnv(session),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  session.child = child;

  child.on('error', (err) => {
    emit(session, { kind: 'error', message: `failed to spawn ${CODEX_BIN}: ${err.message}` });
    setStatus(session, 'error');
    session.child = null;
  });

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handleCodexEvent(session, JSON.parse(line)); } catch { /* ignore non-json */ }
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  child.on('close', (code) => {
    if (buf.trim()) {
      try { handleCodexEvent(session, JSON.parse(buf.trim())); } catch { /* trailing partial line */ }
    }
    session.child = null;
    if (code !== 0) {
      emit(session, { kind: 'error', message: `codex exited ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}` });
      setStatus(session, session.codexSessionId ? 'idle' : 'error');
    } else {
      setStatus(session, 'idle');
    }
    emit(session, { kind: 'turn_end', code });
  });

  child.stdin.write(stdin);
  child.stdin.end();
}

function assertIdleCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');
  let st;
  try { st = fs.statSync(cwd); } catch { throw new Error(`cwd does not exist: ${cwd}`); }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
}

export function startCodexSession({ cwd, prompt, permissionMode = 'default', projectSlug = null, githubToken = null }) {
  assertIdleCwd(cwd);
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
  const session = createSession({ cwd, permissionMode, projectSlug, githubToken });
  session.title = String(prompt).trim().slice(0, 120);
  runTurn(session, String(prompt), { resume: false });
  return publicView(session);
}

export function sendCodexMessage({ id, prompt }) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  if (session.status === 'working' || session.child) throw new Error('session is busy; wait for the current turn to finish');
  if (!session.codexSessionId) throw new Error('session has no codex id yet; cannot resume');
  runTurn(session, String(prompt), { resume: true });
  return publicView(session);
}

export function stopCodexSession({ id }) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  if (session.child) {
    session.child.kill('SIGTERM');
    emit(session, { kind: 'stopped' });
  }
  return publicView(session);
}

export function endCodexSession({ id }) {
  const session = sessions.get(id);
  if (!session) return { ok: true, id, ended: false };
  if (session.child) {
    try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  sessions.delete(id);
  notifyRosterRemoved(id);
  return { ok: true, id, ended: true };
}

export function getCodexSession(id) {
  const session = sessions.get(id);
  return session ? publicView(session) : null;
}

export function listCodexSessions() {
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicView);
}

export function subscribeCodex(id, onEvent, afterSeq = 0) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  for (const e of session.events.filter((evt) => evt.seq > afterSeq)) onEvent(e);
  session.subscribers.add(onEvent);
  return () => session.subscribers.delete(onEvent);
}

function publicView(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    projectSlug: session.projectSlug,
    permissionMode: session.permissionMode,
    claudeSessionId: null,
    codexSessionId: session.codexSessionId,
    status: session.status,
    title: session.title,
    createdAt: session.createdAt,
    lastEventAt: session.lastEventAt,
    seq: session.seq,
    type: 'codex',
    model: session.model || null,
    harnessVersion: session.harnessVersion || null,
    promptStartedAt: session.promptStartedAt || null,
    lastAction: session.lastAction || null,
    currentPlan: session.currentPlan || null,
    declaredPlan: session.declaredPlan || null,
    declaredNote: session.declaredNote || null,
    ctxTokens: session.ctxTokens || 0,
    ctxPct: session.ctxPct || 0,
  };
}
