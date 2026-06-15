import fs from 'node:fs';
import path from 'node:path';

// The instruction files an agent preloads when launched in a directory: the
// CLAUDE.md / CLAUDE.local.md / AGENTS.md chain walked from the directory up
// toward the filesystem root (nearest first). Always-loaded, deterministic.
// Global ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md are handled separately (they
// belong to the workspace/home tier, not a single repo).

function statFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function walkUp(dir, filename, agent) {
  const out = [];
  let cur = path.resolve(dir);
  for (let i = 0; i < 12; i++) {
    const st = statFile(path.join(cur, filename));
    if (st) out.push({ agent, name: filename, path: path.join(cur, filename), bytes: st.size });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

export function preloadedFiles(dir) {
  if (!dir) return [];
  return [
    ...walkUp(dir, 'CLAUDE.md', 'claude'),
    ...walkUp(dir, 'CLAUDE.local.md', 'claude'),
    ...walkUp(dir, 'AGENTS.md', 'codex'),
  ];
}
