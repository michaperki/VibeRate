#!/usr/bin/env node
// Heavy deps (@inquirer/prompts, express) are loaded lazily inside the commands
// that need them, so `vbrt push` runs with only Node builtins + fetch — which is
// what lets the skill bundle ship without node_modules.
import fs from 'node:fs';
import path from 'node:path';
import { discoverSessions } from '../src/discover.js';
import { parseClaude, parseCodex } from '../src/parsers.js';
import { saveBundle } from '../src/storage.js';
import { extractGit, extractDocHistory } from '../src/git.js';
import { extractDocsMulti } from '../src/docs.js';
import { extractMemory } from '../src/workspace.js';
import { buildBundle } from '../src/bundle.js';
import { pushBundle, apiBase, login } from '../src/push.js';
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
const BRAINISH = /soul|agents?|claude|seed|roadmap|backlog|tasks|memory|context|decisions|attempts|plan|_next_pass/i;

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

  const bundle = buildBundle(cwd, {
    sessions: parsed,
    git: commits.length ? { cwd, capturedAt: new Date().toISOString(), commits } : null,
    docs,
    docHistory,
    memory,
  });
  return { bundle, commits, docs, memory, repoPaths };
}

// A cheap fingerprint of the repo's brain inputs — mtimes/sizes of the agent docs
// plus git HEAD/index — so `vbrt watch` can tell when something changed.
function watchSignature(repoPaths) {
  const parts = [];
  for (const d of extractDocsMulti(repoPaths)) parts.push(`${d.name}:${Math.floor(d.mtime || 0)}:${d.bytes || 0}`);
  for (const p of repoPaths) {
    for (const f of ['HEAD', 'index']) {
      try { parts.push(`${f}:${Math.floor(fs.statSync(path.join(p, '.git', f)).mtimeMs)}`); } catch { /* not a repo / no file */ }
    }
  }
  return parts.sort().join('|');
}

// `vbrt watch`: poll the repo's brain inputs and re-push (debounced) when they
// change, so the live dashboard updates while you/the agent edit. Read-only.
async function cmdWatch(args = []) {
  const cwd = process.cwd();
  const apiUrl = apiBase();
  if (!apiUrl) {
    console.log(C.yellow('No endpoint configured. Set VBRT_API_URL=… or run `vbrt login` first.'));
    process.exitCode = 1;
    return;
  }
  const includeMemory = !args.includes('--no-memory');
  const isPublic = args.includes('--public');
  const sessions0 = await discoverSessions(cwd);
  const repoPaths = [...new Set([cwd, ...sessions0.map((s) => s.cwd).filter(Boolean)])];
  console.log(`\n${C.green('👁')}  Watching ${C.cyan(cwd)} → ${C.cyan(apiUrl)}  ${C.dim('(Ctrl-C to stop)')}`);

  let lastSig = watchSignature(repoPaths); // baseline; don't push on startup
  let pendingSince = 0;
  let busy = false;
  const DEBOUNCE = 1500;

  const tick = async () => {
    if (busy) return;
    let sig;
    try { sig = watchSignature(repoPaths); } catch { return; }
    if (sig !== lastSig) { lastSig = sig; pendingSince = Date.now(); return; } // changed — wait to settle
    if (!pendingSince || Date.now() - pendingSince < DEBOUNCE) return;
    pendingSince = 0;
    busy = true;
    try {
      const sessions = await discoverSessions(cwd);
      const parsed = [];
      for (const s of sessions) {
        try { parsed.push(s.source === 'claude' ? await parseClaude(s.file) : await parseCodex(s.file)); } catch { /* skip */ }
      }
      const { bundle } = await assembleBundle(cwd, sessions, parsed, { includeMemory });
      const { url } = await pushBundle(bundle, { isPublic });
      console.log(C.dim(`  ↑ ${new Date().toLocaleTimeString()} — pushed ${parsed.length} session(s) → ${url}`));
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
      console.log(C.dim('  (bundle was not saved locally; fix the endpoint and retry, or run `vbrt add` for a local copy)'));
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

function cmdHelp() {
  console.log(`
${C.bold('vbrt')} — browse old Codex & Claude Code sessions as projects

  ${C.cyan('vbrt')} ${C.dim('|')} ${C.cyan('vbrt add')}     Pick this folder's sessions and save them locally
  ${C.cyan('vbrt login <token>')}  Connect this machine to your account (token from the dashboard)
  ${C.cyan('vbrt push')}          Upload to your private dashboard (needs VBRT_API_URL)
  ${C.cyan('vbrt push --public')}   Publish on push (share a link immediately; default is private)
  ${C.cyan('vbrt push --no-memory')} Push without this repo's agent memory (memory is included by default)
  ${C.cyan('vbrt watch')}         Re-push automatically when the brain docs / git change (live streaming)
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
