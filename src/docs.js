import fs from 'node:fs';
import path from 'node:path';

// Agent/AI-architecture markdown we use as entry points (seeds) for the brain,
// in display-priority order. Matched case-insensitively at the repo root.
const KNOWN = [
  'SOUL.md',
  'AGENTS.md',
  'AGENT.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  'SEED.md',
  'CONTEXT.md',
  'MEMORY.md',
  'BACKLOG.md',
  'DECISIONS.md',
  'ATTEMPTS.md',
  'LOG.md',
  'ROADMAP.md',
  'PROJECT.md',
  'TASKS.md',
  'README.md',
];
const KNOWN_UPPER = new Set(KNOWN.map((n) => n.toUpperCase()));
const MAX_BYTES = 512 * 1024;
const MAX_DOCS = 50;

// The agent-doc basenames (lowercased) that seed brain time-travel history, and a
// loose "brain-ish" matcher for docs that no longer exist in the tree (so a
// *deleted* plan still ghost-nodes in the scrubber). Canonical home for both —
// shared by the capture path (`vbrt push`) and the Drive turn-end refresh
// (driveIngest) so they decide "what counts as a brain doc" identically.
export const AGENT_DOCS = ['soul.md', 'agents.md', 'agent.md', 'claude.md', 'claude.local.md', 'seed.md', 'context.md', 'memory.md', 'backlog.md', 'decisions.md', 'attempts.md', 'log.md', 'roadmap.md', 'project.md', 'tasks.md'];
export const BRAINISH = /soul|agents?|claude|seed|roadmap|backlog|tasks|memory|context|decisions|attempts|plan|stream|_next_pass/i;

// The set of doc basenames (lowercased) whose per-commit history we keep for the
// brain time-travel scrubber: the live brain-graph nodes (`docs`) ∪ the known
// agent-doc names ∪ any brain-ish doc that was *deleted* somewhere in `commits`.
export function brainBasenames(docs = [], commits = []) {
  const set = new Set([...docs.map((d) => d.name.split('/').pop().toLowerCase()), ...AGENT_DOCS]);
  for (const c of commits) for (const d of c.docs || []) {
    const base = (d.name || '').split('/').pop();
    if (d.status === 'deleted' && BRAINISH.test(base)) set.add(base.toLowerCase());
  }
  return set;
}

function readDoc(full, displayName) {
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return {
      name: displayName,
      content: fs.readFileSync(full, 'utf8'),
      bytes: st.size,
      mtime: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

// Find markdown-file references inside a doc: [text](path.md) links and bare
// path mentions like `docs/PROJECT_SOUL.md`.
function mdRefs(content) {
  const refs = new Set();
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/gi)) refs.add(m[1]);
  for (const m of content.matchAll(/(?:^|[\s`(>])([A-Za-z0-9_][A-Za-z0-9_./-]*\.md)\b/g)) refs.add(m[1]);
  return [...refs];
}

// Capture the agent docs at a repo path: the known entry files + .agent/*.md,
// then everything they reference (transitively), so a "Documentation Map" in
// SOUL/AGENTS pulls in docs/PROJECT_SOUL.md, docs/ARCHITECTURE.md, etc.
export function extractDocs(cwd) {
  const norm = (p) => path.resolve(p).replace(/\\/g, '/');
  const root = norm(cwd);
  const within = (abs) => norm(abs).toLowerCase().startsWith(root.toLowerCase() + '/') || norm(abs).toLowerCase() === root.toLowerCase();

  const out = new Map(); // displayName(lower) -> doc
  const visited = new Set(); // abs(lower)
  const queue = [];
  const enqueue = (abs, display) => {
    const key = norm(abs).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    queue.push({ abs: path.resolve(abs), display });
  };

  // seeds: known root files
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (e.isFile() && KNOWN_UPPER.has(e.name.toUpperCase())) enqueue(path.join(cwd, e.name), e.name);
  }
  // seeds: .agent/*.md
  try {
    for (const e of fs.readdirSync(path.join(cwd, '.agent'), { withFileTypes: true })) {
      if (e.isFile() && /\.md$/i.test(e.name)) enqueue(path.join(cwd, '.agent', e.name), `.agent/${e.name}`);
    }
  } catch {
    /* no .agent dir */
  }

  // BFS, following references
  while (queue.length && out.size < MAX_DOCS) {
    const { abs, display } = queue.shift();
    const doc = readDoc(abs, display);
    if (!doc) continue;
    out.set(display.toLowerCase(), doc);
    const dir = path.dirname(abs);
    for (const ref of mdRefs(doc.content)) {
      for (const cand of [path.resolve(dir, ref), path.resolve(cwd, ref)]) {
        if (!within(cand) || !fs.existsSync(cand)) continue;
        if (/\/(archive|node_modules|\.git)\//i.test(norm(cand))) continue; // skip noise
        enqueue(cand, norm(cand).slice(root.length + 1)); // repo-relative display
        break;
      }
    }
  }
  return [...out.values()];
}

// Merge docs from several candidate repo paths (dual-path: /home vs /mnt/c),
// keeping the first occurrence of each name. Returns sorted by priority.
export function extractDocsMulti(cwds) {
  const byName = new Map();
  for (const cwd of cwds) {
    for (const doc of extractDocs(cwd)) {
      const key = doc.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, doc);
    }
  }
  const priority = (name) => {
    const base = name.split('/').pop().toUpperCase();
    const i = KNOWN.findIndex((k) => k.toUpperCase() === base);
    const rank = i === -1 ? KNOWN.length : i;
    return name.includes('/') ? rank + 100 : rank; // root files before subdir/.agent
  };
  return [...byName.values()].sort((a, b) => priority(a.name) - priority(b.name));
}
