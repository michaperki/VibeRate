import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { claudeRoots, slugify } from './paths.js';
import { listProjects } from './storage.js';
import { preloadedFiles } from './instructions.js';

const require = createRequire(import.meta.url);

// Tier-1 (workspace) data: the agent's cross-project memory + a projects rollup.
//
// Two agents store memory very differently, so we normalize both into one shape:
//   note  = { source, authored, title, description, type, body, mtime, loading, recallCount }
//   store = { source, key, scope, name, projectSlug, index, notes[] }
// `source` lets the UI badge Claude vs Codex; `scope` ('workspace' | 'project')
// + `projectSlug` let it route project-specific memory to its project instead of
// flattening everything into one global blob; `loading` ('always' | 'recall')
// expresses *when* a memory enters model context.
//
// Claude: user-curated markdown, one store per working directory, an always-loaded
//   MEMORY.md index + recalled-on-relevance notes.
// Codex: auto-distilled from sessions into SQLite (stage1_outputs.raw_memory),
//   ranked by usage_count — recall is data, not a guess. Gated behind
//   VBRT_CODEX_MEMORY=1 for now (experimental node:sqlite; data often empty).

const MAX_BYTES = 256 * 1024;

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: content };
  const block = m[1];
  const grab = (k) => {
    const r = block.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm'));
    return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined;
  };
  return {
    meta: { name: grab('name'), description: grab('description'), type: grab('type') },
    body: content.slice(m[0].length),
  };
}

// Decode a Claude store dir name back to an approximate path + a display name.
// Claude encodes '/' as '-', so internal dashes are ambiguous; we lean on the
// user's `.../dev/<project>` convention for a clean name and keep the raw key as
// the source of truth.
function describeStore(key) {
  const segs = key.replace(/^-/, '').split('/').join('-').split('-');
  const devIdx = segs.lastIndexOf('dev');
  const tail = devIdx >= 0 && devIdx < segs.length - 1 ? segs.slice(devIdx + 1).join('-') : segs[segs.length - 1];
  return { rawPath: '/' + key.replace(/^-/, '').replace(/-/g, '/'), tail };
}

const projNorm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function readClaudeMemory(projects) {
  // Match a store to a project by normalized leaf name, so a project captured
  // from a Windows mount (/mnt/c/...) still matches memory created from its
  // WSL-home path (/home/...). See project-viberate-env.
  const projByName = new Map(projects.map((p) => [projNorm(p.slug), p]));
  const raw = []; // { key, files: [...] }
  for (const root of claudeRoots()) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const memDir = path.join(root, e.name, 'memory');
      let dirents;
      try {
        dirents = fs.readdirSync(memDir, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = [];
      for (const f of dirents) {
        if (!f.isFile() || !/\.md$/i.test(f.name)) continue;
        const full = path.join(memDir, f.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size > MAX_BYTES) continue;
        const content = fs.readFileSync(full, 'utf8');
        const { meta, body } = parseFrontmatter(content);
        const isIndex = f.name.toUpperCase() === 'MEMORY.MD';
        files.push({
          source: 'claude',
          authored: 'curated',
          name: f.name,
          title: meta.name || f.name.replace(/\.md$/i, ''),
          description: meta.description || '',
          type: meta.type || (isIndex ? 'index' : 'note'),
          body,
          bytes: st.size,
          mtime: st.mtimeMs,
          loading: isIndex ? 'always' : 'recall',
          recallCount: null,
        });
      }
      if (files.length) raw.push({ key: e.name, files });
    }
  }

  // A store is 'workspace' scope if it's an ancestor dir of another store
  // (e.g. .../dev contains .../dev-catain); otherwise it's project-scoped.
  const keys = raw.map((r) => r.key);
  const isAncestor = (k) => keys.some((o) => o !== k && o.startsWith(k + '-'));

  const stores = raw.map(({ key, files }) => {
    const scope = isAncestor(key) ? 'workspace' : 'project';
    const { tail } = describeStore(key);
    const proj = scope === 'project' ? projByName.get(projNorm(tail)) : null;
    return {
      source: 'claude',
      key,
      scope,
      projectSlug: proj ? proj.slug : null,
      name: proj ? proj.name || proj.slug : scope === 'workspace' ? `Workspace · ${tail}` : tail,
      index: files.find((f) => f.type === 'index') || null,
      notes: files.filter((f) => f.type !== 'index').sort((a, b) => b.mtime - a.mtime),
    };
  });
  return stores;
}

// Codex: auto-distilled memory from SQLite. Same store/note shape, source 'codex'.
function readCodexMemory() {
  if (process.env.VBRT_CODEX_MEMORY !== '1') return []; // opt-in; experimental + often empty
  const dbPath = path.join(os.homedir(), '.codex', 'memories_1.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return []; // node < 22.5
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT * FROM stage1_outputs ORDER BY usage_count DESC').all();
    const notes = rows.map((r) => ({
      source: 'codex',
      authored: 'auto', // machine-distilled, not user-written
      name: r.rollout_slug || r.thread_id,
      title: r.rollout_slug || 'Distilled memory',
      description: String(r.rollout_summary || '').slice(0, 200),
      type: 'distilled',
      body: r.raw_memory || '',
      mtime: Date.parse(r.generated_at) || 0,
      loading: 'recall',
      recallCount: r.usage_count ?? null, // Codex tracks real recall counts
    }));
    return notes.length
      ? [{ source: 'codex', key: 'codex', scope: 'workspace', projectSlug: null, name: 'Codex (distilled)', index: null, notes }]
      : [];
  } catch {
    return [];
  }
}

// A `project`-typed note stored in a workspace-scoped store is topically about
// one repo — adopt it onto that repo's page when the slug shows up in the note's
// name/title/description. (Body is excluded to avoid passing-mention false hits.)
function noteMatchesProject(note, slug) {
  const target = projNorm(slug);
  if (!target) return false;
  return projNorm(`${note.name} ${note.title} ${note.description}`).includes(target);
}

// Core: assemble a repo's Tier-2 cold-start context from a slug + cwd + the
// project list used to attribute stores. Shared by the live read (getProjectMemory,
// for the local viewer) and the capture-time extract (extractMemory, for the push
// bundle), so both produce the identical shape the project page renders.
function projectMemoryFrom(slug, cwd, projects) {
  const stores = readClaudeMemory(projects);
  const store = stores.find((s) => s.projectSlug === slug);
  // Drop absolute paths — they'd leak the user's home-dir layout on a shared link;
  // the viewer only needs agent/name/bytes.
  const preloaded = (cwd ? preloadedFiles(cwd) : []).map((f) => ({ agent: f.agent, name: f.name, bytes: f.bytes }));

  const adopted = stores
    .filter((s) => s.scope === 'workspace')
    .flatMap((s) => s.notes)
    .filter((n) => n.type === 'project' && noteMatchesProject(n, slug));

  const notes = [...(store ? store.notes : []), ...adopted].sort((a, b) => b.mtime - a.mtime);
  if (!store && !preloaded.length && !notes.length) return { ok: false, notes: [], index: null, preloaded: [] };
  return {
    ok: true,
    name: (store && store.name) || slug,
    index: store ? store.index : null,
    notes,
    preloaded,
  };
}

// Live read for the local viewer: resolve cwd from the captured project list.
export function getProjectMemory(slug) {
  const projects = listProjects();
  const project = projects.find((p) => p.slug === slug);
  return projectMemoryFrom(slug, project && project.cwd, projects);
}

// Capture-time read for the push/local bundle: we have the cwd directly (the repo
// may not be a captured project yet), so attribute stores against a one-entry list.
export function extractMemory(cwd) {
  if (!cwd) return { ok: false, notes: [], index: null, preloaded: [] };
  const slug = slugify(cwd);
  return projectMemoryFrom(slug, cwd, [{ slug, cwd, name: slug }]);
}

export function getWorkspace() {
  const projects = listProjects();
  const stores = [...readClaudeMemory(projects), ...readCodexMemory()];
  // annotate each project with how many memory notes are scoped to it
  const memByProject = new Map();
  for (const s of stores) if (s.projectSlug) memByProject.set(s.projectSlug, (memByProject.get(s.projectSlug) || 0) + s.notes.length);
  const projectsOut = projects.map((p) => ({ ...p, memCount: memByProject.get(p.slug) || 0 }));
  return {
    memory: { ok: stores.some((s) => s.notes.length || s.index), stores },
    projects: projectsOut,
  };
}
