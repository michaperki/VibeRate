import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECTS_DIR, slugify } from './paths.js';

// A hook fires per tool action, so a "working" agent emits events frequently; the only
// silent gap is pure model thinking between tool calls, rarely past ~2 min. So once the
// live stream goes this long with no new event we stop reporting "working" — the session
// is idle, finished, or gone (a hard exit leaves no marker). See LIVE_ORCHESTRATION §8a.
const WORKING_TTL_MS = 2 * 60 * 1000;

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
  // Carry the repo's origin URL onto the manifest so hosted Drive can prefill a
  // one-click clone of this project onto the volume (set once; UI can override).
  const result = saveSessions(cwd, sessions, { ...opts, repoUrl: (git && git.origin) || null });
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

// Mint an EMPTY project from the dashboard "New project" button — no `vbrt push`,
// no capture bundle. This is Fork 2's existing-app onboarding path (ONBOARDING.md):
// the project is born from a repo URL alone, its Convos/brain rails start empty and
// fill as Drive runs (ingestDriveSession). Mirrors ingestBundle's id scheme (an
// unguessable base64url slug = the share secret) and ownership, but writes a bare
// manifest instead of a bundle. `repoUrl` is the clone prefill the workspace setup
// reads (getWorkspace → suggestedRepo). `cwd` is null: there is no local checkout —
// the only checkout is the Drive workspace, bound later via setWorkspace. Returns
// { id }.
export function createProject({ name = null, repoUrl = null, owner = null, visibility = null } = {}) {
  const id = crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars, unlisted — same as ingestBundle
  const dir = projectDir(id);
  ensureDir(dir);
  const now = new Date().toISOString();
  const manifest = {
    slug: id,
    cwd: null,
    name: name || id,
    createdAt: now,
    updatedAt: now,
    origin: 'created', // born from the dashboard, not a push — distinguishes it in tooling
    sessions: [],
  };
  if (repoUrl) manifest.repoUrl = repoUrl;
  if (owner) manifest.owner = owner;
  manifest.visibility = visibility === 'public' ? 'public' : 'private';
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(manifest, null, 2));
  return { id };
}

// Fold a single Drive-produced session into an EXISTING project (keyed by slug),
// without touching the project's repo identity (cwd/owner/visibility/repoUrl). A
// driven session runs in a checkout on the host whose path differs from the
// project's captured cwd, so we must NOT let saveSessions' unconditional
// `manifest.cwd = cwd` repoint the project (that would fork it from the user's
// real repo on the next local push). This is the direct, watcher-free ingest path
// for the Drive runtime: parse the JSONL the CLI just wrote, drop it in here.
// Returns { slug, added, total } or null if the project doesn't exist.
export function ingestDriveSession(slug, session) {
  const dir = projectDir(slug);
  const manifestPath = path.join(dir, 'project.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest) return null;

  const sessionsDir = path.join(dir, 'sessions');
  ensureDir(sessionsDir);
  const fileId = `${session.source}-${session.id}`;
  fs.writeFileSync(path.join(sessionsDir, `${fileId}.json`), JSON.stringify(session, null, 2));

  const summary = {
    id: fileId,
    source: session.source,
    title: session.title,
    lastUserText: session.lastUserText || null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    messageCount: session.messageCount,
  };
  manifest.sessions = manifest.sessions || [];
  const i = manifest.sessions.findIndex((s) => s.id === fileId);
  const added = i < 0;
  if (added) manifest.sessions.push(summary);
  else manifest.sessions[i] = summary; // re-ingest of a follow-up turn: refresh in place
  manifest.sessions.sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || '')),
  );
  manifest.updatedAt = new Date().toISOString();
  manifest.lastPushAt = Date.now(); // a driven turn is fresh activity → flips the viewer to Live
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { slug, added, total: manifest.sessions.length };
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
  if (opts.repoUrl && !manifest.repoUrl) manifest.repoUrl = opts.repoUrl; // clone prefill; set once
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

// --- Drive workspace binding (PLAN_DRIVE_WORKSPACES.md) -------------------------
// A project's checkout on the Drive host lives in its manifest as
// `workspace: { repo, branch, dir, status, head, error, updatedAt }`. The repo URL
// to clone is prefilled from `manifest.repoUrl` (captured from the push's origin).

export function getWorkspace(slug) {
  const m = getProject(slug);
  if (!m) return null;
  return { workspace: m.workspace || null, suggestedRepo: m.repoUrl || null, name: m.name || slug };
}

// Merge a patch into the project's workspace binding and persist. Returns the
// updated workspace, or null if the project doesn't exist.
export function setWorkspace(slug, patch) {
  const manifestPath = path.join(projectDir(slug), 'project.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest) return null;
  manifest.workspace = { ...(manifest.workspace || {}), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest.workspace;
}

export function getSession(slug, sessionId) {
  return readJson(path.join(projectDir(slug), 'sessions', `${sessionId}.json`), null);
}

// Reconcile a fresh git capture against what we've already stored. Every push (and
// every Drive turn-end ingest) re-runs `git log` from scratch, so a rewritten
// history — git reset, rebase, squash, force-push, or two machines pushing one
// slug — used to silently DROP commits that no longer sit on HEAD, losing work from
// the very timeline we dogfood. Instead we UNION by hash: commits in the fresh
// capture are authoritative (live, current HEAD); commits we'd captured before that
// vanished from the log are kept and flagged `rewritten` so the timeline preserves
// them (dimmed) rather than losing them. A rewritten commit that later reappears
// (e.g. a reset forward, or the other machine re-pushing) is promoted back to live.
// Bounded so preserved ghosts can't grow without limit across many rewrites.
// Known limitation: two machines on one slug with divergent history will ping-pong
// which set is "live" each push — but no commit is ever lost, which is the point.
const GIT_COMMIT_CAP = 6000; // a little over extractGit's 4000, to leave room for ghosts
export function reconcileGit(prev, next) {
  if (!next || !Array.isArray(next.commits)) return next;
  if (!prev || !Array.isArray(prev.commits) || !prev.commits.length) return next;
  const live = new Set(next.commits.map((c) => c.hash));
  const byHash = new Map();
  // Carry forward prior commits the fresh log no longer reaches, marked rewritten.
  for (const c of prev.commits) {
    if (live.has(c.hash)) continue; // the fresh capture holds the authoritative copy
    byHash.set(c.hash, c.rewritten ? c : { ...c, rewritten: true });
  }
  // Fresh capture wins for everything on current HEAD (clears any stale `rewritten`).
  for (const c of next.commits) byHash.set(c.hash, c);
  const commits = [...byHash.values()].sort((a, b) => b.t - a.t).slice(0, GIT_COMMIT_CAP);
  const rewrittenCount = commits.reduce((n, c) => n + (c.rewritten ? 1 : 0), 0);
  return { ...next, commits, ...(rewrittenCount ? { rewrittenCount } : {}) };
}

// Git history captured at add-time (commits for the timeline overlay). Merges with
// any prior capture (see reconcileGit) so rewritten history doesn't lose commits.
export function saveGit(cwd, git, slug = slugify(cwd)) {
  if (!git) return;
  const dir = projectDir(slug);
  ensureDir(dir);
  const prev = readJson(path.join(dir, 'git.json'), null);
  fs.writeFileSync(path.join(dir, 'git.json'), JSON.stringify(reconcileGit(prev, git)));
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
// already-pushed data — no machine-local reads. Returns headline activity stats.
// With `owner` null (local), spans every project.
//
// We intentionally do NOT aggregate agent memory here. Saved memory is project-
// scoped (repo B's notes aren't relevant in repo A's workspace), and the truly
// global "about you" facts live in a store we don't capture yet — so a cross-
// project memory blob was more confusing than faithful. Memory lives on each
// project's page instead. See ARCHITECTURE.md → "Memory model" (2026-06-19).
// `memory: []` is kept in the response for client back-compat.
export function getWorkspaceRollup(owner = null) {
  const projects = listProjects(owner);
  let sessions = 0;
  let messages = 0;
  let commits = 0;
  let added = 0;
  let removed = 0;

  for (const p of projects) {
    sessions += (p.sessions || []).length;
    for (const a of getActivity(p.slug) || []) {
      messages += a.userCount || 0;
      added += a.added || 0;
      removed += a.removed || 0;
    }
    const g = getGit(p.slug);
    if (g && Array.isArray(g.commits)) commits += g.commits.length;
  }

  return { stats: { projects: projects.length, sessions, messages, commits, added, removed }, memory: [] };
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
    if (cat === 'cmd' && (inp.command || inp.cmd)) {
      // Drop a leading `cd <path> && ` / `; ` — it's the harness boilerplate, not
      // what the agent is actually running.
      const cmd = String(inp.command || inp.cmd).replace(/\s+/g, ' ').trim().replace(/^cd\s+\S+\s+(?:&&\s+|;\s+)?(?=\S)/, '');
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

function hookTickerAgent(events, sessionId, limit) {
  const last = events[events.length - 1];
  let ctxEv = null;
  for (let i = events.length - 1; i >= 0; i--) if (typeof events[i].ctx === 'number') { ctxEv = events[i]; break; }
  let lastTool = null;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].ev === 'tool') { lastTool = events[i]; break; }
  const age = Date.now() - (last.t || 0);
  const state = last.ev === 'end' ? 'ended' : last.ev === 'idle' ? 'idle' : age > WORKING_TTL_MS ? 'idle' : 'working';
  const live = {
    state,
    stale: state === 'idle' && last.ev !== 'idle' && last.ev !== 'end',
    action: state !== 'working' || !lastTool ? null : { cat: lastTool.cat, verb: lastTool.verb, label: lastTool.target || '' },
    ctx: ctxEv ? ctxEv.ctx : null,
    ctxPct: ctxEv ? ctxEv.ctxPct : null,
    model: ctxEv ? ctxEv.model : null,
    ts: last.t || null,
  };
  const items = events
    .filter((e) => e.ev === 'tool' && e.phase !== 'start')
    .slice(-limit)
    .map((e) => ({ cat: e.cat, verb: e.verb, label: e.target || '', ts: e.t || null }));
  return { sessionId, source: 'claude', transport: 'hook', live, items };
}

function sessionTickerAgent(session, summary, limit) {
  const items = [];
  for (const m of session.messages || []) {
    if (m.kind !== 'tool_use') continue;
    const cat = classifyToolName(m.name);
    items.push({ cat, verb: TICKER_VERB[cat], label: toolLabel(m, cat, session.cwd), ts: m.ts || null });
  }
  const raw = session.live || null;
  const ts = Date.parse((raw && raw.ts) || session.endedAt || summary.endedAt || '') || null;
  const stale = ts != null && Date.now() - ts > WORKING_TTL_MS;
  const state = raw && raw.state === 'idle' ? 'idle' : stale ? 'idle' : 'working';
  const live = {
    state,
    stale: stale && (!raw || raw.state !== 'idle'),
    action: state === 'working' ? (raw && raw.action) || (items.length ? { cat: items.at(-1).cat, verb: items.at(-1).verb, label: items.at(-1).label } : null) : null,
    ctx: raw && raw.ctx,
    ctxPct: raw && raw.ctxPct,
    model: raw && raw.model,
    ts,
  };
  return { sessionId: summary.id, source: summary.source, transport: 'session', live, items: items.slice(-limit) };
}

// Live agent ticker: merge real-time Claude hook streams with Codex's per-event
// rollout snapshots. A hook stream no longer suppresses concurrent Codex sessions.
// `agents` is the canonical response; top-level fields mirror the newest agent for
// backward compatibility with older viewers.
export function getTicker(slug, limit = 16) {
  const project = getProject(slug);
  if (!project) return null;
  const agents = [];
  const stored = getStream(slug);
  if (stored && Array.isArray(stored.events) && stored.events.length) {
    const grouped = new Map();
    for (const e of stored.events) {
      const id = e.sid || '_';
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(e);
    }
    for (const [sid, events] of grouped) agents.push(hookTickerAgent(events, sid === '_' ? null : `claude-${sid}`, limit));
  }

  const recency = (x) => new Date((x && (x.endedAt || x.startedAt)) || 0).getTime();
  const recentCutoff = Date.now() - 10 * 60 * 1000;
  for (const summary of project.sessions || []) {
    if (summary.source !== 'codex' || recency(summary) < recentCutoff) continue;
    const session = getSession(slug, summary.id);
    if (session) agents.push(sessionTickerAgent(session, summary, limit));
  }

  // Old captures may have neither hooks nor Codex `live` snapshots. Preserve the
  // previous single-session fallback so their ticker does not disappear.
  if (!agents.length) {
    let latest = null;
    for (const summary of project.sessions || []) if (!latest || recency(summary) > recency(latest)) latest = summary;
    if (latest) {
      const session = getSession(slug, latest.id);
      if (session) agents.push(sessionTickerAgent(session, latest, limit));
    }
  }
  agents.sort((a, b) => (b.live?.ts || 0) - (a.live?.ts || 0));
  const primary = agents[0] || { sessionId: null, source: null, live: null, items: [] };
  return { ...primary, agents, capturedAt: stored && stored.capturedAt };
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
