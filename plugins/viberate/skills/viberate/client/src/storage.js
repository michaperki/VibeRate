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
  const { project, sessions, git, docs, memory, docHistory, evidence, stream } = bundle;
  const cwd = project.cwd;
  const result = saveSessions(cwd, sessions, opts);
  if (git) saveGit(cwd, git, opts.slug);
  if (docs && docs.docs) saveDocs(cwd, docs.docs, opts.slug);
  if (docHistory) saveDocHistory(cwd, docHistory, opts.slug);
  if (memory && memory.ok) saveMemory(cwd, memory, opts.slug);
  if (evidence) saveEvidence(cwd, evidence, opts.slug);
  if (stream) saveStream(cwd, stream, opts.slug);
  return result;
}

// Normalized repo identity for upsert matching (path-spelling/trailing-slash
// insensitive). Same repo re-pushed → same key → same hosted project.
function repoKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Find an existing project from the same repo path, so a re-push updates it
// instead of minting a duplicate. With an `owner` (hosted) it matches only within
// that owner's projects (never across owners); with `owner` null (local, single-
// user `vbrt serve`) it matches any project by path — so local pushes are
// idempotent by repo, which is what makes the live-streaming dev loop work.
function findOwnedProjectByCwd(owner, cwd) {
  const key = repoKey(cwd);
  if (!key) return null;
  return listProjects(owner).find((m) => repoKey(m.cwd) === key) || null;
}

// Server-side ingest: store a pushed bundle under an unguessable id and return
// { id }. The id doubles as the project slug, so every read endpoint
// (`/api/projects/:slug/...`) serves hosted projects unchanged. `owner` (a hashed
// token) scopes the project to its pusher. Re-pushing the *same repo* as the same
// owner **upserts** — it reuses the existing id (stable share link) and merges
// sessions, rather than creating a second copy.
export function ingestBundle(bundle, { owner = null, visibility = null } = {}) {
  const cwd = bundle.project && bundle.project.cwd;
  const existing = findOwnedProjectByCwd(owner, cwd);
  const id = existing ? existing.slug : crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars, unlisted
  saveBundle(bundle, { slug: id, name: (bundle.project && bundle.project.name) || id, owner, visibility });
  const manifest = getProject(id);
  return { id, updated: !!existing, visibility: manifest && manifest.visibility };
}

// Flip a project public/private (the "publish" action). Returns the manifest.
export function setVisibility(slug, visibility) {
  const manifestPath = path.join(projectDir(slug), 'project.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest) return null;
  manifest.visibility = visibility === 'public' ? 'public' : 'private';
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
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
  if (opts.visibility && !manifest.visibility) manifest.visibility = opts.visibility; // set once at create; publish toggles it later

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
      lastUserText: session.lastUserText || null,
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
  manifest.lastPushAt = Date.now(); // last bundle ingest — drives the viewer's "is this streaming?" auto-Live (distinct from updatedAt, which a visibility toggle also bumps)
  ensureDir(dir);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { slug, added, skipped, total: manifest.sessions.length };
}

// List captured projects. With `owner` set (a hashed token, or an array of them
// for a multi-token account) return only those owners' projects — so one pusher
// can't enumerate another's. Local `vbrt serve` passes nothing and sees everything.
export function listProjects(owner = null) {
  const owners = owner == null ? null : Array.isArray(owner) ? owner : [owner];
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
    if (owners && !owners.includes(manifest.owner)) continue;
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

// Intent classification: a map of cardId -> { archetype, confidence, rationale },
// built incrementally at ingest (see classify.js). Keyed by cardId so a prompt is
// classified once, ever, and survives re-pushes.
export function saveClassify(slug, map) {
  if (!map) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'classify.json'), JSON.stringify(map));
}

export function getClassify(slug) {
  return readJson(path.join(projectDir(slug), 'classify.json'), {});
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

// Per-brain-doc version history (content at each changing commit) for time-travel.
export function saveDocHistory(cwd, docHistory, slug = slugify(cwd)) {
  if (!docHistory || !Object.keys(docHistory).length) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ capturedAt: new Date().toISOString(), docHistory }));
}

export function getDocHistory(slug) {
  return readJson(path.join(projectDir(slug), 'history.json'), null);
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

// Real-time agent activity from Claude Code hooks (the tail of working/idle, tool,
// and context-load events). Overwrites each push with the latest tail; getTicker
// prefers it over parsing the (flush-lagged) session log when it's fresh.
export function saveStream(cwd, stream, slug = slugify(cwd)) {
  if (!stream || !stream.events || !stream.events.length) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'stream.json'), JSON.stringify({ capturedAt: new Date().toISOString(), events: stream.events }));
}

export function getStream(slug) {
  return readJson(path.join(projectDir(slug), 'stream.json'), null);
}

// Author-captured evidence artifacts (screenshots/gifs), each bound to a session
// + capture time so the reader can place it on the prompt that produced it. The
// bundle carries the full set each push, so this overwrites idempotently.
export function saveEvidence(cwd, evidence, slug = slugify(cwd)) {
  if (!evidence || !evidence.length) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ capturedAt: new Date().toISOString(), evidence }));
}

export function getEvidence(slug) {
  const data = readJson(path.join(projectDir(slug), 'evidence.json'), null);
  return data && data.evidence ? data.evidence : [];
}

// Overarching ("workspace") rollup across one owner's projects, built only from
// already-pushed data — no machine-local reads. Aggregates each project's memory
// notes into a single list tagged with which projects they came from, plus
// headline activity stats. With `owner` null (local), spans every project.
export function getWorkspaceRollup(owner = null) {
  const projects = listProjects(owner);
  let sessions = 0;
  let messages = 0;
  let commits = 0;
  let added = 0;
  let removed = 0;
  const memMap = new Map(); // type::title -> note + the projects it appears in

  for (const p of projects) {
    sessions += (p.sessions || []).length;
    for (const a of getActivity(p.slug) || []) {
      messages += a.userCount || 0;
      added += a.added || 0;
      removed += a.removed || 0;
    }
    const g = getGit(p.slug);
    if (g && Array.isArray(g.commits)) commits += g.commits.length;

    const mem = getMemory(p.slug);
    if (mem && mem.ok) {
      for (const n of mem.notes || []) {
        const key = `${n.type}::${String(n.title || '').toLowerCase().trim()}`;
        if (!memMap.has(key)) {
          memMap.set(key, { title: n.title, description: n.description, type: n.type, body: n.body, mtime: n.mtime || 0, projects: [] });
        }
        const e = memMap.get(key);
        if (!e.projects.some((x) => x.id === p.slug)) e.projects.push({ id: p.slug, name: p.name || p.slug });
        if ((n.mtime || 0) > e.mtime) e.mtime = n.mtime;
      }
    }
  }

  const memory = [...memMap.values()].sort((a, b) => b.mtime - a.mtime);
  return { stats: { projects: projects.length, sessions, messages, commits, added, removed }, memory };
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

// Coarse category for a tool name — drives the ticker verb + dot color. Mirrors
// the viewer's classifyTool so the live ticker reads the same as the convo chips.
const TICKER_VERB = { edit: 'editing', read: 'reading', cmd: 'running', search: 'searching', web: 'fetching', other: 'using' };
function classifyToolName(name) {
  const n = (name || '').toLowerCase();
  if (/write|edit|apply_patch|create|notebook|patch|update_plan/.test(n)) return 'edit';
  if (/read|cat|view|open/.test(n)) return 'read';
  if (/bash|exec|shell|command|run|terminal/.test(n)) return 'cmd';
  if (/grep|glob|search|find|^ls|list/.test(n)) return 'search';
  if (/fetch|web|browser|http/.test(n)) return 'web';
  return 'other';
}

// A short human label for one tool action — the file it touched, the command it
// ran, or the query it searched — for the "what is the agent chewing on" ticker.
function toolLabel(m, cat, cwd) {
  const inp = m.input;
  if (inp && typeof inp === 'object') {
    const file = inp.file_path || inp.path || inp.notebook_path;
    if (file) return relPath(file, cwd);
    if (cat === 'cmd' && inp.command) {
      // Drop a leading `cd <path> && ` / `; ` — it's the harness boilerplate, not
      // what the agent is actually running.
      const cmd = String(inp.command).replace(/\s+/g, ' ').trim().replace(/^cd\s+\S+\s+(?:&&\s+|;\s+)?(?=\S)/, '');
      return cmd.slice(0, 80);
    }
    if (cat === 'search' && (inp.pattern || inp.query)) return String(inp.pattern || inp.query).slice(0, 60);
    if (inp.description) return String(inp.description).slice(0, 60);
  }
  if (typeof inp === 'string') {
    const match = inp.match(/\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)/);
    if (match) return relPath(match[1].trim(), cwd);
  }
  return m.name || cat;
}

// Live agent ticker: what the agent is doing right now. Prefers the real-time hook
// stream (working/idle + current action + context load, no flush lag) when present,
// and otherwise falls back to the tail of tool calls parsed from the most-recently-
// active session log. Read-only either way; no extra agent load. Items newest last.
export function getTicker(slug, limit = 16) {
  const project = getProject(slug);
  if (!project) return null;

  const stored = getStream(slug);
  if (stored && Array.isArray(stored.events) && stored.events.length) {
    const ev = stored.events;
    const last = ev[ev.length - 1];
    let ctxEv = null;
    for (let i = ev.length - 1; i >= 0; i--) if (typeof ev[i].ctx === 'number') { ctxEv = ev[i]; break; }
    let lastTool = null;
    for (let i = ev.length - 1; i >= 0; i--) if (ev[i].ev === 'tool') { lastTool = ev[i]; break; }
    const idle = last.ev === 'idle';
    const live = {
      state: idle ? 'idle' : 'working',
      action: idle || !lastTool ? null : { cat: lastTool.cat, verb: lastTool.verb, label: lastTool.target || '' },
      ctx: ctxEv ? ctxEv.ctx : null,
      ctxPct: ctxEv ? ctxEv.ctxPct : null,
      model: ctxEv ? ctxEv.model : null,
      ts: last.t || null,
    };
    const items = ev
      .filter((e) => e.ev === 'tool' && e.phase !== 'start') // completed actions; the in-flight one is `live.action`
      .slice(-limit)
      .map((e) => ({ cat: e.cat, verb: e.verb, label: e.target || '', ts: e.t || null }));
    return { source: 'hook', live, items, capturedAt: stored.capturedAt };
  }

  const recency = (x) => new Date((x && (x.endedAt || x.startedAt)) || 0).getTime();
  let latest = null;
  for (const summary of project.sessions) if (!latest || recency(summary) > recency(latest)) latest = summary;
  if (!latest) return { sessionId: null, items: [] };
  const s = getSession(slug, latest.id);
  if (!s) return { sessionId: latest.id, items: [] };
  const items = [];
  for (const m of s.messages) {
    if (m.kind !== 'tool_use') continue;
    const cat = classifyToolName(m.name);
    items.push({ cat, verb: TICKER_VERB[cat], label: toolLabel(m, cat, s.cwd), ts: m.ts || null });
  }
  return { sessionId: latest.id, source: latest.source, endedAt: latest.endedAt, items: items.slice(-limit) };
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
