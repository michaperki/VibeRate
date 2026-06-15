#!/usr/bin/env node
// Heavy deps (@inquirer/prompts, express) are loaded lazily inside the commands
// that need them, so `vbrt push` runs with only Node builtins + fetch — which is
// what lets the skill bundle ship without node_modules.
import { discoverSessions } from '../src/discover.js';
import { parseClaude, parseCodex } from '../src/parsers.js';
import { saveBundle } from '../src/storage.js';
import { extractGit } from '../src/git.js';
import { extractDocsMulti } from '../src/docs.js';
import { extractMemory } from '../src/workspace.js';
import { buildBundle } from '../src/bundle.js';
import { pushBundle, apiBase } from '../src/push.js';
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

  // Capture git history for the timeline overlay. The repo may live at a
  // different path than cwd (e.g. /home vs /mnt/c), so try every cwd seen in
  // the discovered sessions and merge, deduping commits by hash.
  const repoPaths = [...new Set([cwd, ...sessions.map((s) => s.cwd).filter(Boolean)])];
  const seen = new Set();
  const commits = [];
  for (const p of repoPaths) {
    const g = await extractGit(p);
    if (!g) continue;
    for (const c of g.commits) {
      if (!seen.has(c.hash)) {
        seen.add(c.hash);
        commits.push(c);
      }
    }
  }
  commits.sort((a, b) => b.t - a.t);

  // Capture the project's agent/AI-architecture markdown (the "centerpiece").
  const docs = extractDocsMulti(repoPaths);

  // Capture this repo's cold-start memory (its own notes + adopted project notes),
  // unless suppressed. Scoped to the repo; redacted before any upload.
  const includeMemory = !args.includes('--no-memory');
  const memory = includeMemory ? extractMemory(cwd) : null;
  const memNoteCount = memory && memory.ok ? memory.notes.length : 0;

  // One bundle, then route to a sink. Same payload either way.
  const bundle = buildBundle(cwd, {
    sessions: parsed,
    git: commits.length ? { cwd, capturedAt: new Date().toISOString(), commits } : null,
    docs,
    memory,
  });
  console.log(
    C.dim(
      `Captured ${commits.length} git commit(s); ${docs.length} agent doc(s)${docs.length ? `: ${docs.map((d) => d.name).join(', ')}` : ''}; ` +
        `${includeMemory ? `${memNoteCount} memory note(s)` : 'memory excluded (--no-memory)'}.`,
    ),
  );

  if (push) {
    try {
      const { url, dashboardUrl, newToken, tokenPath } = await pushBundle(bundle);
      console.log(C.green(`\n✓ Pushed project "${bundle.project.slug}" — view & share at:`));
      console.log(`  ${C.cyan(url)}`);
      console.log(C.dim(`  Your projects: ${dashboardUrl}`));
      if (newToken) {
        console.log(C.dim(`  (saved an access token to ${tokenPath} — keep it to manage your projects)`));
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
  ${C.cyan('vbrt push')}          Pick sessions and upload to the hosted viewer (needs VBRT_API_URL)
  ${C.cyan('vbrt push --no-memory')} Push without this repo's agent memory (memory is included by default)
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
