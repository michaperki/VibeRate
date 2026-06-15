#!/usr/bin/env node
// Assemble the installable VibeRate skill from this repo's source, so the
// skill stays a thin copy of one source of truth. Bundles only what the push
// path needs (no node_modules — the client is pure Node + fetch).
//
// Usage:
//   node scripts/build-skill.mjs [targetDir]   # install for local use (default)
//   node scripts/build-skill.mjs --plugin       # populate the committed marketplace plugin
//
// Default targetDir is the user's personal skills folder, which makes the skill
// available in every project on this machine immediately (Claude Code watches it
// live). `--plugin` builds into plugins/viberate/skills/viberate so the
// marketplace plugin ships a self-contained, working skill — run it before
// committing/publishing. Or pass any path (e.g. a project's .claude/skills).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const target =
  arg === '--plugin'
    ? path.join(repo, 'plugins', 'viberate', 'skills', 'viberate')
    : path.resolve(arg || path.join(os.homedir(), '.claude', 'skills', 'viberate'));

// Files the push client actually loads (everything except the express server,
// which is only used by `vbrt serve`). We copy all of src/ anyway for simplicity
// — server.js just never gets imported on the push path.
const SRC_FILES = fs.readdirSync(path.join(repo, 'src')).filter((f) => f.endsWith('.js'));

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function build() {
  // clean client dir so removed files don't linger
  const clientDir = path.join(target, 'client');
  fs.rmSync(clientDir, { recursive: true, force: true });

  copy(path.join(repo, 'skill', 'SKILL.md'), path.join(target, 'SKILL.md'));
  copy(path.join(repo, 'bin', 'vbrt.js'), path.join(clientDir, 'bin', 'vbrt.js'));
  for (const f of SRC_FILES) copy(path.join(repo, 'src', f), path.join(clientDir, 'src', f));

  // Minimal package so Node treats the bundled .js as ES modules.
  fs.writeFileSync(
    path.join(clientDir, 'package.json'),
    JSON.stringify({ name: 'viberate-client', private: true, type: 'module' }, null, 2) + '\n',
  );

  console.log(`✓ Built skill at ${target}`);
  console.log(`  SKILL.md + client/ (${SRC_FILES.length} src files, no node_modules)`);
  console.log(`  The agent runs:  node "\${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all`);
}

build();
