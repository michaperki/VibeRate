import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The Tier-1 (home) cold-start context: the *global* facts loaded into every
// agent session, any directory — from ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md,
// decomposed into atomic facts. That's the only thing that's genuinely global.
// Per-repo memory lives on each project page (see getProjectMemory) — we don't
// build a "cross-project memory" pool, because whether a note is project-specific
// is the author's judgment (where they file it), not something we can parse.

const HOME = os.homedir();

function stat(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

function globalFile(rel) {
  const p = path.join(HOME, rel);
  const st = stat(p);
  return st ? { path: p, bytes: st.size } : null;
}

// Decompose a memory/instruction file into atomic items: `##` headings define
// sections; bullets and non-empty prose lines become individual atoms. This is
// the unit the UI renders — a fact, not a file — so it scales from two bullets to
// a large file or a network of files.
function parseAtoms(content) {
  const atoms = [];
  let section = '';
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const b = line.match(/^[-*]\s+(.*)/) || line.match(/^\d+\.\s+(.*)/);
    atoms.push({ text: (b ? b[1] : line).trim(), section });
  }
  return atoms;
}

const normText = (t) => t.toLowerCase().replace(/\s+/g, ' ').trim();

// Merge atoms from each agent's global file, deduping identical facts and
// recording which agents know each one.
function globalAtoms(sources) {
  const map = new Map();
  for (const { agent, content } of sources) {
    for (const a of parseAtoms(content)) {
      const k = `${a.section}::${normText(a.text)}`;
      if (!map.has(k)) map.set(k, { text: a.text, section: a.section, agents: [] });
      const e = map.get(k);
      if (!e.agents.includes(agent)) e.agents.push(agent);
    }
  }
  return [...map.values()];
}

export function getContext() {
  // Only the user's *own* global instruction files are read here — no scan of
  // other repos' memory dirs. Per-repo memory is loaded per project page.
  const claudeGlobal = globalFile('.claude/CLAUDE.md');
  const codexGlobal = globalFile('.codex/AGENTS.md');
  const sources = [];
  if (claudeGlobal) sources.push({ agent: 'claude', content: fs.readFileSync(claudeGlobal.path, 'utf8') });
  if (codexGlobal) sources.push({ agent: 'codex', content: fs.readFileSync(codexGlobal.path, 'utf8') });
  const global = {
    claude: claudeGlobal ? [{ kind: '~/.claude/CLAUDE.md', ...claudeGlobal }] : [],
    codex: codexGlobal ? [{ kind: '~/.codex/AGENTS.md', ...codexGlobal }] : [],
    atoms: globalAtoms(sources), // always-loaded facts, deduped across agents
    note: "Available skills' name+description are also always in context.",
  };

  return { global };
}
