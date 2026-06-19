#!/usr/bin/env node
// Heavy deps (@inquirer/prompts, express) are loaded lazily inside the commands
// that need them, so `vbrt push` runs with only Node builtins + fetch — which is
// what lets the skill bundle ship without node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverSessions } from '../src/discover.js';
import { parseClaude, parseCodex } from '../src/parsers.js';
import { saveBundle } from '../src/storage.js';
import { extractGit, extractDocHistory } from '../src/git.js';
import { extractDocsMulti } from '../src/docs.js';
import { extractMemory } from '../src/workspace.js';
import { readEvidence, recordShot, captureCapabilities, installCapture } from '../src/evidence.js';
import { buildBundle } from '../src/bundle.js';
import { pushBundle, apiBase, resolveApi, login, flushOutbox, outboxCount, publishProject, saveProjectRef, loadProjectRef } from '../src/push.js';
import { redactBundle } from '../src/redact.js';
import { recordHookFromStdin, readStream, streamSignature } from '../src/hooks.js';
import { slugify, claudeRoots, codexRoots, canonicalKey } from '../src/paths.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function fmtDate(iso) {
  if (!iso) return '????-??-??';
  return iso.slice(0, 16).replace('T', ' ');
}

// ---------- `vbrt watch --tui`: live agent dashboard in the terminal ----------
// A dependency-free ANSI redraw over data the watcher already has — the hook
// stream (`.vbrt/stream.jsonl`, zero token cost) + discovered sessions — so the
// watch terminal stops being the blindest seat. See LIVE_ORCHESTRATION.md §8.

const reAnsi = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s) => String(s).replace(reAnsi, '');
const visLen = (s) => stripAnsi(s).length;
// Pad/truncate to a visible width, ANSI-aware (color codes have zero display width).
function fit(s, w) {
  const v = visLen(s);
  if (v === w) return s;
  if (v < w) return s + ' '.repeat(w - v);
  // truncate to w-1 visible chars + ellipsis, preserving no partial escape (we only
  // truncate plain strings in practice, so a simple slice on the stripped form is safe)
  return stripAnsi(s).slice(0, Math.max(0, w - 1)) + '…';
}
function bar(pct, width = 16) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const fill = Math.round((p / 100) * width);
  const color = p >= 85 ? C.yellow : C.green;
  return color('█'.repeat(fill)) + C.dim('░'.repeat(width - fill));
}
const ktok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
// Coarse "how long since this agent last moved" — the signal the user reads to tell a
// genuinely-idle live session from one whose terminal was killed mid-action.
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}
const shortModel = (m) => String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '') || '—';
const shortSid = (s) => (s ? String(s).slice(0, 6) : '—');
const agentTint = (src) => (src === 'codex' ? C.yellow : C.cyan);

// Collapse the merged event stream into one state object per agent (`sid`). Events
// with no sid (hooks pre-`sid`, or none installed) fold into a single "agent" panel.
function agentsFromStream(events, now) {
  const byId = new Map();
  for (const e of events) {
    const id = e.sid || '_';
    let a = byId.get(id);
    if (!a) { a = { sid: e.sid || null, last: 0, ev: null, action: null, ctxPct: null, ctx: null, model: null }; byId.set(id, a); }
    if (e.t >= a.last) { a.last = e.t; a.ev = e.ev; }
    if (e.ev === 'tool' && (e.verb || e.target)) a.action = `${e.verb || 'using'}${e.target ? ' ' + e.target : ''}`;
    if (e.ev === 'prompt') a.action = 'reading your prompt';
    if (typeof e.ctxPct === 'number') { a.ctxPct = e.ctxPct; a.ctx = e.ctx; a.model = e.model || a.model; }
  }
  for (const a of byId.values()) {
    const age = now - a.last;
    // `ended` = a SessionEnd hook fired (graceful close) → auto-hidden by visibleAgents.
    // `idle` = finished a turn (Stop) but session still open. working/paused split on recency.
    a.status = a.ev === 'end' ? 'ended' : a.ev === 'idle' ? 'idle' : age < 12000 ? 'working' : 'paused';
  }
  return [...byId.values()].sort((x, y) => y.last - x.last);
}

// Codex has no hook sidecar: its rollout JSONL is itself the live event stream.
// `cmdWatch` refreshes compact parse snapshots only when a rollout file changes;
// adapt those snapshots to the same panel shape as Claude hook agents.
function agentsFromCodex(states, now) {
  const out = [];
  for (const s of states.values()) {
    const live = s.live || {};
    const last = Date.parse(live.ts || s.endedAt || '') || 0;
    if (!last || now - last > 10 * 60 * 1000) continue; // don't resurrect old rollouts
    const age = now - last;
    const status = live.state === 'idle' ? 'idle' : age < 12000 ? 'working' : 'paused';
    const action = live.action ? `${live.action.verb || 'using'}${live.action.label ? ' ' + live.action.label : ''}` : null;
    out.push({
      sid: s.id,
      source: 'codex',
      last,
      ev: live.state === 'idle' ? 'idle' : 'tool',
      action,
      ctxPct: live.ctxPct,
      ctx: live.ctx,
      model: live.model,
      status,
    });
  }
  return out;
}

// The panels the TUI actually draws: every agent in the stream window minus the ones
// gracefully ended or hand-dismissed. A dismissal is keyed by sid + timestamp, so a
// dismissed session that *moves again* (a newer event than the dismissal) reappears —
// hand-clearing a session that turns out to be alive is self-correcting.
function visibleAgents(st, now, codexStates) {
  return [...agentsFromStream(st.events, now), ...agentsFromCodex(codexStates, now)]
    .sort((a, b) => b.last - a.last)
    .filter((a) => {
      if (a.status === 'ended') return false;
      const d = st.dismissed && st.dismissed[a.sid || '_'];
      return !(d != null && a.last <= d);
    });
}

// Build the full frame as an array of lines (no I/O), so it's easy to reason about
// and test by eye. `st` carries live watch state; `sessions` maps sid→source.
function tuiFrame(st, sessions, codexStates = new Map()) {
  const now = Date.now();
  const W = Math.max(48, Math.min((process.stdout.columns || 80), 100));
  const inner = W - 4; // content width inside "│ … │"
  const srcOf = (sid) => {
    if (!sid) return 'claude';
    const m = sessions.find((s) => path.basename(s.file, '.jsonl').startsWith(sid) || sid.startsWith(path.basename(s.file, '.jsonl').slice(0, 6)));
    return m ? m.source : 'claude';
  };
  const top = (label) => C.dim('┌─ ') + label + C.dim(' ' + '─'.repeat(Math.max(0, W - 5 - visLen(label))) + '┐');
  const mid = (s) => C.dim('│ ') + fit(s, inner) + C.dim(' │');
  const bot = C.dim('└' + '─'.repeat(W - 2) + '┘');

  const upMs = now - st.startedAt;
  const upM = Math.floor(upMs / 60000), upS = Math.floor((upMs % 60000) / 1000);
  const lines = [];
  lines.push(`${C.green('👁  vbrt watch')}  ${C.dim('·')}  ${C.cyan(st.cwd)}`);
  lines.push(`${C.dim('→')} ${st.url ? C.cyan(st.url) : C.dim('(publishing — link appears after first push)')}  ${C.dim(`· up ${upM}m${String(upS).padStart(2, '0')}s`)}`);
  lines.push(`${st.hooks ? C.green('● hooks live') : C.yellow('○ no hooks')} ${C.dim(st.hooks ? '(real-time)' : '— run `vbrt hooks --install` for real-time; showing log-tail lag')}`);
  lines.push('');

  const agents = visibleAgents(st, now, codexStates);
  st.visible = agents.map((a) => a.sid || '_'); // index→sid map for number-key dismissal
  if (!agents.length) {
    lines.push(top(C.dim('agents')));
    lines.push(mid(C.dim('no agent activity yet — start a session in this repo')));
    lines.push(bot);
  }
  agents.forEach((a, i) => {
    const src = a.source || srcOf(a.sid);
    const dot = a.status === 'working' ? C.green('●') : a.status === 'paused' ? C.yellow('◐') : C.dim('○');
    const word = a.status === 'working' ? C.green('working') : a.status === 'paused' ? C.yellow('paused') : C.dim('idle');
    const num = i < 9 ? C.dim(`[${i + 1}]`) : C.dim('[·]'); // only 1–9 are dismiss-able by key
    const label = `${num} ${agentTint(src)(src)} ${C.dim('· ' + shortSid(a.sid))}  ${dot} ${word} ${C.dim('· ' + ago(now - a.last) + ' ago')}`;
    lines.push(top(label));
    lines.push(mid(a.action ? a.status === 'working' ? a.action : C.dim(a.action) : C.dim('—')));
    const gauge = a.ctxPct != null
      ? `${C.dim('ctx')} ${bar(a.ctxPct)} ${a.ctxPct}%  ${C.dim('·')}  ${ktok(a.ctx)} tok  ${C.dim('·')}  ${C.dim(shortModel(a.model))}`
      : C.dim('ctx —  (no context reading yet)');
    lines.push(mid(gauge));
    lines.push(bot);
  });
  lines.push('');
  const push = st.lastPush
    ? `${C.dim('last push')} ${new Date(st.lastPush.t).toLocaleTimeString()} ${C.dim('·')} ${st.lastPush.kind} ${C.dim('·')} ${st.lastPush.count} session(s)`
    : C.dim('last push — none yet');
  const q = st.queued ? C.yellow(`· ${st.queued} queued`) : '';
  lines.push(`${push} ${q}`);
  lines.push(C.dim(agents.length ? '[1–9] dismiss a dead panel · Ctrl-C to stop' : 'Ctrl-C to stop'));
  return lines;
}

function paintFrame(lines) {
  // Home, repaint each line clearing to EOL, then clear the rest of the screen —
  // avoids the full-clear flicker of \x1b[2J on every tick.
  let out = '\x1b[H';
  for (const ln of lines) out += ln + '\x1b[K\n';
  out += '\x1b[J';
  process.stdout.write(out);
}

const AGENT_DOCS = ['soul.md', 'agents.md', 'agent.md', 'claude.md', 'claude.local.md', 'seed.md', 'context.md', 'memory.md', 'backlog.md', 'decisions.md', 'attempts.md', 'log.md', 'roadmap.md', 'project.md', 'tasks.md'];
const BRAINISH = /soul|agents?|claude|seed|roadmap|backlog|tasks|memory|context|decisions|attempts|plan|stream|_next_pass/i;

function bytesOf(obj) {
  return Buffer.byteLength(JSON.stringify(obj), 'utf8');
}

function mb(n) {
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function printDryRun(bundle, { includeMemory, isPublic }) {
  const safe = redactBundle(bundle);
  const docs = safe.docs && safe.docs.docs ? safe.docs.docs : [];
  const evidence = safe.evidence || [];
  const imageBytes = evidence.reduce((sum, e) => {
    const img = String((e && e.image) || '');
    const b64 = img.includes(',') ? img.split(',').pop() : img;
    return sum + Math.floor((b64.length * 3) / 4);
  }, 0);
  const messages = safe.sessions.reduce((n, s) => n + ((s.messages && s.messages.length) || 0), 0);
  const memoryNotes = safe.memory && Array.isArray(safe.memory.notes) ? safe.memory.notes.length : 0;
  console.log(C.green('\n✓ Dry run complete — nothing uploaded.'));
  console.log(`  Visibility: ${isPublic ? C.yellow('public on push') : 'private by default'}`);
  console.log(`  Redacted payload: ${mb(bytesOf(safe))}`);
  console.log(`  Sessions: ${safe.sessions.length} (${messages} message(s))`);
  console.log(`  Git commits: ${safe.git && safe.git.commits ? safe.git.commits.length : 0}`);
  console.log(`  Brain docs/files included: ${docs.length}${docs.length ? ` — ${docs.map((d) => d.name).slice(0, 12).join(', ')}${docs.length > 12 ? ', …' : ''}` : ''}`);
  console.log(`  Memory: ${includeMemory ? `${memoryNotes} note(s)` : 'excluded (--no-memory)'}`);
  console.log(`  Evidence: ${evidence.length} item(s), ${mb(imageBytes)} image data`);
  console.log(C.dim('  Review the counts above before publishing. Re-run without --dry-run to upload.'));
}

// Assemble the full capture bundle from a cwd + its (already-parsed) sessions:
// git history, agent docs, per-brain-doc version history, and memory. Shared by
// `vbrt add`/`push` and `vbrt watch`.
async function assembleBundle(cwd, sessions, parsed, { includeMemory = true } = {}) {
  // The repo may live at a different path than cwd (/home vs /mnt/c); merge git
  // across every cwd seen in the sessions, deduping commits by hash.
  const repoPaths = [...new Set([cwd, ...sessions.map((s) => s.cwd).filter(Boolean)])];
  const seen = new Set();
  const commits = [];
  let gitCwd = null;
  for (const p of repoPaths) {
    const g = await extractGit(p);
    if (!g) continue;
    if (!gitCwd) gitCwd = g.cwd;
    for (const c of g.commits) if (!seen.has(c.hash)) { seen.add(c.hash); commits.push(c); }
  }
  commits.sort((a, b) => b.t - a.t);

  const docs = extractDocsMulti(repoPaths);
  const brainBasenames = new Set([...docs.map((d) => d.name.split('/').pop().toLowerCase()), ...AGENT_DOCS]);
  for (const c of commits) for (const d of c.docs || []) {
    const base = d.name.split('/').pop();
    if (d.status === 'deleted' && BRAINISH.test(base)) brainBasenames.add(base.toLowerCase());
  }
  const docHistory = gitCwd && commits.length ? await extractDocHistory(gitCwd, commits, brainBasenames) : null;
  const memory = includeMemory ? extractMemory(cwd) : null;
  const evidence = readEvidence(cwd); // author-captured screenshots/gifs (full set each push)
  const stream = readStream(cwd, 40); // real-time hook events (working/idle, current action, ctx)

  const bundle = buildBundle(cwd, {
    sessions: parsed,
    git: commits.length ? { cwd, capturedAt: new Date().toISOString(), commits } : null,
    docs,
    docHistory,
    memory,
    evidence,
    stream,
  });
  return { bundle, commits, docs, memory, evidence, repoPaths };
}

// A cheap fingerprint of the repo's live inputs — agent-doc mtimes/sizes, git
// HEAD/index, and the session logs' mtimes/sizes — so `vbrt watch` can tell when
// the brain *or the live conversation* changed. (Statting the cached session-file
// list is cheap; the list itself is re-discovered periodically.)
function watchSignature(repoPaths, sessionFiles = []) {
  const parts = [];
  for (const d of extractDocsMulti(repoPaths)) parts.push(`${d.name}:${Math.floor(d.mtime || 0)}:${d.bytes || 0}`);
  for (const p of repoPaths) {
    for (const f of ['HEAD', 'index']) {
      try { parts.push(`${f}:${Math.floor(fs.statSync(path.join(p, '.git', f)).mtimeMs)}`); } catch { /* not a repo / no file */ }
    }
  }
  for (const f of sessionFiles) {
    try { const st = fs.statSync(f); parts.push(`s:${f}:${Math.floor(st.mtimeMs)}:${st.size}`); } catch { /* gone */ }
  }
  // Real-time hook stream: a hook append should trigger a push just like a doc edit.
  for (const p of repoPaths) parts.push(`${p}|${streamSignature(p)}`);
  return parts.sort().join('|');
}

// New Codex rollouts are created under sessions/YYYY/MM/DD. Stat only today's
// directory chain (local + UTC, plus yesterday for midnight edges) so a new file
// triggers immediate rediscovery without recursively scanning hundreds of old
// rollouts every second.
function codexStoreSignature(now = new Date()) {
  const days = [];
  for (const base of [new Date(now), new Date(now.getTime() - 24 * 3600 * 1000)]) {
    days.push([String(base.getFullYear()), String(base.getMonth() + 1).padStart(2, '0'), String(base.getDate()).padStart(2, '0')]);
    days.push([String(base.getUTCFullYear()), String(base.getUTCMonth() + 1).padStart(2, '0'), String(base.getUTCDate()).padStart(2, '0')]);
  }
  const parts = [];
  for (const root of codexRoots()) {
    for (const segs of days) {
      let dir = root;
      for (const seg of segs) {
        dir = path.join(dir, seg);
        try { const st = fs.statSync(dir); parts.push(`${dir}:${st.mtimeMs}:${st.size}`); } catch { parts.push(`${dir}:0`); }
      }
    }
  }
  return [...new Set(parts)].sort().join('|');
}

// `vbrt watch`: poll the repo's brain inputs and re-push (debounced) when they
// change, so the live dashboard updates while you/the agent edit. Read-only.
async function cmdWatch(args = []) {
  const cwd = process.cwd();
  const apiUrl = resolveApi(); // deployed host by default; VBRT_API_URL overrides for local dev
  const includeMemory = !args.includes('--no-memory');
  const isPublic = args.includes('--public');
  // Live TUI (LIVE_ORCHESTRATION §8) is the default on an interactive terminal.
  // `--log` (alias `--no-tui`) forces the plain scrolling push log; we also fall back
  // to it automatically when stdout is piped/redirected (agents, CI, `| tee`) so logs
  // still capture cleanly. `--tui` is still accepted as an explicit no-op.
  const forceLog = args.includes('--log') || args.includes('--no-tui');
  const tui = !forceLog && !!process.stdout.isTTY;
  let sessions0 = await discoverSessions(cwd);
  let sessionFiles = sessions0.map((s) => s.file);
  let sessionsList = sessions0; // full objects, kept fresh for sid→agent mapping in the TUI
  const codexStates = new Map(); // file → { sig, parsed live session }
  const liveFileSig = (f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return 'gone'; } };
  const refreshCodexStates = async () => {
    for (const meta of sessionsList) {
      if (meta.source !== 'codex') continue;
      const sig = liveFileSig(meta.file);
      const prior = codexStates.get(meta.file);
      if (prior && prior.sig === sig) continue;
      try { codexStates.set(meta.file, { sig, ...(await parseCodex(meta.file)) }); } catch { /* partial write; retry next tick */ }
    }
  };
  await refreshCodexStates();
  const repoPaths = [...new Set([cwd, ...sessions0.map((s) => s.cwd).filter(Boolean)])];
  if (!tui) console.log(`\n${C.green('👁')}  Watching ${C.cyan(cwd)} → ${C.cyan(apiUrl)}  ${C.dim(`(${sessionFiles.length} session(s) + brain docs + git · Ctrl-C to stop)`)}`);

  // Heartbeat so `vbrt doctor` / `vbrt status` (and the agent) can tell a watcher is
  // live, find the share URL, and skip a redundant final `vbrt push`. The lock also
  // carries the project URL + last-upload time so nobody has to go hunting for them.
  // Refreshed each tick; removed on exit.
  const lockFile = path.join(cwd, '.vbrt', 'watch.lock');
  const lockState = { url: null, lastUpload: null };
  const writeLock = () => {
    try {
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid,
        cwd,
        ts: Date.now(),
        url: lockState.url,
        lastUpload: lockState.lastUpload,
        queued: outboxCount(),
      }));
    } catch { /* best-effort */ }
  };
  const clearLock = () => { try { fs.unlinkSync(lockFile); } catch { /* gone */ } };
  writeLock();

  // TUI lifecycle: alternate screen buffer + hidden cursor while live, always
  // restored on exit (otherwise Ctrl-C leaves the terminal in a broken state).
  const streamFile = path.join(cwd, '.vbrt', 'stream.jsonl');

  // Hand-dismissed panels survive across repaints and restarts: { sid: dismissedAtMs }.
  // Hard-killed sessions (Ctrl-C, terminal close, restart) fire no hook, so they linger
  // in the stream window — the user clears them with a number key; this remembers that.
  const dismissedFile = path.join(cwd, '.vbrt', 'watch-dismissed.json');
  let dismissed = {};
  try { dismissed = JSON.parse(fs.readFileSync(dismissedFile, 'utf8')) || {}; } catch { /* none yet */ }
  // Prune entries older than a week so the file can't grow without bound.
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  for (const k of Object.keys(dismissed)) if (dismissed[k] < weekAgo) delete dismissed[k];
  const writeDismissed = () => { try { fs.writeFileSync(dismissedFile, JSON.stringify(dismissed)); } catch { /* best-effort */ } };

  const st = { cwd, url: null, startedAt: Date.now(), hooks: false, events: [], lastPush: null, queued: 0, dismissed, visible: [] };
  const enterTui = () => process.stdout.write('\x1b[?1049h\x1b[?25l');
  const leaveTui = () => process.stdout.write('\x1b[?1049l\x1b[?25h');
  const repaint = () => {
    if (!tui) return;
    st.url = lockState.url;
    st.queued = outboxCount();
    st.hooks = fs.existsSync(streamFile); // the sidecar only exists once `vbrt hook` has fired
    st.events = readStream(cwd, 200);
    paintFrame(tuiFrame(st, sessionsList, codexStates));
  };
  const teardown = () => {
    if (tui) {
      try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* ignore */ }
      try { leaveTui(); } catch { /* ignore */ }
    }
    clearLock();
  };
  process.on('exit', teardown);
  process.on('SIGINT', () => { teardown(); process.exit(0); });
  process.on('SIGTERM', () => { teardown(); process.exit(0); });
  if (tui) {
    enterTui(); repaint(); process.stdout.on('resize', repaint); setInterval(repaint, 1000);
    // Raw-mode key input: number keys dismiss the matching panel; Ctrl-C still stops
    // (raw mode swallows the auto-SIGINT, so we handle \x03 by hand).
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch { /* not a real tty */ }
      process.stdin.resume();
      process.stdin.on('data', (buf) => {
        const k = buf.toString();
        if (k === '\x03' || k === 'q') { teardown(); process.exit(0); }
        if (k >= '1' && k <= '9') {
          const sid = st.visible[k.charCodeAt(0) - 49]; // '1' → index 0
          if (sid) { dismissed[sid] = Date.now(); writeDismissed(); repaint(); }
        }
      });
    }
  }

  let lastSig = watchSignature(repoPaths, sessionFiles); // baseline; don't push on startup
  let pendingSince = 0;  // last time the signature changed (settle clock)
  let changedSince = 0;  // first change since the last push (max-wait clock)
  let busy = false;
  let rediscoverIn = 20; // re-scan for new session files every ~20s (1s ticks)
  let lastCodexStoreSig = codexStoreSignature();
  // Settle the burst before pushing (DEBOUNCE), but never wait longer than MAX_WAIT:
  // an agent in YOLO / skip-permissions mode appends to its session log on every tick,
  // so the signature never goes quiet and a pure debounce would only push once the
  // agent *pauses* — which is why an early-written plan.md used to surface only after
  // the implementation finished. MAX_WAIT forces a push mid-burst so the live view
  // tracks the agent in near-real-time.
  const DEBOUNCE = 1200;
  const MAX_WAIT = 3000;

  // Delta push: only parse + send the sessions whose log changed since the last
  // push (the first push sends all, to sync the project). The server merges by
  // session id, so partial bundles update in place — keeps payloads small over
  // the network when only the active conversation is growing.
  const sessionSig = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return 'gone'; } };
  const lastMtimes = new Map();
  let firstPush = true;

  const tick = async () => {
    writeLock(); // refresh heartbeat even while idle so doctor sees a live watcher
    if (busy) return;
    const codexSig = codexStoreSignature();
    if (codexSig !== lastCodexStoreSig) { lastCodexStoreSig = codexSig; rediscoverIn = 1; }
    if (--rediscoverIn <= 0) {
      rediscoverIn = 20;
      try { sessionsList = await discoverSessions(cwd); sessionFiles = sessionsList.map((s) => s.file); } catch { /* keep old list */ }
    }
    await refreshCodexStates();
    let sig;
    try { sig = watchSignature(repoPaths, sessionFiles); } catch { return; }
    const now = Date.now();
    if (sig !== lastSig) { lastSig = sig; pendingSince = now; if (!changedSince) changedSince = now; } // mark a change
    if (!changedSince) return; // nothing pending
    const settled = now - pendingSince >= DEBOUNCE;        // burst went quiet, or
    const maxedOut = now - changedSince >= MAX_WAIT;       // we've waited long enough mid-burst
    if (!settled && !maxedOut) return;
    pendingSince = 0;
    changedSince = 0;
    busy = true;
    try {
      const sessions = await discoverSessions(cwd);
      const toParse = firstPush ? sessions : sessions.filter((s) => sessionSig(s.file) !== lastMtimes.get(s.file));
      const parsed = [];
      for (const s of toParse) {
        try { parsed.push(s.source === 'claude' ? await parseClaude(s.file) : await parseCodex(s.file)); } catch { /* skip */ }
      }
      const { bundle } = await assembleBundle(cwd, sessions, parsed, { includeMemory });
      // Deltas are ephemeral: don't queue to the outbox, and fail fast — the next
      // tick re-sends current state, so a transient 429 self-heals without piling up.
      const { id, url, visibility } = await pushBundle(bundle, { isPublic, queue: false, retries: 1 });
      const kind = firstPush ? 'full' : 'delta';
      for (const s of sessions) lastMtimes.set(s.file, sessionSig(s.file));
      firstPush = false;
      saveProjectRef(cwd, { id, url, apiUrl, visibility });
      lockState.url = url || lockState.url;
      lockState.lastUpload = Date.now();
      writeLock(); // surface the share URL + upload time immediately
      st.lastPush = { t: Date.now(), kind, count: parsed.length };
      if (tui) repaint();
      else console.log(C.dim(`  ↑ ${new Date().toLocaleTimeString()} — pushed ${parsed.length} session(s) [${kind}] → ${url}`));
    } catch (err) {
      if (!tui) console.log(C.yellow(`  ✗ push failed: ${err.message}`));
    }
    busy = false;
  };
  setInterval(tick, 1000);
}

async function cmdAdd(args = []) {
  // Push when asked explicitly (`vbrt push` / `--push`) or when an endpoint is
  // configured; otherwise write to the local store the viewer reads.
  const push = args.includes('--push') || args.includes('push') || Boolean(apiBase());
  const cwd = process.cwd();

  // `vbrt push --retry` (or --flush): resend bundles that an earlier push left in the
  // outbox (after a 429 / network failure) and stop — don't re-scan sessions.
  if (args.includes('--retry') || args.includes('--flush')) {
    const pending = outboxCount();
    if (!pending) {
      console.log(C.dim('\nNothing queued — the outbox is empty.\n'));
      return;
    }
    console.log(`\nResending ${pending} queued bundle(s) → ${C.cyan(resolveApi())} ...`);
    const { sent, failed, results } = await flushOutbox();
    for (const r of results) if (r.ok) console.log(C.green(`  ✓ ${r.url}`));
    if (failed) {
      console.log(C.yellow(`\n✗ ${sent} sent, ${failed} still queued — run \`vbrt push --retry\` again later.\n`));
      process.exitCode = 1;
    } else {
      console.log(C.green(`\n✓ Sent all ${sent} queued bundle(s).\n`));
    }
    return;
  }

  console.log(`\nScanning sessions for ${C.cyan(cwd)} ...`);
  const sessions = await discoverSessions(cwd);

  if (sessions.length === 0) {
    const cRoots = claudeRoots();
    const xRoots = codexRoots();
    console.log(C.yellow('\nNo Claude Code or Codex sessions found for this folder.'));
    console.log(C.dim(`  matching cwd key: ${canonicalKey(cwd)}`));
    console.log(C.dim('  searched Claude stores:'));
    console.log(cRoots.length ? cRoots.map((r) => `    ${r}`).join('\n') : C.dim('    (none found)'));
    console.log(C.dim('  searched Codex stores:'));
    console.log(xRoots.length ? xRoots.map((r) => `    ${r}`).join('\n') : C.dim('    (none found)'));
    if (process.platform === 'win32' && cRoots.length === 0 && xRoots.length === 0) {
      console.log(
        C.yellow(
          '\n  No stores found. Your sessions likely live in WSL. Either run vbrt from WSL,\n  or point vbrt at the WSL paths, e.g. (PowerShell):',
        ),
      );
      console.log(C.dim('    $env:VBRT_CODEX_DIR="\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.codex\\sessions"'));
      console.log(C.dim('    $env:VBRT_CLAUDE_DIR="\\\\wsl.localhost\\Ubuntu\\home\\<user>\\.claude\\projects"'));
    }
    return;
  }

  const claudeCount = sessions.filter((s) => s.source === 'claude').length;
  const codexCount = sessions.filter((s) => s.source === 'codex').length;
  const aliasCount = sessions.filter((s) => s.aliasMatch).length;
  console.log(
    C.dim(`Found ${sessions.length} session(s): ${claudeCount} claude, ${codexCount} codex\n`),
  );
  if (aliasCount) {
    console.log(
      C.dim(`(${aliasCount} from the same project folder at a different path — marked with their cwd)\n`),
    );
  }

  // Non-interactive selection for agents/skills: `--all` (or `--yes`/`-y`) takes
  // every discovered session with no prompt. Otherwise show the picker.
  const selectAll = args.includes('--all') || args.includes('--yes') || args.includes('-y');
  let picked;
  if (selectAll) {
    picked = sessions.map((_, i) => i);
    console.log(C.dim(`Selecting all ${picked.length} session(s).`));
  } else {
    const choices = sessions.map((s, i) => ({
      name: `${s.source === 'claude' ? '🟣 claude' : '🟢 codex '}  ${C.dim(fmtDate(s.startedAt))}  ${C.dim(`${s.userTurns || 0} turns`)}  ${s.preview || C.dim('(no prompt)')}${s.aliasMatch ? C.yellow(`  [${s.cwd}]`) : ''}`,
      value: i,
      checked: false,
    }));
    try {
      const { checkbox } = await import('@inquirer/prompts');
      picked = await checkbox({
        message: 'Select sessions to add (space toggles, a = all, enter confirms):',
        choices,
        pageSize: 15,
        loop: false,
      });
    } catch {
      console.log(C.dim('\nCancelled.'));
      return;
    }
  }

  if (picked.length === 0) {
    console.log(C.dim('\nNothing selected.'));
    return;
  }

  console.log(`\nParsing ${picked.length} session(s) ...`);
  const parsed = [];
  for (const idx of picked) {
    const s = sessions[idx];
    try {
      parsed.push(s.source === 'claude' ? await parseClaude(s.file) : await parseCodex(s.file));
    } catch (err) {
      console.log(C.yellow(`  ! failed to parse ${s.file}: ${err.message}`));
    }
  }

  const includeMemory = !args.includes('--no-memory');
  const { bundle, commits, docs, memory } = await assembleBundle(cwd, sessions, parsed, { includeMemory });
  const memNoteCount = memory && memory.ok ? memory.notes.length : 0;
  console.log(
    C.dim(
      `Captured ${commits.length} git commit(s); ${docs.length} agent doc(s)${docs.length ? `: ${docs.map((d) => d.name).join(', ')}` : ''}; ` +
        `${includeMemory ? `${memNoteCount} memory note(s)` : 'memory excluded (--no-memory)'}.`,
    ),
  );

  if (push) {
    try {
      const isPublic = args.includes('--public');
      if (args.includes('--dry-run')) {
        printDryRun(bundle, { includeMemory, isPublic });
        return;
      }
      const watching = watchStatus(cwd);
      if (watching.active) {
        console.log(C.yellow(`\n⚠ \`vbrt watch\` is live (pid ${watching.pid}) — it's already streaming this repo.`));
        console.log(C.dim('  This manual push is redundant; only push by hand if watch errored. Proceeding anyway…'));
      }
      const { id, url, viewUrl, dashboardUrl, newToken, tokenPath, visibility, linkUrl } = await pushBundle(bundle, { isPublic });
      saveProjectRef(cwd, { id, url, apiUrl: resolveApi(), visibility });
      if (visibility === 'public') {
        console.log(C.green(`\n✓ Pushed project "${bundle.project.slug}" (public) — view & share at:`));
        console.log(`  ${C.cyan(url)}`);
        console.log(C.dim(`  Your projects: ${dashboardUrl}`));
      } else {
        console.log(C.green(`\n✓ Pushed project "${bundle.project.slug}" (private) — open it (no sign-in needed):`));
        console.log(`  ${C.cyan(viewUrl || url)}`);
        console.log(C.dim(`  Only you can see it. Share with others (no re-upload): ${C.bold('vbrt publish --public')}`));
      }
      if (newToken) {
        console.log(C.dim(`  (saved an access token to ${tokenPath})`));
        if (linkUrl) console.log(C.dim(`  Link these to your account: ${linkUrl}`));
      }
      console.log('');
    } catch (err) {
      console.log(C.yellow(`\n✗ Push failed: ${err.message}`));
      if (err.queuedAt) {
        console.log(C.dim('  Your work is saved locally in the outbox — nothing lost.'));
        console.log(C.dim(`  Resend it when the host is ready: ${C.bold('vbrt push --retry')}`));
      } else {
        console.log(C.dim('  (fix the endpoint and retry, or run `vbrt add` for a local copy)'));
      }
      process.exitCode = 1;
    }
    return;
  }

  const result = saveBundle(bundle);
  console.log(
    C.green(
      `\n✓ Added ${result.added} new, updated ${result.skipped}. Project "${result.slug}" now has ${result.total} session(s).`,
    ),
  );
  console.log(C.dim(`Run ${C.bold('vbrt serve')} to browse.`));
}

// `vbrt shot <url|image> [--label before|after] [--note "…"] [--viewport WxH]`:
// capture a screenshot artifact and bind it to the active session/prompt. Designed
// to be a one-liner an agent runs mid-task — no need to know its own session id.
// The artifact is stored in `.vbrt/evidence/` and uploaded on the next push/watch.
async function cmdShot(args = []) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      if (k === 'click') (opts.click = opts.click || []).push(v); // repeatable: click in sequence
      else opts[k] = v;
    } else pos.push(a);
  }
  const target = pos[0];
  const label = opts.label === true ? null : opts.label;
  if (label && label !== 'before' && label !== 'after') {
    console.log(C.yellow('--label must be "before" or "after".'));
    process.exitCode = 1;
    return;
  }
  if (!target && !opts.image) {
    console.log(C.yellow('Usage: vbrt shot <url|image.png> [--image <file>] [--label before|after] [--note "…"] [--viewport 1280x800] [--clip [seconds]] [--click <selector> …] [--wait <selector|ms>]'));
    console.log(C.dim('  Pass a URL (captured via Playwright if installed) or an image the agent already took.'));
    console.log(C.dim('  --click <selector> drives the page to a state the URL can\'t reach (open a modal, click into a view); repeat to chain clicks. --wait holds for a selector or N ms before the shot.'));
    console.log(C.dim('  --clip records a motion clip of a URL; [seconds] is a CAP — it auto-stops when motion settles (gif if ffmpeg, else webm).'));
    process.exitCode = 1;
    return;
  }
  // --clip / --gif both mean "record motion"; an explicit --seconds N sets length.
  const clipOpt = opts.clip ?? opts.gif;
  const clip = clipOpt === undefined ? null
    : opts.seconds && opts.seconds !== true ? Number(opts.seconds)
    : clipOpt; // true (default length) or a number passed as `--clip 6`
  const cwd = process.cwd();
  try {
    const rec = await recordShot(cwd, {
      target,
      image: opts.image === true ? undefined : opts.image,
      label,
      note: opts.note === true ? '' : opts.note || '',
      viewport: opts.viewport === true ? null : opts.viewport || null,
      session: opts.session === true ? null : opts.session || null,
      pair: opts.pair === true ? null : opts.pair || null,
      clip,
      // Reach a state a URL can't on its own: click selectors in order, then wait
      // for a selector (or N ms). Pass --click more than once to chain clicks.
      click: opts.click || null,
      wait: opts.wait === true ? null : opts.wait || null,
    });
    const kind = rec.media === 'video' ? 'clip (webm)' : clip ? 'clip (gif)' : 'artifact';
    const dur = clip && rec.durationMs ? ` · ${(rec.durationMs / 1000).toFixed(1)}s (${rec.settled ? 'auto-stopped when motion settled' : 'hit --clip cap; raise it if the motion was cut off'})` : '';
    console.log(C.green(`\n✓ Captured ${kind}${rec.label ? ` (${rec.label})` : ''}${dur} → ${path.relative(cwd, rec.file)}`));
    console.log(C.dim(`  bound to ${rec.session ? `session ${rec.session.id}` : '(no active session found — will attach by time)'}${rec.note ? ` · "${rec.note}"` : ''}`));
    // Before the first commit, evidence can't tie to a code checkpoint — nudge, don't fail.
    if (isGitRepo(cwd) && !rec.gitHead) {
      console.log(C.yellow('  ⚠ No commit yet — captured, but not tied to a code checkpoint. Commit first, then capture for a clean before/after.'));
    }
    const w = watchStatus(cwd);
    if (w.active) {
      console.log(C.dim('  `vbrt watch` is live — this streams up automatically. No manual push needed.'));
      if (w.url) console.log(C.dim(`  Share/view: ${C.cyan(w.url)}`));
      else console.log(C.dim('  (share link appears after the first stream lands — `vbrt status` shows it)'));
      console.log('');
    } else {
      console.log(C.dim('  Rides your next `vbrt push --all`.\n'));
    }
  } catch (err) {
    console.log(C.yellow(`\n✗ ${err.message}\n`));
    process.exitCode = 1;
  }
}

async function cmdLogin(args) {
  let apiUrl = '';
  let token = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--api') {
      apiUrl = args[++i] || '';
      continue;
    }
    if (!args[i].startsWith('--') && !token) token = args[i];
  }
  apiUrl = apiUrl || apiBase();
  if (!token) {
    console.log(C.yellow('Usage: vbrt login <token> [--api https://your-host]'));
    console.log(C.dim('Get a token from your dashboard → "Connect CLI".'));
    process.exitCode = 1;
    return;
  }
  try {
    const { apiUrl: saved, tokenPath } = login(apiUrl, token);
    console.log(C.green(`\n✓ Connected to ${saved}`));
    console.log(C.dim(`  Token saved to ${tokenPath}. Now run ${C.bold('vbrt push')} in any repo.`));
  } catch (err) {
    console.log(C.yellow(`\n✗ ${err.message}`));
    process.exitCode = 1;
  }
}

// `vbrt hook`: invoked by a Claude Code hook (PreToolUse / PostToolUse /
// UserPromptSubmit / Stop / …). Reads the hook payload from stdin and records a
// compact real-time event to `.vbrt/stream.jsonl`, which `vbrt watch` ships so the
// dashboard ticker tracks the agent live (no flush lag, no token cost). Always
// exits 0 — a hook must never break the agent's turn.
async function cmdHook() {
  try { await recordHookFromStdin(); } catch { /* never fail the agent */ }
  process.exit(0);
}

// The hooks block we wire into settings.json. Each event runs `vbrt hook`, which is
// a fast, dependency-free Node process that just appends to the local sidecar.
function hookSettings() {
  const cmd = 'vbrt hook';
  const one = (matcher) => (matcher ? [{ matcher, hooks: [{ type: 'command', command: cmd }] }] : [{ hooks: [{ type: 'command', command: cmd }] }]);
  return {
    hooks: {
      UserPromptSubmit: one(),
      PreToolUse: one('*'),
      PostToolUse: one('*'),
      Stop: one(),
      SessionStart: one(),
      SessionEnd: one(),
    },
  };
}

// `vbrt hooks` — print the settings snippet; `--install` merges it into
// `<cwd>/.claude/settings.json` (creating it) without clobbering existing hooks.
async function cmdHooks(args = []) {
  const snippet = hookSettings();
  if (!args.includes('--install')) {
    console.log(`\n${C.bold('vbrt hooks')} — real-time agent ticker via Claude Code hooks\n`);
    console.log(C.dim('Add this to .claude/settings.json (or run `vbrt hooks --install`):\n'));
    console.log(JSON.stringify(snippet, null, 2));
    console.log(C.dim('\nThen `vbrt watch` will stream the agent\'s live activity (working/idle,'));
    console.log(C.dim('current action, context load) to the dashboard ticker. Zero token cost.\n'));
    return;
  }
  const cwd = process.cwd();
  const file = path.join(cwd, '.claude', 'settings.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new file */ }
  existing.hooks = existing.hooks || {};
  // Merge per-event, skipping any event that already runs `vbrt hook` so re-install
  // is idempotent and we never duplicate or drop the user's own hooks.
  let added = 0;
  for (const [event, entries] of Object.entries(snippet.hooks)) {
    const cur = Array.isArray(existing.hooks[event]) ? existing.hooks[event] : [];
    const already = JSON.stringify(cur).includes('vbrt hook');
    if (already) continue;
    existing.hooks[event] = [...cur, ...entries];
    added++;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\n${C.green('✓')} ${added ? `Wired ${added} hook event(s) into` : 'Hooks already present in'} ${C.cyan(path.relative(cwd, file) || file)}`);
  console.log(C.dim('Run `vbrt watch` and the dashboard ticker will follow the agent live.\n'));
}

async function cmdServe(args) {
  // Precedence: --port flag > PORT env (cloud hosts inject it) > local default.
  const portArg = args.find((a) => /^--port=/.test(a));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT) || 4317;
  const { startServer } = await import('../src/server.js');
  const { port: actual } = await startServer(port);
  const url = `http://localhost:${actual}`;
  console.log(`\n${C.green('▸')} viberate viewer running at ${C.cyan(url)}`);
  console.log(C.dim('Press Ctrl+C to stop.\n'));
}

// Is a `vbrt watch` heartbeat live for this repo? (lock refreshed every ~2s)
// Returns the lock's payload too — project URL, last-upload time, queued count —
// so callers don't go hunting for the share link.
function watchStatus(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.vbrt', 'watch.lock'), 'utf8');
    const lock = JSON.parse(raw);
    if (Date.now() - Number(lock.ts) < 15000) {
      return { active: true, pid: lock.pid, url: lock.url || null, lastUpload: lock.lastUpload || null, queued: lock.queued || 0 };
    }
  } catch { /* no lock / stale */ }
  return { active: false };
}

function isGitRepo(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).trim() === 'true';
  } catch {
    return false;
  }
}

// Preflight: one command an agent runs before building so artifact capture is
// boring and predictable. Reports repo / watch / capture / clip / fallback and
// prints the exact command pattern to use — so it never rediscovers the Playwright
// resolution detour the hard way.
async function cmdDoctor(args = []) {
  const cwd = process.cwd();
  const fix = args.includes('--fix');
  const ok = (b) => (b ? C.green('✓') : C.yellow('✗'));
  console.log(`\n${C.bold('vbrt doctor')}${fix ? C.dim(' --fix') : ''} — ${C.cyan(cwd)}\n`);

  const repo = isGitRepo(cwd);
  console.log(`  ${ok(repo)} git repo            ${repo ? C.dim('initialized') : C.yellow('not a git repo — run `git init` so commits/brain timeline are captured')}`);

  let sessionCount = 0;
  try { sessionCount = (await discoverSessions(cwd)).length; } catch { /* none */ }
  console.log(`  ${ok(sessionCount > 0)} sessions           ${sessionCount > 0 ? C.dim(`${sessionCount} found for this folder`) : C.yellow('none yet — run from the repo root where you used Claude Code / Codex')}`);

  const watch = watchStatus(cwd);
  console.log(`  ${ok(watch.active)} vbrt watch         ${watch.active ? C.dim(`live (pid ${watch.pid}) — DON'T run \`push --all\`; watch streams changes`) : C.dim('not running — push with `vbrt push --all` when done')}`);

  console.log(C.dim('\n  capture (checking Playwright + browser; may take a few seconds)…'));
  let cap = await captureCapabilities(cwd);
  let urlOk = cap.playwright && cap.chromium;

  // `--fix`: install Playwright + chromium in this repo, then re-probe so the
  // verdict below reflects the fixed state.
  if (!urlOk && fix) {
    console.log(C.dim('\n  --fix: installing capture tooling (this can take a minute)…\n'));
    try {
      cap = await installCapture(cwd, (m) => console.log(C.dim('  ' + m)));
      urlOk = cap.playwright && cap.chromium;
      console.log(urlOk ? C.green('\n  ✓ capture tooling installed.\n') : C.yellow('\n  ✗ still not working after install — see the error below.\n'));
    } catch (err) {
      console.log(C.yellow(`\n  ✗ install failed: ${String(err.message || err).split('\n')[0]}\n`));
    }
  }

  const browserNote = cap.browser ? ` (${cap.browser})` : '';
  console.log(`  ${ok(urlOk)} URL capture        ${urlOk ? C.dim(`Playwright (${cap.source}) + chromium${browserNote} ready`) : C.yellow(cap.playwright ? `Playwright (${cap.source}) found but no browser — run \`vbrt doctor --fix\`` : 'no Playwright — run `vbrt doctor --fix` (or register a file; see below)')}`);
  console.log(`  ${ok(urlOk)} clip capture       ${urlOk ? C.dim(cap.ffmpeg ? 'records → animated .gif (ffmpeg present)' : 'records → .webm (no ffmpeg; gif unavailable but webm loops fine)') : C.dim('needs URL capture (above)')}`);
  console.log(`  ${C.green('✓')} file register      ${C.dim('always works: `vbrt shot ./shot.png --label after` (.png/.gif/.webm)')}`);
  if (!urlOk && !fix) console.log(C.dim('      → auto-install with `vbrt doctor --fix`'));
  if (cap.error) console.log(C.dim(`      browser launch error: ${cap.error.split('\n')[0]}`));

  console.log(`\n  ${C.bold('Recommended capture command')}:`);
  if (urlOk) {
    console.log(`    ${C.cyan('vbrt shot http://localhost:<port> --label after --note "…"')}`);
    console.log(C.dim('    add `--clip 8` for motion — it auto-stops when motion settles, so the number is just a cap. Point at YOUR app, never VibeRate.'));
    console.log(C.dim('    if the state is behind an interaction (modal/menu/detail view): add `--click <sel>` (repeatable) + `--wait <sel|ms>` to reach it.'));
  } else {
    console.log(`    ${C.cyan('vbrt shot ./shot.png --label after --note "…"')}   ${C.dim('(take the file with your own tooling)')}`);
    console.log(C.dim('    headless capture is unavailable here — do NOT touch NODE_PATH or the skill install.'));
  }
  console.log(C.dim('\n  Small experiments (<~1h): keep ROADMAP.md + DEVLOG.md, skip per-phase PLAN files, ≤3 artifacts.\n'));
}

function agoStr(ts) {
  if (!ts) return null;
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// One glance at VibeRate's state for this repo: is watch live, where's the share
// URL, how much evidence is captured, anything queued, and is a manual push needed.
// Reads only local state (lock + outbox + evidence sidecar) — no network.
function cmdStatus() {
  const cwd = process.cwd();
  const w = watchStatus(cwd);
  const ref = loadProjectRef(cwd); // survives across runs even without a watcher
  const queued = outboxCount();
  let evidence = 0;
  try { evidence = readEvidence(cwd).length; } catch { /* none */ }
  const url = w.url || (ref && ref.url) || null;
  const visibility = ref && ref.visibility;

  console.log(`\n${C.bold('vbrt status')} — ${C.cyan(cwd)}\n`);
  console.log(`  Watch:        ${w.active ? C.green(`live`) + C.dim(` (pid ${w.pid}${w.lastUpload ? `, last upload ${agoStr(w.lastUpload)}` : ''})`) : C.dim('not running')}`);
  const vis = visibility ? C.dim(`  [${visibility}]`) : '';
  console.log(`  Project:      ${url ? C.cyan(url) + vis : C.dim(w.active ? '(none yet — first stream not landed)' : 'no link yet — `vbrt push --all` or `vbrt watch` to publish')}`);
  if (url && visibility === 'private') console.log(C.dim(`                share it: ${C.bold('vbrt publish --public')}`));
  console.log(`  Evidence:     ${evidence ? `${evidence} captured` : C.dim('none captured')}${evidence && w.active ? C.dim(' (streaming live)') : ''}`);
  console.log(`  Outbox:       ${queued ? C.yellow(`${queued} queued`) + C.dim(' — `vbrt push --retry`') : C.dim('empty')}`);
  const manual = queued ? C.yellow('run `vbrt push --retry` (queued uploads)')
    : w.active ? C.green('not needed') + C.dim(' (watch is streaming)')
    : url ? C.dim('already pushed — re-push only to update')
    : C.dim('recommended — `vbrt push --all` (no watcher running)');
  console.log(`  Manual push:  ${manual}\n`);
}

// Flip the already-uploaded project public/private without re-sending the bundle.
async function cmdPublish(args = []) {
  const cwd = process.cwd();
  const visibility = args.includes('--private') ? 'private' : 'public';
  try {
    const out = await publishProject(cwd, { visibility });
    if (out.visibility === 'public') {
      console.log(C.green(`\n✓ Public — anyone with the link can view:`));
      console.log(`  ${C.cyan(out.url)}\n`);
    } else {
      console.log(C.green(`\n✓ Private — only you can view. ${C.dim('(re-share with `vbrt publish --public`)')}\n`));
    }
  } catch (err) {
    console.log(C.yellow(`\n✗ ${err.message}\n`));
    process.exitCode = 1;
  }
}

function cmdHelp() {
  console.log(`
${C.bold('vbrt')} — browse old Codex & Claude Code sessions as projects

  ${C.cyan('vbrt')} ${C.dim('|')} ${C.cyan('vbrt add')}     Pick this folder's sessions and save them locally
  ${C.cyan('vbrt login <token>')}  Connect this machine to your account (token from the dashboard)
  ${C.cyan('vbrt push')}          Upload to your dashboard at vbrt.fly.dev (set VBRT_API_URL for a local host)
  ${C.cyan('vbrt push --public')}   Publish on push (share a link immediately; default is private)
  ${C.cyan('vbrt publish --public')} Make the last pushed link shareable without re-uploading
  ${C.cyan('vbrt publish --private')} Make the last pushed link private again
  ${C.cyan('vbrt push --dry-run')}  Preview the redacted payload and visibility without uploading
  ${C.cyan('vbrt push --retry')}    Resend bundles left in the outbox after a failed upload
  ${C.cyan('vbrt push --no-memory')} Push without this repo's agent memory (memory is included by default)
  ${C.cyan('vbrt watch')}         Live in-terminal dashboard (default): a panel per agent — status,
                       current action, context gauge — re-pushing as brain docs / git change.
  ${C.cyan('vbrt watch --log')}   Plain scrolling push log instead of the dashboard (also the
                       automatic fallback when output is piped/redirected).
  ${C.cyan('vbrt hooks --install')} Wire Claude Code hooks so the dashboard ticker follows the agent live
  ${C.cyan('vbrt hook')}          (internal) record a hook event to the live stream — called by the hooks
  ${C.cyan('vbrt shot <url|img>')} Capture a screenshot artifact bound to the current prompt (before/after)
  ${C.cyan('vbrt shot <url> --clip [s]')} Record a motion clip (auto-stops when motion settles; [s] caps it)
  ${C.cyan('vbrt doctor')}        Preflight: repo / watch / capture readiness + the command to use
  ${C.cyan('vbrt doctor --fix')}  Auto-install Playwright + chromium here if capture isn't ready
  ${C.cyan('vbrt status')}        Where things stand: watch, project URL, evidence, outbox, push needed?
  ${C.cyan('vbrt serve')}         Start the local web viewer (default port 4317)
  ${C.cyan('vbrt serve --port=N')} Use a custom port
  ${C.cyan('vbrt help')}          Show this help
`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'add':
      await cmdAdd(rest);
      break;
    case 'push':
      await cmdAdd(['push', ...rest]);
      break;
    case 'publish':
      await cmdPublish(rest);
      break;
    case 'watch':
      await cmdWatch(rest);
      break;
    case 'hook':
      await cmdHook();
      break;
    case 'hooks':
      await cmdHooks(rest);
      break;
    case 'shot':
      await cmdShot(rest);
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'login':
      await cmdLogin(rest);
      break;
    case 'serve':
      await cmdServe(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      break;
    default:
      console.log(C.yellow(`Unknown command: ${cmd}`));
      cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
