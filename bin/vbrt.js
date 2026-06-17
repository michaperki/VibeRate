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
import { readEvidence, recordShot, captureCapabilities } from '../src/evidence.js';
import { buildBundle } from '../src/bundle.js';
import { pushBundle, apiBase, resolveApi, login, flushOutbox, outboxCount } from '../src/push.js';
import { redactBundle } from '../src/redact.js';
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

  const bundle = buildBundle(cwd, {
    sessions: parsed,
    git: commits.length ? { cwd, capturedAt: new Date().toISOString(), commits } : null,
    docs,
    docHistory,
    memory,
    evidence,
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
  return parts.sort().join('|');
}

// `vbrt watch`: poll the repo's brain inputs and re-push (debounced) when they
// change, so the live dashboard updates while you/the agent edit. Read-only.
async function cmdWatch(args = []) {
  const cwd = process.cwd();
  const apiUrl = resolveApi(); // deployed host by default; VBRT_API_URL overrides for local dev
  const includeMemory = !args.includes('--no-memory');
  const isPublic = args.includes('--public');
  let sessions0 = await discoverSessions(cwd);
  let sessionFiles = sessions0.map((s) => s.file);
  const repoPaths = [...new Set([cwd, ...sessions0.map((s) => s.cwd).filter(Boolean)])];
  console.log(`\n${C.green('👁')}  Watching ${C.cyan(cwd)} → ${C.cyan(apiUrl)}  ${C.dim(`(${sessionFiles.length} session(s) + brain docs + git · Ctrl-C to stop)`)}`);

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
  process.on('exit', clearLock);
  process.on('SIGINT', () => { clearLock(); process.exit(0); });
  process.on('SIGTERM', () => { clearLock(); process.exit(0); });

  let lastSig = watchSignature(repoPaths, sessionFiles); // baseline; don't push on startup
  let pendingSince = 0;
  let busy = false;
  let rediscoverIn = 10; // re-scan for new session files every ~20s
  const DEBOUNCE = 1500;

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
    if (--rediscoverIn <= 0) {
      rediscoverIn = 10;
      try { sessionFiles = (await discoverSessions(cwd)).map((s) => s.file); } catch { /* keep old list */ }
    }
    let sig;
    try { sig = watchSignature(repoPaths, sessionFiles); } catch { return; }
    if (sig !== lastSig) { lastSig = sig; pendingSince = Date.now(); return; } // changed — wait to settle
    if (!pendingSince || Date.now() - pendingSince < DEBOUNCE) return;
    pendingSince = 0;
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
      const { url } = await pushBundle(bundle, { isPublic, queue: false, retries: 1 });
      const kind = firstPush ? 'full' : 'delta';
      for (const s of sessions) lastMtimes.set(s.file, sessionSig(s.file));
      firstPush = false;
      lockState.url = url || lockState.url;
      lockState.lastUpload = Date.now();
      writeLock(); // surface the share URL + upload time immediately
      console.log(C.dim(`  ↑ ${new Date().toLocaleTimeString()} — pushed ${parsed.length} session(s) [${kind}] → ${url}`));
    } catch (err) {
      console.log(C.yellow(`  ✗ push failed: ${err.message}`));
    }
    busy = false;
  };
  setInterval(tick, 2000);
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
      const { url, dashboardUrl, newToken, tokenPath, visibility, linkUrl } = await pushBundle(bundle, { isPublic });
      if (visibility === 'public') {
        console.log(C.green(`\n✓ Pushed project "${bundle.project.slug}" (public) — view & share at:`));
        console.log(`  ${C.cyan(url)}`);
        console.log(C.dim(`  Your projects: ${dashboardUrl}`));
      } else {
        console.log(C.green(`\n✓ Pushed project "${bundle.project.slug}" (private) — only you can see it:`));
        console.log(`  ${C.cyan(dashboardUrl)}`);
        console.log(C.dim('  Publish it from your dashboard, or push with --public to share a link.'));
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
      opts[k] = v;
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
    console.log(C.yellow('Usage: vbrt shot <url|image.png> [--image <file>] [--label before|after] [--note "…"] [--viewport 1280x800] [--clip [seconds]]'));
    console.log(C.dim('  Pass a local dev URL (captured via Playwright if installed) or an image the agent already took.'));
    console.log(C.dim('  --clip records a short motion clip of a URL (gif if ffmpeg is installed, else webm).'));
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
    });
    const kind = rec.media === 'video' ? 'clip (webm)' : clip ? 'clip (gif)' : 'artifact';
    console.log(C.green(`\n✓ Captured ${kind}${rec.label ? ` (${rec.label})` : ''} → ${path.relative(cwd, rec.file)}`));
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
async function cmdDoctor() {
  const cwd = process.cwd();
  const ok = (b) => (b ? C.green('✓') : C.yellow('✗'));
  console.log(`\n${C.bold('vbrt doctor')} — ${C.cyan(cwd)}\n`);

  const repo = isGitRepo(cwd);
  console.log(`  ${ok(repo)} git repo            ${repo ? C.dim('initialized') : C.yellow('not a git repo — run `git init` so commits/brain timeline are captured')}`);

  let sessionCount = 0;
  try { sessionCount = (await discoverSessions(cwd)).length; } catch { /* none */ }
  console.log(`  ${ok(sessionCount > 0)} sessions           ${sessionCount > 0 ? C.dim(`${sessionCount} found for this folder`) : C.yellow('none yet — run from the repo root where you used Claude Code / Codex')}`);

  const watch = watchStatus(cwd);
  console.log(`  ${ok(watch.active)} vbrt watch         ${watch.active ? C.dim(`live (pid ${watch.pid}) — DON'T run \`push --all\`; watch streams changes`) : C.dim('not running — push with `vbrt push --all` when done')}`);

  console.log(C.dim('\n  capture (checking Playwright + browser; may take a few seconds)…'));
  const cap = await captureCapabilities(cwd);
  const urlOk = cap.playwright && cap.chromium;
  console.log(`  ${ok(urlOk)} URL capture        ${urlOk ? C.dim(`Playwright (${cap.source}) + chromium ready`) : C.yellow(cap.playwright ? `Playwright (${cap.source}) found but no browser — run \`npx playwright install chromium\`` : 'no Playwright — `npm i -D playwright && npx playwright install chromium`, or register a file (see below)')}`);
  console.log(`  ${ok(urlOk)} clip capture       ${urlOk ? C.dim(cap.ffmpeg ? 'records → animated .gif (ffmpeg present)' : 'records → .webm (no ffmpeg; gif unavailable but webm loops fine)') : C.dim('needs URL capture (above)')}`);
  console.log(`  ${C.green('✓')} file register      ${C.dim('always works: `vbrt shot ./shot.png --label after` (.png/.gif/.webm)')}`);
  if (cap.error) console.log(C.dim(`      browser launch error: ${cap.error.split('\n')[0]}`));

  console.log(`\n  ${C.bold('Recommended capture command')}:`);
  if (urlOk) {
    console.log(`    ${C.cyan('vbrt shot http://localhost:<port> --label after --note "…"')}`);
    console.log(C.dim('    add `--clip 4` for motion. Point at YOUR app, never VibeRate.'));
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
  const queued = outboxCount();
  let evidence = 0;
  try { evidence = readEvidence(cwd).length; } catch { /* none */ }

  console.log(`\n${C.bold('vbrt status')} — ${C.cyan(cwd)}\n`);
  console.log(`  Watch:        ${w.active ? C.green(`live`) + C.dim(` (pid ${w.pid}${w.lastUpload ? `, last upload ${agoStr(w.lastUpload)}` : ''})`) : C.dim('not running')}`);
  const url = w.url || null;
  console.log(`  Project:      ${url ? C.cyan(url) : C.dim(w.active ? '(none yet — first stream not landed)' : 'no link yet — `vbrt push --all` or `vbrt watch` to publish')}`);
  console.log(`  Evidence:     ${evidence ? `${evidence} captured` : C.dim('none captured')}${evidence && w.active ? C.dim(' (streaming live)') : ''}`);
  console.log(`  Outbox:       ${queued ? C.yellow(`${queued} queued`) + C.dim(' — `vbrt push --retry`') : C.dim('empty')}`);
  const manual = queued ? C.yellow('run `vbrt push --retry` (queued uploads)')
    : w.active ? C.green('not needed') + C.dim(' (watch is streaming)')
    : C.dim('recommended — `vbrt push --all` (no watcher running)');
  console.log(`  Manual push:  ${manual}\n`);
}

function cmdHelp() {
  console.log(`
${C.bold('vbrt')} — browse old Codex & Claude Code sessions as projects

  ${C.cyan('vbrt')} ${C.dim('|')} ${C.cyan('vbrt add')}     Pick this folder's sessions and save them locally
  ${C.cyan('vbrt login <token>')}  Connect this machine to your account (token from the dashboard)
  ${C.cyan('vbrt push')}          Upload to your dashboard at vbrt.fly.dev (set VBRT_API_URL for a local host)
  ${C.cyan('vbrt push --public')}   Publish on push (share a link immediately; default is private)
  ${C.cyan('vbrt push --dry-run')}  Preview the redacted payload and visibility without uploading
  ${C.cyan('vbrt push --retry')}    Resend bundles left in the outbox after a failed upload
  ${C.cyan('vbrt push --no-memory')} Push without this repo's agent memory (memory is included by default)
  ${C.cyan('vbrt watch')}         Re-push automatically when the brain docs / git change (live streaming)
  ${C.cyan('vbrt shot <url|img>')} Capture a screenshot artifact bound to the current prompt (before/after)
  ${C.cyan('vbrt shot <url> --clip [s]')} Record a short motion clip (gif if ffmpeg, else webm)
  ${C.cyan('vbrt doctor')}        Preflight: repo / watch / capture readiness + the command to use
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
    case 'watch':
      await cmdWatch(rest);
      break;
    case 'shot':
      await cmdShot(rest);
      break;
    case 'doctor':
      await cmdDoctor();
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
