import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR, slugify } from './paths.js';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function projectDir(slug) {
  return path.join(PROJECTS_DIR, slug);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Local sink: persist a capture bundle to the on-disk store the viewer reads.
// Mirror of what the hosted ingest API does server-side, so the two sinks stay
// behavior-compatible. `opts.slug` overrides the cwd-derived slug (used for
// hosted projects keyed by a random id); `opts.name` sets the display name.
export function saveBundle(bundle, opts = {}) {
  const { project, sessions, git, docs, memory } = bundle;
  const cwd = project.cwd;
  const result = saveSessions(cwd, sessions, opts);
  if (git) saveGit(cwd, git, opts.slug);
  if (docs && docs.docs) saveDocs(cwd, docs.docs, opts.slug);
  if (memory && memory.ok) saveMemory(cwd, memory, opts.slug);
  return result;
}

// Server-side ingest: store a pushed bundle under a fresh unguessable id and
// return { id }. The id doubles as the project slug, so every existing read
// endpoint (`/api/projects/:slug/...`) serves hosted projects unchanged. `owner`
// (a hashed token) scopes the project to its pusher for list enumeration.
export function ingestBundle(bundle, owner = null) {
  const id = crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars, unlisted
  saveBundle(bundle, { slug: id, name: (bundle.project && bundle.project.name) || id, owner });
  return { id };
}

// Persist a set of normalized sessions under a project slug derived from cwd
// (or `opts.slug`). Returns { slug, added, skipped, total }.
export function saveSessions(cwd, sessions, opts = {}) {
  const slug = opts.slug || slugify(cwd);
  const dir = projectDir(slug);
  const sessionsDir = path.join(dir, 'sessions');
  ensureDir(sessionsDir);

  const manifestPath = path.join(dir, 'project.json');
  const manifest = readJson(manifestPath, {
    slug,
    cwd,
    name: opts.name || slug,
    createdAt: new Date().toISOString(),
    sessions: [],
  });
  manifest.cwd = cwd;
  if (opts.name) manifest.name = opts.name;
  if (opts.owner) manifest.owner = opts.owner; // hashed token; gist-style ownership

  const existingIds = new Set(manifest.sessions.map((s) => s.id));
  let added = 0;
  let skipped = 0;

  for (const session of sessions) {
    const fileId = `${session.source}-${session.id}`;
    const outPath = path.join(sessionsDir, `${fileId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(session, null, 2));
    const summary = {
      id: fileId,
      source: session.source,
      title: session.title,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      messageCount: session.messageCount,
    };
    if (existingIds.has(fileId)) {
      manifest.sessions = manifest.sessions.map((s) => (s.id === fileId ? summary : s));
      skipped++;
    } else {
      manifest.sessions.push(summary);
      added++;
    }
  }

  manifest.sessions.sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
  );
  manifest.updatedAt = new Date().toISOString();
  ensureDir(dir);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { slug, added, skipped, total: manifest.sessions.length };
}

// List captured projects. With `owner` (a hashed token) set, return only that
// owner's projects — used by the hosted dashboard so one pusher can't enumerate
// another's. Local `vbrt serve` calls it with no owner and sees everything.
export function listProjects(owner = null) {
  let slugs;
  try {
    slugs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const e of slugs) {
    if (!e.isDirectory()) continue;
    const manifest = readJson(path.join(PROJECTS_DIR, e.name, 'project.json'), null);
    if (!manifest) continue;
    if (owner && manifest.owner !== owner) continue;
    projects.push(manifest);
  }
  projects.sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')),
  );
  return projects;
}

export function getProject(slug) {
  return readJson(path.join(projectDir(slug), 'project.json'), null);
}

export function getSession(slug, sessionId) {
  return readJson(path.join(projectDir(slug), 'sessions', `${sessionId}.json`), null);
}

// Git history captured at add-time (commits for the timeline overlay).
export function saveGit(cwd, git, slug = slugify(cwd)) {
  if (!git) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'git.json'), JSON.stringify(git));
}

export function getGit(slug) {
  return readJson(path.join(projectDir(slug), 'git.json'), null);
}

// Agent/AI-architecture markdown snapshots captured at add-time.
export function saveDocs(cwd, docs, slug = slugify(cwd)) {
  if (!docs || docs.length === 0) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'docs.json'), JSON.stringify({ capturedAt: new Date().toISOString(), docs }));
}

export function getDocs(slug) {
  return readJson(path.join(projectDir(slug), 'docs.json'), null);
}

// This repo's cold-start memory snapshot, captured at add/push-time. Read by the
// server as a fallback when no live ~/.claude store is present (i.e. hosted).
export function saveMemory(cwd, memory, slug = slugify(cwd)) {
  if (!memory || !memory.ok) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(memory));
}

export function getMemory(slug) {
  return readJson(path.join(projectDir(slug), 'memory.json'), null);
}

// Per-session activity for the timeline: timestamps of the messages the USER
// sent (their prompts), plus the user-message count. Tool calls and agent
// replies are excluded — they're not "messages I sent". Also derives, from the
// agent's edit tool calls, which files were touched and approx lines +/-.
export function getActivity(slug) {
  const project = getProject(slug);
  if (!project) return null;
  const out = [];
  for (const summary of project.sessions) {
    const s = getSession(slug, summary.id);
    if (!s) continue;
    const msgs = s.messages
      .filter((m) => m.kind === 'text' && m.role === 'user')
      .map((m) => ({
        t: Date.parse(m.ts),
        text: String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }))
      .filter((m) => !Number.isNaN(m.t));

    const files = new Set();
    let added = 0;
    let removed = 0;
    let edits = 0;
    for (const m of s.messages) {
      const d = editStat(m);
      if (!d) continue;
      edits++;
      added += d.added;
      removed += d.removed;
      for (const f of d.files) files.add(relPath(f, s.cwd));
    }

    out.push({
      id: summary.id,
      source: summary.source,
      title: summary.title,
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      userCount: msgs.length,
      totalCount: s.messages.length,
      msgs,
      files: [...files].slice(0, 50),
      fileCount: files.size,
      added,
      removed,
      edits,
    });
  }
  return out;
}

// Shorten an absolute edited-file path to repo-relative for display.
function relPath(file, cwd) {
  const f = String(file).replace(/\\/g, '/');
  if (cwd) {
    const c = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    if (f.toLowerCase().startsWith(c.toLowerCase() + '/')) return f.slice(c.length + 1);
    const base = c.split('/').pop();
    const idx = f.toLowerCase().lastIndexOf('/' + base.toLowerCase() + '/');
    if (idx >= 0) return f.slice(idx + base.length + 2);
  }
  return f;
}

// Approximate per-tool-call diff stats from an agent edit (Write/Edit/MultiEdit
// for Claude, apply_patch for Codex). Returns null for non-edit tool calls.
function editStat(m) {
  if (m.kind !== 'tool_use') return null;
  const name = (m.name || '').toLowerCase();
  const inp = m.input;
  const lines = (v) => (v ? String(v).split('\n').length : 0);

  // Codex apply_patch (string patch in input / arguments).
  const patchText = [inp, inp && inp.input, inp && inp.patch, inp && inp.content].find(
    (v) => typeof v === 'string' && /\*\*\*\s+(Add|Update|Delete) File:/.test(v),
  );
  if (patchText || /apply_patch/.test(name)) {
    const patch = patchText || '';
    const files = [...patch.matchAll(/\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)/g)].map((x) => x[1].trim());
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
      if (/^\+/.test(line) && !/^\+\+\+/.test(line)) added++;
      else if (/^-/.test(line) && !/^---/.test(line)) removed++;
    }
    return { files, added, removed };
  }
  if (!inp || typeof inp !== 'object') return null;
  const file = inp.file_path || inp.path || inp.notebook_path;
  if (Array.isArray(inp.edits)) {
    // Claude MultiEdit
    let added = 0;
    let removed = 0;
    for (const e of inp.edits) {
      added += lines(e.new_string);
      removed += lines(e.old_string);
    }
    return { files: file ? [file] : [], added, removed };
  }
  if (inp.new_string !== undefined || inp.old_string !== undefined) {
    return { files: file ? [file] : [], added: lines(inp.new_string), removed: lines(inp.old_string) };
  }
  if (/write/.test(name) && (inp.content !== undefined || inp.file_text !== undefined)) {
    return { files: file ? [file] : [], added: lines(inp.content ?? inp.file_text), removed: 0 };
  }
  return null;
}
