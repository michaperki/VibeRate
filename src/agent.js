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
import { recordLiveVersion } from './harness.js';

const CLAUDE_BIN = process.env.VBRT_CLAUDE_BIN || 'claude';

// Absolute path to our stdio MCP `ask` server (sibling file). claude launches it
// per turn via the --mcp-config we write below.
const MCP_ASK_PATH = fileURLToPath(new URL('./mcpAsk.js', import.meta.url));
const MCP_ASK_TOOL = 'mcp__viberate__ask';
const MCP_REPORT_TOOL = 'mcp__viberate__report';

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

// Optional sink invoked when a driven turn ends with a known claude session id and
// a bound project. It folds the turn's JSONL into that project's store so the
// convo shows up in the Convos rail — the watcher-free ingest path (see
// driveIngest.js / archive/drive-reconciliation/DRIVE_CONVO_INGEST_GAP.md). Injected by the server, which owns
// persistence + classification, so this runtime stays storage-agnostic (mirrors
// setBaseUrl). No-op until set, and only fires for project-bound sessions.
let onTurnIngest = null;
export function setIngestHook(fn) {
  onTurnIngest = fn;
}

// Optional loader that returns the saved transcript for a claude session id (the
// parsed {cwd, title, messages} shape from parsers.parseClaude), or null if no
// JSONL exists on disk. Injected by the server (which owns the storage layout) so
// this runtime stays storage-agnostic — same pattern as setIngestHook. Used by
// adoptSession to revive a session whose in-memory record a redeploy wiped.
let loadTranscript = null;
export function setTranscriptLoader(fn) {
  loadTranscript = fn;
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
  // The turn's child is alive but blocked on the human — surface a real `waiting`
  // lifecycle state (PLAN_COCKPIT.md §3.1) so the cockpit roster can sort
  // needs-attention agents first. Cleared back to `working` when the ask settles.
  setStatus(session, 'waiting');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingAsks.delete(askId)) {
        if (session.child) setStatus(session, 'working'); // unblocked: agent proceeds
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
  if (session) {
    if (session.child) setStatus(session, 'working'); // answered: turn resumes
    emit(session, { kind: 'ask_resolved', askId });
  }
  pending.resolve({ selections: Array.isArray(selections) ? selections : [] });
  return true;
}

// The ground-truth half of session↔plan (PLAN_COCKPIT.md §3.1 tier 2): the driven
// agent self-declaring what it's advancing via our MCP `report` tool. Unlike `ask`
// this is fire-and-forget — it doesn't block on a human, it just stamps the declared
// plan + a short status note on the session, which the cockpit roster prefers over
// the inferred `currentPlan`. Returns a small ack for the sidecar. A blank `plan`
// clears a stale declaration (the agent moved off a plan). Unknown session → ok:false.
export function recordReport(sessionId, report = {}) {
  const session = sessions.get(sessionId);
  if (!session) return { ok: false, error: 'unknown session' };
  if (report.plan !== undefined) {
    const base = report.plan == null ? '' : String(report.plan).trim().split(/[\\/]/).pop();
    session.declaredPlan = base || null;
  }
  if (report.status !== undefined) {
    const note = report.status == null ? '' : String(report.status).trim().slice(0, 200);
    session.declaredNote = note || null;
  }
  session.declaredAt = now();
  emit(session, { kind: 'report', plan: session.declaredPlan, note: session.declaredNote });
  return { ok: true, plan: session.declaredPlan || null, note: session.declaredNote || null };
}

// Where the CLI keeps its config + OAuth credentials. Honors CLAUDE_CONFIG_DIR
// (set to the Fly volume in hosted mode so a refreshed token survives restarts);
// otherwise the usual ~/.claude.
export function claudeConfigDir() {
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
function childEnv(session) {
  const env = { ...process.env };
  if (session && session.onSubscription) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // Hand a driven agent a ready-made live-preview base for its own workspace, so it
  // can show the human files it just built (and `vbrt shot` them) without the
  // commit→push→CI→redeploy round-trip — the /preview/<slug>/<path> route serves
  // straight from this checkout on the shared volume. Absolute only when the public
  // origin is known (VBRT_PUBLIC_URL, set in fly.toml); the slug is always exposed so
  // a local `vbrt serve` agent can still build the relative path.
  if (session && session.projectSlug) {
    env.VBRT_PROJECT_SLUG = session.projectSlug;
    const origin = process.env.VBRT_PUBLIC_URL;
    if (origin) env.VBRT_PREVIEW_BASE = `${origin.replace(/\/+$/, '')}/preview/${session.projectSlug}`;
    // Loopback mirror of the preview base. The public route is admin-gated, and a
    // headless browser carries no admin cookie — so `vbrt shot` rewrites a public
    // preview URL to this loopback origin (which the preview route admits for in-box
    // peers) before navigating. Same file, same shared volume, no 403.
    const port = process.env.PORT || 8080;
    env.VBRT_PREVIEW_LOOPBACK = `http://127.0.0.1:${port}/preview/${session.projectSlug}`;
  }
  // When we already know this turn's claude session id (every resumed/follow-up
  // turn — it's set from the prior turn's init event), hand it to the child as the
  // rail's session id so an in-turn `vbrt shot` binds its artifact to *this*
  // conversation directly, instead of scanning ~/.claude — a path a Drive container
  // on the Fly volume doesn't even have. A brand-new session's first turn doesn't
  // know the id yet at spawn; driveIngest's turn-end sweep binds those after the fact.
  if (session && session.claudeSessionId) {
    env.VBRT_DRIVE_SESSION_ID = `claude-${session.claudeSessionId}`;
  }
  // Per-user GitHub token (ONBOARDING.md Slice 2): when the bound project's owner has
  // connected GitHub, the agent pushes its branches with THEIR token. We override
  // GITHUB_TOKEN for this child only (childEnv already copied process.env), so the
  // existing global credential helper (ensureGitAuth) authenticates as the user
  // instead of the instance. No per-user token → the instance GITHUB_TOKEN stands.
  if (session && session.githubToken) {
    env.GITHUB_TOKEN = session.githubToken;
  }
  return env;
}

// A live note about the box's resources, included in the runtime guidance only when
// something is actually tight — so it's a real warning, not constant noise. The
// daber dogfood OOM'd the container with a full monorepo dev-dep install + Vite +
// headless Chromium on a ~1GB box; this tells the agent, at spawn time, when it
// genuinely can't afford that. statfsSync exists on the node:20-slim runtime.
function boxResourceNote(session) {
  try {
    const freeMb = Math.round(os.freemem() / (1024 * 1024));
    let diskFreeMb = null;
    if (typeof fs.statfsSync === 'function' && session && session.cwd) {
      const s = fs.statfsSync(session.cwd);
      diskFreeMb = Math.round((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
    }
    const tight = freeMb < 300 || (diskFreeMb != null && diskFreeMb < 500);
    if (!tight) return null;
    const have = [`~${freeMb}MB RAM free`];
    if (diskFreeMb != null) have.push(`~${diskFreeMb}MB disk free`);
    return `- HEADS UP — the box is low on resources right now (${have.join(', ')}). Do NOT run a large dependency install or stand up a dev server + headless browser; it can OOM the container. Use $VBRT_PREVIEW_BASE to show/inspect work, and clean up (kill stray servers, drop unneeded node_modules) before any install you can't avoid.`;
  } catch {
    return null;
  }
}

// Repo-agnostic "Drive runtime" guidance appended to a driven turn's system prompt
// (PLAN_DRIVE_RUNTIME_GUIDANCE.md). The runtime injects preview/container *env* into
// every clone, but the *instructions* for using it lived only in VibeRate's own
// CLAUDE.md — so an agent driving a third-party repo inherited the tools yet missed
// the recipe (daber: rebuilt a preview server from scratch, never touched
// $VBRT_PREVIEW_BASE or `vbrt shot`, and OOM'd the box). This makes the guidance
// travel with the runtime instead of the repo. Gated to the hosted box (VBRT_HOSTED):
// a local `vbrt serve` agent runs on the user's own machine where these container
// facts (node:20-slim, no python, port 8080 taken) are wrong and their own CLAUDE.md
// already applies. Kept tight — it rides every turn's system prompt.
function driveRuntimeGuidance(session) {
  if (process.env.VBRT_HOSTED !== '1') return null;
  const lines = [
    'DRIVE RUNTIME — you are a coding agent inside VibeRate Drive: a fresh clone on a small hosted container (node:20-slim), not a full dev box. Operational facts that may NOT be in this repo\'s own docs:',
    '- Show the human what you built WITHOUT shipping it: any file you write in this workspace is served live at $VBRT_PREVIEW_BASE/<path> (that env var is already set) — zero commit/push/redeploy. Hand them that URL for any prototype, mock, or page. Only commit+push when the change is meant to ship.',
    '- See your OWN UI work — you are headless and cannot refresh the app the human sees: preview the page at $VBRT_PREVIEW_BASE/<path>, screenshot it with the baked-in Playwright Chromium, and Read the PNG to inspect real pixels. `vbrt shot` is on-request ONLY and just prints a confirmation — it does NOT return the image, so never run it to see your own work.',
    '- Container: `python` is ABSENT — parse JSON/JSONL and write scripts in `node`. Port 8080 is taken by the server you are running inside — use another port or skip a local server. `curl`, `jq`, `gh`, `ffmpeg`, and Playwright are installed.',
    '- Resources are tight (~1GB RAM + disk): prefer $VBRT_PREVIEW_BASE over standing up a second dev server, and skip large installs you don\'t need — a full dev-dep install + dev server + headless browser can OOM the box.',
  ];
  try {
    if (session && session.cwd && fs.existsSync(path.join(session.cwd, 'package.json'))) {
      lines.push('- This is a Node/npm project: if deps are missing run `npm install` once (node_modules isn\'t committed). NODE_ENV may be `production`, which makes npm OMIT devDependencies — so if a build/dev tool (vite, ts-node, typescript, a bundler) is missing, reinstall with `npm install --include=dev`.');
    }
  } catch {
    /* fs probe is best-effort; omit the npm note if we can't tell */
  }
  const resourceNote = boxResourceNote(session);
  if (resourceNote) lines.push(resourceNote);
  return lines.join('\n');
}

// Permission modes we let the UI pick. `default` denies edit/exec without an
// approval channel (which we don't have yet) — safe but limited. The others are
// deliberate opt-ins the user selects per session, with `bypassPermissions` the
// only one that lets the agent act freely (hence the extra dangerous flag).
const PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

const MAX_EVENTS = Number(process.env.VBRT_AGENT_MAX_EVENTS || 2000);

// Context-window size for a model id — 1M for the [1m]/-1m long-context builds,
// 200k otherwise. Mirrors the client's driveCtxWindow (public/app.js) so the
// denormalized ctx% on the roster payload matches the per-session pill exactly.
function windowOf(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('[1m]') || m.includes('-1m') ? 1_000_000 : 200_000;
}

// One tool call → a compact {verb,label} for the cockpit roster's "current task"
// line, so the list endpoint carries the agent's last action without a client
// having to hold a per-session SSE just to read it. Verb mapping mirrors the live
// brain's verbFor (read/edit/write/run/plan); the label is the touched file's
// basename when there is one, else the bare tool name.
function summarizeAction(name, input) {
  const n = String(name || '').toLowerCase();
  let verb = 'read';
  if (/update_plan|todowrite|exit_plan|plan_mode/.test(n)) verb = 'plan';
  else if (/write|create/.test(n)) verb = 'write';
  else if (/edit|apply_patch|patch|notebook|multiedit/.test(n)) verb = 'edit';
  else if (/bash|exec|shell|\brun\b|command|terminal/.test(n)) verb = 'run';
  const file = input && (input.file_path || input.path || input.notebook_path);
  const label = file ? String(file).split(/[\\/]/).pop() : (name || 'tool');
  return { verb, label, file: file ? String(file) : null };
}

// The free half of session↔plan (PLAN_COCKPIT.md §3.1, tier 1): name the plan an
// agent is advancing from the files it touches, no self-report needed. Any PLAN-ish
// markdown the agent reads/edits (PLAN_*.md, *_PLAN.md) counts; returns the basename
// or null. Sticky on the session, so it survives the agent moving on to edit code.
function planDocOf(file) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop();
  return /plan/i.test(base) && /\.md$/i.test(base) ? base : null;
}

// Fold a raw Anthropic usage blob into the session's denormalized context meter.
// The input side (fresh + both cache buckets) is the context the model actually
// saw — the same sum the per-session pill shows (driveUpdateCtx).
function recordUsage(session, usage) {
  if (!usage) return;
  const ctx = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  if (!ctx) return;
  session.ctxTokens = ctx;
  session.ctxPct = Math.min(100, Math.round((ctx / windowOf(session.model)) * 100));
}

// In-memory registry of sessions this process owns. Lives only as long as the
// server does; the durable record is the JSONL the spawned binary writes.
const sessions = new Map();

function now() {
  return Date.now();
}

// Roster-level subscribers (PLAN_COCKPIT.md §3.1c — the project-scoped aggregate
// stream that replaces the cockpit's 2.5 s poll). One channel fans every session's
// roster-relevant change into the cockpit "Now" zone, so its timers/ctx meters tick
// live without re-fetching the whole list. Only roster-shaped events fire it
// (status, action, usage, plan, lifecycle) — the chatty per-token text/thinking
// deltas are deliberately excluded so a turn doesn't spam a frame per token.
const rosterSubs = new Set();
const ROSTER_KINDS = new Set([
  'status', 'tool_use', 'usage', 'report', 'user_prompt', 'result', 'turn_end', 'system', 'error', 'stopped',
]);
export function subscribeRoster(onMsg) {
  rosterSubs.add(onMsg);
  return () => rosterSubs.delete(onMsg);
}
function notifyRoster(session) {
  if (!rosterSubs.size) return;
  // A session ended mid-turn (endSession deleted it) still has a live child whose
  // close handler emits trailing status events through the captured reference. Those
  // must not resurrect the agent on the roster, so push only for the *registered*
  // session — a deleted/replaced one is silent.
  if (sessions.get(session.id) !== session) return;
  const view = publicView(session); // hoisted function declaration
  for (const fn of rosterSubs) {
    try { fn({ kind: 'agent', session: view }); } catch { /* a broken roster sub must not break emit */ }
  }
}
function notifyRosterRemoved(id) {
  for (const fn of rosterSubs) {
    try { fn({ kind: 'removed', id }); } catch { /* ignore */ }
  }
}

// One driven session: a stable local id, the claude session id once we learn it,
// a capped event log for SSE backfill, and a set of live subscribers.
function createSession({ cwd, permissionMode, projectSlug = null, githubToken = null }) {
  const id = randomUUID();
  const session = {
    id,
    cwd,
    permissionMode,
    projectSlug, // bound project (if any); drives the turn-end ingest into the rail
    githubToken, // decrypted per-user GitHub token for clone/push (Slice 2); never serialized to the client
    claudeSessionId: null, // filled from the first `system/init` event
    status: 'starting', // starting | working | waiting | idle | exited | error
    createdAt: now(),
    lastEventAt: now(),
    title: null, // first user prompt, for the session list
    // Cockpit roster fields (PLAN_COCKPIT.md §3.1): denormalized onto publicView so
    // the "Now" zone can render a live per-agent row off the one-shot list endpoint —
    // no per-session SSE required. type is fixed today (Drive only spawns claude).
    type: 'claude',
    model: null, // from the first system/init event
    harnessVersion: null, // CLI version announced in system/init (WS1) — for the harness rail
    promptStartedAt: null, // turn-start stamp → the roster's ticking elapsed timer
    lastAction: null, // { verb, label, file } — the agent's most recent tool call
    currentPlan: null, // PLAN-ish doc basename the agent is advancing (planDocOf, sticky)
    declaredPlan: null, // plan the agent self-reported via the MCP `report` tool (tier 2)
    declaredNote: null, // short status note from the same self-report
    declaredAt: 0, // when the agent last self-reported
    ctxTokens: 0, // live context-window fill (input side), from interim usage
    ctxPct: 0, // ctxTokens / windowOf(model), 0–100
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
  notifyRoster(session); // a brand-new agent shows on the cockpit roster immediately
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
  // Push a fresh roster view to the aggregate stream on roster-shaped events only.
  if (ROSTER_KINDS.has(event.kind)) notifyRoster(session);
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
    if (obj.model) session.model = obj.model; // window size for the roster ctx meter
    // The running CLI announces its version here (PLAN_HARNESS_VERSIONING.md WS1) —
    // we used to discard it. Stash it on the session for the roster/cockpit and feed
    // the harness module so the rail can corroborate "what's running" and catch a
    // binary swapped under a long-lived server. Field name has drifted across
    // releases, so probe the known spellings.
    const ver = obj.version || obj.cli_version || obj.claude_code_version || (obj.cli && obj.cli.version) || null;
    if (ver) {
      session.harnessVersion = String(ver);
      recordLiveVersion(session.type || 'claude', session.harnessVersion);
    }
    emit(session, {
      kind: 'system',
      sessionId: obj.session_id || null,
      model: obj.model || null,
      version: session.harnessVersion || null,
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
    } else if (e.type === 'message_start' && e.message && e.message.usage) {
      // Interim usage: every model call in a turn's tool loop opens a fresh
      // `message_start` whose input-side usage (fresh + cache) is the context that
      // call actually saw — i.e. the live context-window fill, growing as the turn
      // accretes tool output. Surface it so the gauge climbs mid-turn instead of
      // only snapping at the end-of-turn `result` (the staleness we were chasing).
      // Output tokens are still a placeholder at message_start; the context meter
      // only reads the input side, so that's fine.
      //
      // BUT: a Task sub-agent runs its own tool loop, and each of its calls opens a
      // message_start carrying the *sub-agent's* (much smaller) context. Surfacing
      // those made the main pill lurch down then snap back up mid-turn — the "bounce"
      // bug. The stream-json line tags sub-agent events with parent_tool_use_id; only
      // the main agent's calls (no parent) reflect the real window fill, so gate on it.
      if (!obj.parent_tool_use_id) { recordUsage(session, e.message.usage); emit(session, { kind: 'usage', usage: e.message.usage }); }
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
      } else if (block.type === 'tool_use') {
        session.lastAction = summarizeAction(block.name, block.input || {});
        const plan = planDocOf(session.lastAction.file);
        if (plan) session.currentPlan = plan; // sticky: last plan touched wins
        emit(session, { kind: 'tool_use', id: block.id || null, name: block.name, input: block.input || {} });
      }
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
        emit(session, { kind: 'tool_result', toolUseId: block.tool_use_id || null, isError: !!block.is_error, text: text.slice(0, 4000) });
      }
    }
    return;
  }

  if (type === 'result') {
    // NB: do NOT feed obj.usage into the context meter. The `result` event's usage is
    // the *cumulative* total for the whole turn — input_tokens summed across every
    // model call in the tool loop — so on a long turn it's many times the window (e.g.
    // 4M against a 200k window → a bogus "100% full"). The real context-window fill is
    // the per-call input usage from `message_start` (recordUsage at the interim branch
    // above); the last such event of the turn already left the meter at the true
    // high-water mark. We still forward obj.usage below for the turn footer/cost, which
    // legitimately wants the cumulative throughput.
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
      // Token usage for the turn footer/summary. The CLI reports it under `usage`
      // (input/output + cache buckets); forward it whole so the UI can show output
      // tokens regardless of billing mode (it's metering, not a charge).
      usage: obj.usage || null,
    });
    return;
  }

  // Auto-compaction: when the window fills, the CLI compacts the transcript and
  // emits a system event for the boundary. We otherwise drop every non-init system
  // subtype into `raw` (unrendered), so a compaction used to vanish silently — and
  // the context pill would lurch down with no explanation. Surface it as a note so
  // the transcript shows where history was summarised and the pill drop has a cause.
  if (type === 'system' && typeof obj.subtype === 'string' && obj.subtype.includes('compact')) {
    const trigger = (obj.compact_metadata && obj.compact_metadata.trigger) || obj.trigger || null;
    emit(session, { kind: 'note', text: `⊟ context auto-compacted${trigger ? ` (${trigger})` : ''} — earlier history was summarised to free up the window.` });
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
  const appendPrompts = [];
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
      args.push('--allowedTools', `${MCP_ASK_TOOL},${MCP_REPORT_TOOL}`);
      appendPrompts.push(
        'When you need a decision, preference, or clarification from the user, call the ' +
          `${MCP_ASK_TOOL} tool — it shows a picker in their UI and returns their answer in the ` +
          'same turn. Do NOT use the built-in AskUserQuestion tool; it cannot be answered here.\n' +
          `When you start advancing a specific plan doc (a PLAN_*.md) or change which one you're on, ` +
          `call the ${MCP_REPORT_TOOL} tool with { plan: "<PLAN_FILE.md>", status: "<short note of what ` +
          `you're doing>" }. It returns instantly (no human wait) and lets the person watching the ` +
          `cockpit see which plan you're driving and your progress. Re-report when the plan or focus changes.`,
      );
    } catch (e) {
      emit(session, { kind: 'error', message: `failed to write mcp config: ${e.message}` });
      mcpConfigPath = null;
    }
  }
  // Make the Drive runtime guidance travel with the runtime, not the repo
  // (PLAN_DRIVE_RUNTIME_GUIDANCE.md): a clone of someone else's repo gets the
  // preview/container env but not the instructions, which only ever lived in
  // VibeRate's own CLAUDE.md. Appended alongside the MCP guidance as one flag.
  const runtimeGuidance = driveRuntimeGuidance(session);
  if (runtimeGuidance) appendPrompts.push(runtimeGuidance);
  if (appendPrompts.length) args.push('--append-system-prompt', appendPrompts.join('\n\n'));

  // Fresh per-turn streaming state (see handleRawEvent / publicView).
  session.streamedText = false;
  session.streamedThinking = false;
  // Stamp the turn start so the cockpit roster's elapsed timer ticks from a real
  // anchor; clear the prior action so the row reads "thinking…" until the first tool.
  session.promptStartedAt = now();
  session.lastAction = null;
  emit(session, { kind: 'user_prompt', text: prompt });
  setStatus(session, 'working');

  // Decide once: did this turn run on the subscription (key stripped) or the
  // API key? Drives both the env and whether we surface a dollar cost — the
  // CLI's total_cost_usd is just a token estimate and is meaningless (you're
  // not charged it) on a subscription, so we hide it there.
  session.onSubscription = hasSubscriptionCreds();

  const env = childEnv(session);
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

    // Fold this turn's transcript into its bound project so the convo lands in the
    // rail. The CLI wrote a durable JSONL as a side effect; in hosted Drive nothing
    // else ever ingests it (no watcher on the volume — archive/drive-reconciliation/DRIVE_CONVO_INGEST_GAP.md).
    // Best-effort and detached: a failure here must never affect the turn.
    if (onTurnIngest && session.projectSlug && session.claudeSessionId) {
      Promise.resolve(
        onTurnIngest({ projectSlug: session.projectSlug, claudeSessionId: session.claudeSessionId }),
      ).catch(() => { /* ingest is opportunistic; the JSONL stays on disk regardless */ });
    }
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
export function startSession({ cwd, prompt, permissionMode = 'default', projectSlug = null, githubToken = null }) {
  assertIdleCwd(cwd);
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
  const session = createSession({ cwd, permissionMode, projectSlug, githubToken });
  session.title = String(prompt).trim().slice(0, 120);
  runTurn(session, String(prompt), { resume: false });
  return publicView(session);
}

// Re-adopt a session whose in-memory record was lost to a server restart /
// redeploy, rebinding the durable claude session id so it can keep going. This is
// the `/resume` analogue: the claude transcript on disk is the source of truth, so
// we recreate a fresh local handle around the same claudeSessionId, replay the
// saved transcript into the event log (so a reconnecting client's after=0 backfill
// shows the prior conversation, not an empty window), and leave it idle — the next
// message resumes via `claude --resume`. Idempotent: if a live session already
// wraps this claude id (e.g. a same-process reload raced us), return it instead of
// minting a duplicate. Refuses ids with no transcript on disk (nothing to revive).
export async function adoptSession({ claudeSessionId, cwd, projectSlug = null, permissionMode = 'default', githubToken = null }) {
  if (!claudeSessionId || typeof claudeSessionId !== 'string') throw new Error('claudeSessionId is required');
  if (!PERMISSION_MODES.has(permissionMode)) throw new Error(`unknown permission mode: ${permissionMode}`);
  for (const s of sessions.values()) {
    if (s.claudeSessionId === claudeSessionId) return publicView(s);
  }
  // Load the saved transcript first: it both proves the session is real (we won't
  // adopt an id with no JSONL) and supplies the cwd when the caller's reload didn't
  // carry one across.
  let transcript = null;
  if (loadTranscript) {
    try { transcript = await loadTranscript(claudeSessionId); } catch { transcript = null; }
  }
  if (!transcript) throw new Error('no saved transcript for that session; cannot resume');
  const workdir = cwd || transcript.cwd || null;
  assertIdleCwd(workdir);
  const session = createSession({ cwd: workdir, permissionMode, projectSlug, githubToken });
  session.claudeSessionId = claudeSessionId;
  session.status = 'idle';
  session.title = transcript.title || null;
  const messages = Array.isArray(transcript.messages) ? transcript.messages : [];
  for (const m of messages) {
    if (m.kind === 'text' && m.role === 'user') { if (m.text && m.text.trim()) emit(session, { kind: 'user_prompt', text: m.text }); }
    else if (m.kind === 'text' && m.role === 'assistant') { if (m.text) emit(session, { kind: 'assistant_text', text: m.text }); }
    else if (m.kind === 'thinking') { if (m.text) emit(session, { kind: 'thinking', text: m.text }); }
    else if (m.kind === 'tool_use') emit(session, { kind: 'tool_use', name: m.name, input: m.input || {} });
    else if (m.kind === 'tool_result') emit(session, { kind: 'tool_result', isError: false, text: String(m.text || '') });
  }
  // Re-seed the context pill. The replayed transcript carries per-assistant usage,
  // but adopt emits no system/usage event of its own, so a reconnecting client's
  // gauge would start blank and — with no model in hand — default to a 200k window,
  // mis-reading a [1m] session as ~5× fuller than it is (the "resume drift" bug).
  // Replay the last known usage and its model so the pill shows the real fill the
  // moment you return, before the next turn produces fresh numbers.
  let lastUsage = null;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].usage) { lastUsage = messages[i].usage; break; } }
  if (lastUsage) {
    if (lastUsage.model) { session.model = lastUsage.model; emit(session, { kind: 'system', model: lastUsage.model }); }
    // parseClaude normalises usage to {input,cacheRead,cacheCreate,...}; the live
    // pill (driveUpdateCtx) reads the raw Anthropic token keys, so map it back.
    const usage = {
      input_tokens: lastUsage.input || 0,
      cache_read_input_tokens: lastUsage.cacheRead || 0,
      cache_creation_input_tokens: lastUsage.cacheCreate || 0,
      output_tokens: lastUsage.output || 0,
    };
    recordUsage(session, usage); // so the cockpit roster shows the real fill on return
    emit(session, { kind: 'usage', usage });
  }
  emit(session, { kind: 'note', text: '↩ reconnected to your earlier session — continue the conversation below.' });
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

// End a session for good and drop it from the live roster — the cockpit's "swipe to
// end" (there's no terminal ctrl-c / `/exit` on a phone, so without this the roster
// just accretes idle agents until a redeploy wipes the Map). Non-destructive to
// history: the claude transcript stays on disk (re-adoptable) and the conversation
// is already ingested into the project rail; this only removes the live handle. Kills
// any in-flight turn first. Unknown id is a no-op ack so a double-swipe can't error.
export function endSession({ id }) {
  const session = sessions.get(id);
  if (!session) return { ok: true, id, ended: false };
  if (session.child) {
    try { session.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  sessions.delete(id);
  notifyRosterRemoved(id);
  return { ok: true, id, ended: true };
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
    projectSlug: session.projectSlug,
    permissionMode: session.permissionMode,
    claudeSessionId: session.claudeSessionId,
    status: session.status,
    title: session.title,
    createdAt: session.createdAt,
    lastEventAt: session.lastEventAt,
    seq: session.seq,
    // Cockpit roster enrichment (PLAN_COCKPIT.md §3.1).
    type: session.type || 'claude',
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

// Test-only: replay a list of raw stream-json objects through the real event
// normalizer (`handleRawEvent`) against a *detached* session — one that's never
// registered in the `sessions` map and so never touches the roster — and return
// the emitted UI events. The WS3 smoke gate (PLAN_HARNESS_VERSIONING.md) uses this
// to assert the schema we parse still holds after a harness update, exercising the
// load-bearing agent.js path (init / stream_event / assistant / result) without
// spawning a real `claude`. Not part of the runtime control flow.
export function __replayForTest(objs) {
  const session = {
    id: '__test__', type: 'claude', seq: 0, events: [], subscribers: new Set(),
    status: 'starting', model: null, harnessVersion: null, claudeSessionId: null,
    lastAction: null, currentPlan: null, onSubscription: false,
    streamedText: false, streamedThinking: false, ctxTokens: 0, ctxPct: 0, lastEventAt: 0,
  };
  for (const obj of Array.isArray(objs) ? objs : []) handleRawEvent(session, obj);
  return { events: session.events, session };
}
