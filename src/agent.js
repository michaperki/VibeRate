// VibeRate local agent runtime — the "drive" half (PLAN_AGENT_RUNTIME.md, Fork A).
//
// This is the inversion of the read-only watcher: instead of tailing the agent's
// JSONL after the fact, we *own* the process. We spawn the user's real installed
// `claude` binary with stream-json in/out, so the session runs with their actual
// settings.json, hooks, skills, MCP and — crucially — their local auth. The same
// per-session JSONL the watcher already tails gets written as a side effect, so
// driven sessions still flow back through the normal capture pipeline.
//
// THREAT MODEL (see plan §"Control plane = RCE"): a prompt here causes shell +
// file ops on this machine. This module is therefore localhost-only and never
// mounted in hosted mode — the server guards both. Approvals are a later phase;
// for now the only "yes to everything" path is an explicit, opt-in permission
// mode the caller has to choose.
//
// Turn model (Phase 1): one short-lived process per message, always resuming by
// session id after the first turn. This matches the plan's "resume an idle
// session by ID" framing, sidesteps "does -p stay alive across turns", and keeps
// a real process handle for ground-truth liveness during each turn. We only ever
// resume sessions *we* started, so the two-writer race (a terminal racing our
// resume) can't happen yet — ownership leases for foreign sessions are Phase 2.

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_BIN = process.env.VBRT_CLAUDE_BIN || 'claude';

// Absolute path to our stdio MCP `ask` server (sibling file). claude launches it
// per turn via the --mcp-config we write below.
const MCP_ASK_PATH = fileURLToPath(new URL('./mcpAsk.js', import.meta.url));
const MCP_ASK_TOOL = 'mcp__viberate__ask';

// How long the server parks an `ask` waiting for the human, in ms. Must stay
// BELOW the child's MCP_TOOL_TIMEOUT so our graceful "no answer" result wins the
// race over a hard MCP-layer timeout (see runTurn / registerAsk).
const ASK_WAIT_MS = Number(process.env.VBRT_ASK_WAIT_MS || 5 * 60 * 1000);
const MCP_TOOL_TIMEOUT_MS = Number(process.env.VBRT_MCP_TOOL_TIMEOUT_MS || 10 * 60 * 1000);

// Loopback base URL the MCP sidecar POSTs answers-requests back to. Set by the
// server once it knows its bound port (setBaseUrl). Until then ask is inert.
let BASE_URL = null;
export function setBaseUrl(url) {
  BASE_URL = url;
}

// Pending `ask` round-trips, keyed by askId: the sidecar's POST is parked here
// until the Drive UI answers (resolveAsk) or the wait times out.
const pendingAsks = new Map();

// Register a question the driven agent just asked: emit it to the session's
// Drive UI subscribers and return a promise that settles when the user answers.
// Returns null if the session is unknown (sidecar then surfaces a tool error).
export function registerAsk(sessionId, questions) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  const askId = randomUUID();
  emit(session, { kind: 'ask', askId, questions: Array.isArray(questions) ? questions : [] });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAsks.delete(askId)) {
        emit(session, { kind: 'ask_resolved', askId, timedOut: true });
        resolve({ timedOut: true, selections: [] });
      }
    }, ASK_WAIT_MS);
    pendingAsks.set(askId, { resolve, timer, sessionId });
  });
}

// Settle a pending ask from the Drive UI. `selections` is aligned to questions:
// each = { header?, question?, selectedLabels?: string[], customText?: string }.
export function resolveAsk(askId, selections) {
  const pending = pendingAsks.get(askId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingAsks.delete(askId);
  const session = sessions.get(pending.sessionId);
  if (session) emit(session, { kind: 'ask_resolved', askId });
  pending.resolve({ selections: Array.isArray(selections) ? selections : [] });
  return true;
}

// Where the CLI keeps its config + OAuth credentials. Honors CLAUDE_CONFIG_DIR
// (set to the Fly volume in hosted mode so a refreshed token survives restarts);
// otherwise the usual ~/.claude.
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function credentialsPath() {
  return path.join(claudeConfigDir(), '.credentials.json');
}

// True when a subscription login (claude login OAuth token) is on disk.
function hasSubscriptionCreds() {
  try {
    return fs.statSync(credentialsPath()).isFile();
  } catch {
    return false;
  }
}

// Pull the OAuth token's expiry (epoch ms) out of a parsed credentials blob, so we
// can compare freshness between the secret and the on-disk copy. The CLI nests the
// token under `claudeAiOauth`; tolerate a flat object too. Returns 0 when absent or
// unparseable — i.e. "infinitely stale", which makes the comparison degrade safely
// to plain seed-if-missing rather than misfiring.
function credsExpiry(parsed) {
  if (!parsed || typeof parsed !== 'object') return 0;
  const oauth = parsed.claudeAiOauth || parsed;
  const exp = oauth && oauth.expiresAt;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : 0;
}

// The credentials currently on disk, or null if missing/unreadable/corrupt.
function readDiskCreds() {
  try {
    return JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Seed subscription OAuth credentials from the CLAUDE_CREDENTIALS_JSON secret
// into the config dir, so a hosted (Fly) Drive can run on the operator's Max
// plan instead of API billing. This is a full-account bearer token, so it's a
// SINGLE-OPERATOR, admin-gated affordance only — never collect other users'
// credentials this way (use a per-user API key for that).
//
// Self-healing seed: write the secret when no creds file exists OR when the
// secret's token is *fresher* than the one on disk (higher expiresAt). The CLI's
// OAuth refresh token is single-use/rotating, so once the volume's copy is
// invalidated — e.g. the same Max account refreshes elsewhere — the on-disk token
// 401s and can't recover on its own. Comparing expiry lets a freshly-rotated
// secret take over on the next boot: just `fly secrets set CLAUDE_CREDENTIALS_JSON`
// from a current local login (no manual file deletion). We never clobber a *newer*
// on-disk token (the CLI's own in-place refresh) with an older secret.
export function ensureSubscriptionCredentials() {
  const raw = process.env.CLAUDE_CREDENTIALS_JSON;
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw); // guard against a malformed paste clobbering the file
  } catch {
    console.error('[agent] CLAUDE_CREDENTIALS_JSON is not valid JSON; ignoring');
    return;
  }
  const disk = readDiskCreds();
  if (disk) {
    // Keep the on-disk token when it's at least as fresh as the secret — that's the
    // CLI's own refreshed copy, which we must not stomp with a staler secret.
    if (credsExpiry(parsed) <= credsExpiry(disk)) return;
    console.log(`[agent] CLAUDE_CREDENTIALS_JSON is fresher than ${credentialsPath()}; re-seeding stale token`);
  }
  try {
    fs.mkdirSync(claudeConfigDir(), { recursive: true });
    fs.writeFileSync(credentialsPath(), raw, { mode: 0o600 });
    console.log(`[agent] seeded subscription credentials into ${credentialsPath()}`);
  } catch (e) {
    console.error('[agent] failed to seed subscription credentials:', e && e.message);
  }
}

// Configure git inside the Drive host so the agent can authenticate to GitHub over
// https using the instance's GITHUB_TOKEN (a Fly secret) — both for cloning private
// repos and, crucially, for *pushing* the branches it produces. We register a global
// credential helper that echoes the token from the environment on demand, so git
// uses it for any github.com https operation WITHOUT the token ever being written to
// a repo's .git/config or any other file (only the token-free helper script lives in
// ~/.gitconfig). We also set a default commit identity so the agent's commits don't
// fail with "Author identity unknown" (override via VBRT_GIT_AUTHOR_NAME/EMAIL).
//
// Sibling to ensureSubscriptionCredentials — same seed-at-boot shape — but kept
// SEPARATE on purpose: GitHub push auth and the Claude subscription login are
// unrelated secrets with different lifecycles, so folding one into the other would
// just couple two things that fail independently. No-op without a token (local /
// loopback Drive relies on the operator's own git config).
export function ensureGitAuth() {
  // Normalize GH_TOKEN → GITHUB_TOKEN so the helper (which reads $GITHUB_TOKEN) and
  // any inherited child env see a single canonical name.
  if (!process.env.GITHUB_TOKEN && process.env.GH_TOKEN) process.env.GITHUB_TOKEN = process.env.GH_TOKEN;
  if (!process.env.GITHUB_TOKEN) return;
  const set = (key, val) => {
    try {
      execFileSync('git', ['config', '--global', key, val]);
    } catch (e) {
      console.error(`[agent] git config ${key} failed:`, e && e.message);
    }
  };
  // The helper resolves $GITHUB_TOKEN at call time from the (inherited) env, so the
  // token is never persisted — only this script reference is stored in the gitconfig.
  set('credential.https://github.com.helper',
    '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f');
  set('user.name', process.env.VBRT_GIT_AUTHOR_NAME || 'VibeRate Drive');
  set('user.email', process.env.VBRT_GIT_AUTHOR_EMAIL || 'drive@viberate.local');
  console.log('[agent] configured GitHub credential helper + commit identity for Drive');
}

// Env handed to the spawned `claude`. When a subscription login exists we drop
// the Anthropic API key so the CLI uses that OAuth token (the user's Max plan)
// instead of billing API credits — ANTHROPIC_API_KEY otherwise *shadows* the
// login. With no login on disk we keep the key as the fallback. Either way the
// server keeps the key in its own process.env for the Haiku classifier.
// `onSubscription` is computed once per turn so the result event and the env
// stay consistent if the creds file changes mid-turn.
function childEnv(onSubscription) {
  const env = { ...process.env };
  if (onSubscription) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

// Permission modes we let the UI pick. `default` denies edit/exec without an
// approval channel (which we don't have yet) — safe but limited. The others are
// deliberate opt-ins the user selects per session, with `bypassPermissions` the
// only one that lets the agent act freely (hence the extra dangerous flag).
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

const MAX_EVENTS = Number(process.env.VBRT_AGENT_MAX_EVENTS || 2000);

// In-memory registry of sessions this process owns. Lives only as long as the
// server does; the durable record is the JSONL the spawned binary writes.
const sessions = new Map();

function now() {
  return Date.now();
}

// One driven session: a stable local id, the claude session id once we learn it,
// a capped event log for SSE backfill, and a set of live subscribers.
function createSession({ cwd, permissionMode }) {
  const id = randomUUID();
  const session = {
    id,
    cwd,
    permissionMode,
    claudeSessionId: null, // filled from the first `system/init` event
    status: 'starting', // starting | working | idle | exited | error
    createdAt: now(),
    lastEventAt: now(),
    title: null, // first user prompt, for the session list
    // Per-turn flags: did we stream this block kind via partials? If so we skip
    // it in the consolidated `assistant` message to avoid double-rendering.
    streamedText: false,
    streamedThinking: false,
    events: [],
    seq: 0,
    subscribers: new Set(),
    child: null,
  };
  sessions.set(id, session);
  return session;
}

// Append a normalized event to the log and fan it out to live SSE subscribers.
// Every event carries a monotonic `seq` so a reconnecting client can ask for
// "everything after N" without gaps or dupes.
function emit(session, evt) {
  const event = { seq: ++session.seq, t: now(), ...evt };
  session.lastEventAt = event.t;
  session.events.push(event);
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
  for (const fn of session.subscribers) {
    try {
      fn(event);
    } catch {
      /* a broken subscriber must not take down the session */
    }
  }
  return event;
}

function setStatus(session, status) {
  if (session.status === status) return;
  session.status = status;
  emit(session, { kind: 'status', status });
}

// Translate one raw claude stream-json line into the UI-facing events. We keep
// this lossy-but-honest: text and tool calls become first-class events the chat
// can render, and we always tuck the raw payload under `raw` for debugging.
function handleRawEvent(session, obj) {
  const type = obj.type;

  if (type === 'system' && obj.subtype === 'init') {
    if (obj.session_id && !session.claudeSessionId) session.claudeSessionId = obj.session_id;
    emit(session, {
      kind: 'system',
      sessionId: obj.session_id || null,
      model: obj.model || null,
      tools: Array.isArray(obj.tools) ? obj.tools.length : null,
      raw: obj,
    });
    return;
  }

  // Streaming partials (--include-partial-messages): each `stream_event` wraps a
  // raw Anthropic SSE event under `obj.event`. We stream text/thinking token
  // deltas so the reader fills in live. The consolidated `assistant` message
  // still arrives afterward; the flags set here make us skip its already-streamed
  // text/thinking blocks below (tool_use we still take from the full message,
  // since assembling tool input from input_json_delta isn't worth it).
  if (type === 'stream_event' && obj.event) {
    const e = obj.event;
    if (e.type === 'content_block_start') {
      const b = e.content_block || {};
      if (b.type === 'text') emit(session, { kind: 'assistant_text_start' });
      else if (b.type === 'thinking') emit(session, { kind: 'thinking_start' });
    } else if (e.type === 'content_block_delta') {
      const d = e.delta || {};
      if (d.type === 'text_delta' && d.text) {
        session.streamedText = true;
        emit(session, { kind: 'assistant_text_delta', text: d.text });
      } else if (d.type === 'thinking_delta' && d.thinking) {
        session.streamedThinking = true;
        emit(session, { kind: 'thinking_delta', text: d.thinking });
      }
    } else if (e.type === 'content_block_stop') {
      emit(session, { kind: 'block_stop' });
    }
    return;
  }

  if (type === 'assistant' && obj.message) {
    if (obj.session_id && !session.claudeSessionId) session.claudeSessionId = obj.session_id;
    for (const block of obj.message.content || []) {
      // Skip text/thinking we already streamed via partials; fall back to emitting
      // them whole if partials weren't seen (older binary, or partials disabled).
      if (block.type === 'text' && block.text) {
        if (!session.streamedText) emit(session, { kind: 'assistant_text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        if (!session.streamedThinking) emit(session, { kind: 'thinking', text: block.thinking });
      } else if (block.type === 'tool_use') emit(session, { kind: 'tool_use', name: block.name, input: block.input || {} });
    }
    if (obj.error) emit(session, { kind: 'error', message: String(obj.error) });
    return;
  }

  if (type === 'user' && obj.message) {
    // Tool results come back wrapped as a synthetic user turn.
    for (const block of obj.message.content || []) {
      if (block.type === 'tool_result') {
        const content = block.content;
        const text = typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((c) => (c && c.type === 'text' ? c.text : '')).join('')
            : '';
        emit(session, { kind: 'tool_result', isError: !!block.is_error, text: text.slice(0, 4000) });
      }
    }
    return;
  }

  if (type === 'result') {
    emit(session, {
      kind: 'result',
      isError: !!obj.is_error,
      result: obj.result || null,
      // Null on a subscription turn: total_cost_usd is a token estimate the CLI
      // prints regardless of auth, and you aren't billed it on a plan, so the UI
      // (which omits null cost) shouldn't imply a charge. See childEnv.
      costUsd: session.onSubscription ? null : (obj.total_cost_usd ?? null),
      durationMs: obj.duration_ms ?? null,
      numTurns: obj.num_turns ?? null,
    });
    return;
  }

  // Anything unmodeled (status pings, rate-limit events, hooks): forward as a
  // low-priority raw event so nothing is silently dropped.
  emit(session, { kind: 'raw', raw: obj });
}

// Spawn one claude turn. `resume` decides fresh-start vs --resume <id>. We feed
// exactly one user message on stdin then close it, so the process runs the turn
// and exits — the registry survives to carry the session id into the next turn.
function runTurn(session, prompt, { resume }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--include-partial-messages', // stream token deltas, not just turn-level text
    '--verbose',
    '--permission-mode', session.permissionMode,
  ];
  if (session.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (resume && session.claudeSessionId) args.push('--resume', session.claudeSessionId);

  // Wire our MCP `ask` tool (B2 inline picker) once the server knows its loopback
  // URL. We write a per-turn config pointing claude at src/mcpAsk.js (stdio), steer
  // the agent to use the tool, and allowlist it so it isn't permission-denied in
  // `default` mode (verified: MCP tools auto-deny headless without this). The
  // sidecar POSTs questions back to BASE_URL and blocks until the user answers.
  let mcpConfigPath = null;
  if (BASE_URL) {
    mcpConfigPath = path.join(os.tmpdir(), `vbrt-mcp-${session.id}.json`);
    try {
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            viberate: { type: 'stdio', command: process.execPath, args: [MCP_ASK_PATH, session.id, BASE_URL] },
          },
        }),
      );
      args.push('--mcp-config', mcpConfigPath);
      args.push('--allowedTools', MCP_ASK_TOOL);
      args.push(
        '--append-system-prompt',
        'When you need a decision, preference, or clarification from the user, call the ' +
          `${MCP_ASK_TOOL} tool — it shows a picker in their UI and returns their answer in the ` +
          'same turn. Do NOT use the built-in AskUserQuestion tool; it cannot be answered here.',
      );
    } catch (e) {
      emit(session, { kind: 'error', message: `failed to write mcp config: ${e.message}` });
      mcpConfigPath = null;
    }
  }

  // Fresh per-turn streaming state (see handleRawEvent / publicView).
  session.streamedText = false;
  session.streamedThinking = false;
  emit(session, { kind: 'user_prompt', text: prompt });
  setStatus(session, 'working');

  // Decide once: did this turn run on the subscription (key stripped) or the
  // API key? Drives both the env and whether we surface a dollar cost — the
  // CLI's total_cost_usd is just a token estimate and is meaningless (you're
  // not charged it) on a subscription, so we hide it there.
  session.onSubscription = hasSubscriptionCreds();

  const env = childEnv(session.onSubscription);
  // Give a human time to answer the MCP `ask` picker: the child's per-tool-call
  // timeout must exceed our server-side ASK_WAIT_MS so our graceful "no answer"
  // result wins over a hard MCP-layer timeout.
  if (mcpConfigPath) env.MCP_TOOL_TIMEOUT = String(MCP_TOOL_TIMEOUT_MS);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: session.cwd,
    // Inherit the server's real environment so the binary picks up the user's
    // actual auth/config — the whole point of Fork A. childEnv() drops the
    // Anthropic API key when a subscription login is on disk so the CLI uses
    // the Max plan rather than billing API credits (the key would otherwise
    // shadow the login). See childEnv / ensureSubscriptionCredentials above.
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  session.child = child;

  child.on('error', (err) => {
    emit(session, { kind: 'error', message: `failed to spawn ${CLAUDE_BIN}: ${err.message}` });
    setStatus(session, 'error');
    session.child = null;
  });

  // Line-buffer stdout and parse each complete JSON line.
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      handleRawEvent(session, obj);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  child.on('close', (code) => {
    if (mcpConfigPath) {
      try { fs.unlinkSync(mcpConfigPath); } catch { /* best effort */ }
    }
    if (buf.trim()) {
      try {
        handleRawEvent(session, JSON.parse(buf.trim()));
      } catch {
        /* trailing partial line; ignore */
      }
    }
    session.child = null;
    if (code !== 0) {
      emit(session, { kind: 'error', message: `claude exited ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}` });
      setStatus(session, session.claudeSessionId ? 'idle' : 'error');
    } else {
      setStatus(session, 'idle');
    }
    emit(session, { kind: 'turn_end', code });
  });

  // One user message, stream-json framed, then close stdin to run the turn.
  const userMsg = { type: 'user', message: { role: 'user', content: prompt } };
  child.stdin.write(JSON.stringify(userMsg) + '\n');
  child.stdin.end();
}

function assertIdleCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');
  let st;
  try {
    st = fs.statSync(cwd);
  } catch {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
}

// --- Public API (the server's thin route layer calls these) ---

// Start a brand-new driven session and kick off its first turn.
export function startSession({ cwd, prompt, permissionMode = 'default' }) {
  assertIdleCwd(cwd);
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
  const session = createSession({ cwd, permissionMode });
  session.title = String(prompt).trim().slice(0, 120);
  runTurn(session, String(prompt), { resume: false });
  return publicView(session);
}

// Send a follow-up message to an existing session (resumes it by id).
export function sendMessage({ id, prompt }) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  if (session.status === 'working' || session.child) throw new Error('session is busy; wait for the current turn to finish');
  if (!session.claudeSessionId) throw new Error('session has no claude id yet; cannot resume');
  runTurn(session, String(prompt), { resume: true });
  return publicView(session);
}

// Kill the active turn, if any. The session record (and its claude id) survives,
// so it can still be resumed later.
export function stopSession({ id }) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  if (session.child) {
    session.child.kill('SIGTERM');
    emit(session, { kind: 'stopped' });
  }
  return publicView(session);
}

// Subscribe to live events. `afterSeq` backfills everything the caller missed
// (SSE reconnects, late joiners). Returns an unsubscribe fn.
export function subscribe(id, onEvent, afterSeq = 0) {
  const session = sessions.get(id);
  if (!session) throw new Error('unknown session');
  for (const e of session.events) if (e.seq > afterSeq) onEvent(e);
  session.subscribers.add(onEvent);
  return () => session.subscribers.delete(onEvent);
}

export function getSession(id) {
  const session = sessions.get(id);
  return session ? publicView(session) : null;
}

export function listSessions() {
  return [...sessions.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicView);
}

function publicView(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    permissionMode: session.permissionMode,
    claudeSessionId: session.claudeSessionId,
    status: session.status,
    title: session.title,
    createdAt: session.createdAt,
    lastEventAt: session.lastEventAt,
    seq: session.seq,
  };
}
