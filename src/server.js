import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, getSession, getActivity, getTicker, getGit, getDocs, getDocHistory, getMemory, getEvidence, getClassify, saveClassify, getWorkspaceRollup, ingestBundle, setVisibility } from './storage.js';
import { classifyUnits, hasKey } from './classify.js';
import { getProjectMemory } from './workspace.js';
import { getContext } from './context.js';
import { extractPromptUnits, buildFeed, parseCardId } from './prompts.js';
import { getRatingSummary, getUserVote, voteCard } from './ratings.js';
import { BUNDLE_SCHEMA } from './bundle.js';
import { newToken, hashToken, bearer, signValue, verifyValue, readCookie, setCookie } from './auth.js';
import { mountAuth, currentUser } from './oauth.js';
import { linkOwner, findUserByOwnerHash } from './accounts.js';
import { mountAgent } from './agentRoutes.js';
import { ensureSubscriptionCredentials, ensureGitAuth, setBaseUrl, setIngestHook, setTranscriptLoader } from './agent.js';
import { ingestDriveTurn, loadDriveTranscript } from './driveIngest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Hosted mode (set in fly.toml) makes the server multi-tenant: `/` is a public
// landing page, the project list is scoped to its owner token, and pushes mint
// ownership. Local `vbrt serve` leaves this off and behaves single-user: `/` is
// your workspace home and the list shows every project on the machine.
const HOSTED = process.env.VBRT_HOSTED === '1';
const JSON_LIMIT = process.env.VBRT_JSON_LIMIT || (HOSTED ? '25mb' : '50mb');
const MAX_SESSIONS = Number(process.env.VBRT_MAX_SESSIONS || 300);
const MAX_MESSAGES = Number(process.env.VBRT_MAX_MESSAGES || 20000);
const MAX_EVIDENCE = Number(process.env.VBRT_MAX_EVIDENCE || 100);
const MAX_IMAGE_BYTES = Number(process.env.VBRT_MAX_IMAGE_BYTES || 1536 * 1024);
const MAX_CLIP_BYTES = Number(process.env.VBRT_MAX_CLIP_BYTES || 6 * 1024 * 1024);
const RATE_WINDOW_MS = Number(process.env.VBRT_RATE_WINDOW_MS || 10 * 60 * 1000);
const RATE_MAX = Number(process.env.VBRT_RATE_MAX || 20);
// Authenticated pushers (Bearer token / signed-in account) get more headroom — an
// active `vbrt watch` plus a final push easily exceeds the anonymous limit, and we
// can key them by token instead of a shared NAT/WSL IP.
const RATE_MAX_AUTH = Number(process.env.VBRT_RATE_MAX_AUTH || 120);
const ingestHits = new Map();

// The owner hashes a request can act as: a signed-in account's linked tokens, or
// a single machine token via Bearer. null = unauthenticated (hosted), or local
// (unrestricted). [] = signed in but nothing linked yet.
function currentOwners(req) {
  if (!HOSTED) return null;
  const user = currentUser(req);
  if (user) return user.ownerHashes || [];
  const token = bearer(req);
  if (!token) return null;
  // A bare machine token normally scopes to just its own pushes. But if the token
  // has been linked to an account (e.g. minted via /api/tokens, or used to sign in
  // on a device where the OAuth redirect can't complete — see PLAN_NATIVE_AUTH.md),
  // resolve it to the account's full project scope so token sign-in matches the web.
  const h = hashToken(token);
  const acct = findUserByOwnerHash(h);
  return acct ? acct.ownerHashes || [] : [h];
}

// Short-lived, project-scoped view grants. A push returns a signed `view` token so
// the developer who pushed can open their own *private* project in a browser without
// signing in / claiming first (the browser can't present the CLI bearer token). The
// token is redeemed (POST /api/view) into a signed `vbrt_view` cookie that lists the
// granted slugs. This grants *read* of named private projects only — never the
// account, the project list, or publish — so it's safe to hand back in a link.
const VIEW_COOKIE = 'vbrt_view';
const VIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LIVE_WINDOW_MS = 3 * 60 * 1000; // a project pushed within this window reads as "streaming"

function viewGrants(req) {
  const payload = verifyValue(readCookie(req, VIEW_COOKIE));
  return (payload && Array.isArray(payload.views)) ? payload.views : [];
}

// A project's reads (its page + APIs) are allowed when: we're local (single-user),
// the project is published public, the requester owns it (session or token), or the
// requester holds a valid view grant for this specific project.
// Private projects are otherwise invisible to everyone but their owner — push ≠ publish.
function canRead(project, req) {
  if (!HOSTED) return true;
  if (!project) return false;
  if (project.visibility === 'public') return true;
  const owners = currentOwners(req);
  if (owners && owners.includes(project.owner)) return true;
  return viewGrants(req).includes(project.slug);
}

function rateLimitIngest(req, res, next) {
  if (!HOSTED) return next();
  const owners = currentOwners(req); // null = anon, [hash] = token, [..] = account
  const authed = Array.isArray(owners) && owners.length > 0;
  // Key authed pushers by their token (stable across a shared IP); anon by IP.
  const key = authed ? `tok:${owners[0]}` : `ip:${req.ip || req.get('x-forwarded-for') || 'unknown'}`;
  const max = authed ? RATE_MAX_AUTH : RATE_MAX;
  const now = Date.now();
  const hits = (ingestHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= max) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000));
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'too many uploads; try again later', retryAfter });
  }
  hits.push(now);
  ingestHits.set(key, hits);
  next();
}

function imageBytes(dataUrl) {
  const s = String(dataUrl || '');
  const b64 = s.includes(',') ? s.split(',').pop() : s;
  return Math.floor((b64.length * 3) / 4);
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return 'invalid bundle';
  if (!bundle.project || typeof bundle.project !== 'object') return 'missing project';
  if (typeof bundle.project.cwd !== 'string' || !bundle.project.cwd) return 'missing project cwd';
  if (!Array.isArray(bundle.sessions)) return 'missing sessions';
  if (bundle.sessions.length > MAX_SESSIONS) return `too many sessions; max ${MAX_SESSIONS}`;
  let messages = 0;
  for (const s of bundle.sessions) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.messages)) return 'invalid session payload';
    messages += s.messages.length;
    if (messages > MAX_MESSAGES) return `too many messages; max ${MAX_MESSAGES}`;
  }
  const evidence = Array.isArray(bundle.evidence) ? bundle.evidence : [];
  if (evidence.length > MAX_EVIDENCE) return `too much evidence; max ${MAX_EVIDENCE}`;
  for (const e of evidence) {
    if (!e || !e.image) continue;
    const isClip = e.media === 'video' || /^data:(video\/|image\/gif)/i.test(e.image);
    const cap = isClip ? MAX_CLIP_BYTES : MAX_IMAGE_BYTES;
    if (imageBytes(e.image) > cap) return `evidence ${isClip ? 'clip' : 'image'} too large; max ${cap} bytes`;
  }
  return null;
}

export function startServer(port = 4317) {
  // If a subscription credential secret is provided (hosted Drive on the Max
  // plan), seed it into the config dir before any agent turn spawns. No-ops
  // locally where the env var is unset and ~/.claude already holds the login.
  ensureSubscriptionCredentials();
  // Configure git so the Drive agent can push the branches it produces using the
  // GITHUB_TOKEN secret. No-op locally / without the token.
  ensureGitAuth();
  const app = express();
  // Behind Fly's (or any) TLS-terminating proxy, honor X-Forwarded-Proto so
  // req.protocol is 'https' — otherwise minted share links come out as http://.
  app.set('trust proxy', true);
  app.use(express.json({ limit: JSON_LIMIT })); // bundles carry full conversations

  if (HOSTED) mountAuth(app); // /auth/* sign-in, /api/me, /api/auth/providers

  // Agent runtime — the "drive" half (PLAN_AGENT_RUNTIME.md). Mounts the
  // chat/control plane (/api/agent/*); the Drive UI itself is folded into the
  // dashboard SPA. This is an RCE surface, so the guard inside mountAgent is
  // mode-dependent: loopback-only locally, and a signed-in admin-email allowlist
  // when hosted (where the routes are internet-reachable). Deny-by-default:
  // hosted with an empty VBRT_ADMIN_EMAILS locks Drive entirely.
  mountAgent(app, {
    hosted: HOSTED,
    adminEmails: (process.env.VBRT_ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultCwd: process.env.VBRT_AGENT_CWD || process.cwd(),
  });

  // Liveness probe for the host's health checks. Cheap, no I/O.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, hosted: HOSTED, schema: BUNDLE_SCHEMA });
  });

  // Project list. Hosted: scoped to the caller's owners (session account or token);
  // no anonymous enumeration. Local: returns everything.
  app.get('/api/projects', (req, res) => {
    if (!HOSTED) return res.json(listProjects());
    const owners = currentOwners(req);
    if (!owners) return res.status(401).json({ error: 'auth required' });
    res.json(listProjects(owners));
  });

  // Claim flow: bind a machine token's projects to the signed-in account.
  app.post('/api/link', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'sign in first' });
    const token = req.body && req.body.token;
    if (!token) return res.status(400).json({ error: 'missing token' });
    const updated = linkOwner(user.id, hashToken(String(token)));
    res.json({ ok: true, projectCount: updated ? updated.ownerHashes.length : 0 });
  });

  // Redeem a self-view token (from a push's `view` field) into a cookie so the
  // pusher can browse their own private project without signing in. Merges into any
  // existing grants so opening several private links in one browser all keep working.
  app.post('/api/view', (req, res) => {
    if (!HOSTED) return res.json({ ok: true }); // local: everything is readable anyway
    const token = req.body && req.body.token;
    const payload = token ? verifyValue(String(token)) : null;
    if (!payload || !payload.grant) return res.status(400).json({ error: 'invalid or expired view token' });
    const views = Array.from(new Set([...viewGrants(req), payload.grant]));
    setCookie(res, VIEW_COOKIE, signValue({ views }, VIEW_TTL_MS), { maxAgeMs: VIEW_TTL_MS });
    res.json({ ok: true, id: payload.grant });
  });

  // "Connect CLI": mint a fresh token already bound to the signed-in account, so
  // a web-first user can `vbrt login <token>` and push straight into their account.
  app.post('/api/tokens', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'sign in first' });
    const token = newToken();
    linkOwner(user.id, hashToken(token));
    res.json({ token });
  });

  // Cold-start context: the global instruction files on the *local* machine.
  // Meaningless on a shared host, so hosted mode returns an empty shape.
  app.get('/api/context', (_req, res) => {
    res.json(HOSTED ? { global: { claude: [], codex: [], atoms: [] } } : getContext());
  });

  // Overarching workspace rollup: memory + stats aggregated across the owner's
  // projects (built from pushed data only). Hosted is token-scoped; local spans all.
  app.get('/api/workspace', (req, res) => {
    if (!HOSTED) return res.json(getWorkspaceRollup());
    const owners = currentOwners(req);
    if (!owners) return res.status(401).json({ error: 'auth required' });
    res.json(getWorkspaceRollup(owners));
  });

  // Ingest: accept a pushed bundle, store it under a fresh unlisted id, and
  // return the shareable URL. Gist-style ownership: a bundle pushed with a bearer
  // token is owned by it; without one (hosted), we mint a token and return it so
  // the client can save it and see all its projects later.
  app.post('/api/projects', rateLimitIngest, (req, res) => {
    const bundle = req.body;
    if (!bundle || typeof bundle !== 'object' || !bundle.project || !Array.isArray(bundle.sessions)) {
      return res.status(400).json({ error: 'invalid bundle' });
    }
    const invalid = HOSTED ? validateBundle(bundle) : null;
    if (invalid) return res.status(413).json({ error: invalid });
    if (bundle.schema !== BUNDLE_SCHEMA) {
      return res.status(409).json({ error: `unsupported schema ${bundle.schema}; expected ${BUNDLE_SCHEMA}` });
    }
    try {
      let owner = null;
      let minted = null;
      if (HOSTED) {
        const provided = bearer(req);
        const token = provided || (minted = newToken());
        owner = hashToken(token);
      }
      // Private by default; `vbrt push --public` (?public=1) publishes on push.
      const requestedVisibility = HOSTED ? (req.query.public === '1' ? 'public' : 'private') : 'public';
      const { id, visibility } = ingestBundle(bundle, { owner, visibility: requestedVisibility });
      const url = `${req.protocol}://${req.get('host')}/p/${id}`;
      // A self-view token so the pusher can open a private project immediately,
      // without signing in first (redeemed by the viewer via POST /api/view).
      const view = HOSTED && visibility !== 'public' ? signValue({ grant: id }, VIEW_TTL_MS) : null;
      res.status(201).json({ id, url, visibility, ...(view ? { view } : {}), ...(minted ? { token: minted } : {}) });
      // Fire-and-forget intent classification of any newly-ingested prompts. Keyed
      // by cardId and merged over what's already classified, so it's incremental
      // (only new prompts hit the model) and never blocks the push response.
      classifyProject(id);
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Classify the project's substantive prompt-units that aren't yet tagged, and
  // persist the merged map. Best-effort: no key → no-op; any error is swallowed so
  // it can never affect ingest.
  async function classifyProject(slug) {
    if (!hasKey()) return;
    try {
      const project = getProject(slug);
      if (!project) return;
      const git = getGit(slug);
      const evidence = getEvidence(slug);
      const units = [];
      for (const summary of project.sessions || []) {
        const session = getSession(slug, summary.id);
        if (session) units.push(...extractPromptUnits(session, summary.id, slug, { evidence, git }));
      }
      const existing = getClassify(slug);
      const map = await classifyUnits(units, existing);
      console.error(`[classify] ${slug}: ${units.length} units, ${Object.keys(map).length - Object.keys(existing).length} newly tagged`);
      saveClassify(slug, map);
    } catch (e) {
      console.error('[classify] project failed:', e && (e.message || e));
    }
  }

  // Drive ingest: when a driven turn finishes, fold its transcript into the bound
  // project so it shows in the Convos rail, then (re)classify so the cooled card
  // gets its archetype + outcome rail like any captured convo. This is the
  // watcher-free replacement for "run vbrt watch on the host" — the runtime owns
  // the process, so it ingests by session id directly (archive/drive-reconciliation/DRIVE_CONVO_INGEST_GAP.md).
  setIngestHook(async ({ projectSlug, claudeSessionId }) => {
    try {
      const result = await ingestDriveTurn({ projectSlug, claudeSessionId });
      if (result) classifyProject(projectSlug);
    } catch (e) {
      console.error('[drive-ingest] failed:', e && (e.message || e));
    }
  });

  // Lets the Drive runtime revive a session after a redeploy wiped its in-memory
  // record: it asks for the saved transcript by claude session id, we locate +
  // parse the on-disk JSONL (driveIngest), and it replays that to reconnect.
  setTranscriptLoader((claudeSessionId) => loadDriveTranscript(claudeSessionId));

  // Read guard: resolves the project and enforces visibility. Returns null (and
  // sends 404 — we don't reveal that a private project exists) when not allowed.
  const guardRead = (req, res) => {
    const project = getProject(req.params.slug);
    if (!project || !canRead(project, req)) {
      res.status(404).json({ error: 'not found' });
      return null;
    }
    return project;
  };

  // Publish / unpublish a project (owner-only in hosted mode). Authorizes via the
  // caller's owners — a signed-in account (session) OR a machine token — so
  // publishing works from the web dashboard, not just the CLI token.
  app.post('/api/projects/:slug/visibility', (req, res) => {
    const project = getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'not found' });
    if (HOSTED) {
      const owners = currentOwners(req);
      if (!owners || !owners.includes(project.owner)) return res.status(403).json({ error: 'forbidden' });
    }
    const updated = setVisibility(req.params.slug, req.body && req.body.visibility);
    res.json({ slug: req.params.slug, visibility: updated ? updated.visibility : 'private' });
  });

  app.get('/api/projects/:slug', (req, res) => {
    const project = guardRead(req, res);
    // `streaming`: pushed within the live window (e.g. a `vbrt watch` is sending
    // deltas) → the viewer auto-enables Live so you don't hand-click "Go live".
    // Self-clears once pushes stop. Single source of the window threshold.
    if (project) res.json({ ...project, streaming: (Date.now() - (project.lastPushAt || 0)) < LIVE_WINDOW_MS });
  });

  app.get('/api/projects/:slug/activity', (req, res) => {
    if (!guardRead(req, res)) return;
    const activity = getActivity(req.params.slug);
    if (!activity) return res.status(404).json({ error: 'not found' });
    res.json(activity);
  });

  // Live agent ticker: the tail of tool actions from the most-active session, so the
  // dashboard can show what the agent is chewing on right now (polled in Live mode).
  app.get('/api/projects/:slug/ticker', (req, res) => {
    if (!guardRead(req, res)) return;
    const ticker = getTicker(req.params.slug);
    if (!ticker) return res.status(404).json({ error: 'not found' });
    res.json(ticker);
  });

  app.get('/api/projects/:slug/git', (req, res) => {
    if (!guardRead(req, res)) return;
    const git = getGit(req.params.slug);
    if (!git) return res.status(404).json({ error: 'not found' });
    res.json(git);
  });

  // Prefer a live read of the local ~/.claude store (always fresh, used by the
  // local viewer). When none exists — e.g. the hosted server, which only has the
  // uploaded bundle — fall back to the memory snapshot saved from that bundle.
  app.get('/api/projects/:slug/memory', (req, res) => {
    if (!guardRead(req, res)) return;
    const live = getProjectMemory(req.params.slug);
    if (live && live.ok) return res.json(live);
    res.json(getMemory(req.params.slug) || live);
  });

  app.get('/api/projects/:slug/docs', (req, res) => {
    if (!guardRead(req, res)) return;
    const docs = getDocs(req.params.slug);
    if (!docs) return res.status(404).json({ error: 'not found' });
    res.json(docs);
  });

  // Per-brain-doc version history (brain time-travel). Optional — 404 when the
  // capture predates it or the repo had no brain-doc changes.
  app.get('/api/projects/:slug/dochistory', (req, res) => {
    if (!guardRead(req, res)) return;
    const hist = getDocHistory(req.params.slug);
    if (!hist) return res.status(404).json({ error: 'not found' });
    res.json(hist);
  });

  app.get('/api/projects/:slug/sessions/:id', (req, res) => {
    if (!guardRead(req, res)) return;
    const session = getSession(req.params.slug, req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });
    res.json(session);
  });

  // Prompt units of a session: the prompt-card chain (before/prompt/after).
  app.get('/api/projects/:slug/sessions/:id/prompts', (req, res) => {
    if (!guardRead(req, res)) return;
    const session = getSession(req.params.slug, req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });
    res.json(extractPromptUnits(session, req.params.id, req.params.slug, { evidence: getEvidence(req.params.slug), git: getGit(req.params.slug), classify: getClassify(req.params.slug) }));
  });

  // Project-level prompt-unit rail: all prompts across sessions, newest first.
  app.get('/api/projects/:slug/prompts', (req, res) => {
    const project = guardRead(req, res);
    if (!project) return;
    const evidence = getEvidence(req.params.slug);
    const git = getGit(req.params.slug);
    const classify = getClassify(req.params.slug);
    const units = [];
    for (const summary of project.sessions || []) {
      const session = getSession(req.params.slug, summary.id);
      if (!session) continue;
      for (const unit of extractPromptUnits(session, summary.id, req.params.slug, { evidence, git, classify })) {
        if (unit.isNoise) continue;
        units.push({
          ...unit,
          source: summary.source,
          sessionId: summary.id,
          sessionTitle: summary.title,
          sessionStartedAt: summary.startedAt,
          sessionEndedAt: summary.endedAt,
        });
      }
    }
    units.sort((a, b) => Date.parse(b.ts || b.sessionEndedAt || 0) - Date.parse(a.ts || a.sessionEndedAt || 0));
    res.json(units);
  });

  // Discover feed: substantive prompt cards across published projects. Public —
  // it's the "see how others prompt" surface. Local serve shows everything.
  app.get('/api/feed', (req, res) => {
    const user = HOSTED ? currentUser(req) : null;
    res.json(buildFeed(60, { publicOnly: HOSTED, userId: user ? user.id : null }));
  });

  // A single prompt card (permalink target): the unit + its rating + your vote.
  // Readable only if the card's project is readable (public or yours).
  app.get('/api/cards/:id', (req, res) => {
    const { slug, sessionId, index } = parseCardId(req.params.id);
    const project = getProject(slug);
    if (!project || !canRead(project, req)) return res.status(404).json({ error: 'not found' });
    const session = getSession(slug, sessionId);
    if (!session) return res.status(404).json({ error: 'not found' });
    const unit = extractPromptUnits(session, sessionId, slug, { evidence: getEvidence(slug), git: getGit(slug), classify: getClassify(slug) }).find((u) => u.index === index);
    if (!unit) return res.status(404).json({ error: 'not found' });
    const summary = (project.sessions || []).find((s) => s.id === sessionId) || {};
    const user = currentUser(req);
    res.json({
      ...unit,
      project: { slug: project.slug, name: project.name || project.slug },
      source: summary.source,
      sessionId,
      sessionTitle: summary.title,
      rating: getRatingSummary(req.params.id),
      myVote: user ? getUserVote(req.params.id, user.id) : 0,
    });
  });

  // Vote on a card (+1 / -1 / 0 to clear). Sign-in required; you must be able to
  // see the card's project to vote on it.
  app.post('/api/cards/:id/vote', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'sign in to rate' });
    const { slug } = parseCardId(req.params.id);
    const project = getProject(slug);
    if (!project || !canRead(project, req)) return res.status(404).json({ error: 'not found' });
    const summary = voteCard(req.params.id, user.id, Number((req.body && req.body.value) || 0));
    res.json({ ...summary, myVote: getUserVote(req.params.id, user.id) });
  });

  const sendApp = (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'));

  // Public single-project page: /p/<id> serves the SPA, which reads the id from
  // the URL and loads that project directly (no picker). Always public — the
  // unguessable id is the share secret.
  app.get('/p/:id', sendApp);

  // Public discover feed of prompt cards.
  app.get('/explore', sendApp);

  // Public permalink for a single prompt card.
  app.get('/c/:id', sendApp);

  // Front door. Hosted: `/` is the public landing page; the SPA dashboard lives
  // at /app (token-scoped to your projects). Local: `/` is the SPA workspace home.
  if (HOSTED) {
    app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
    app.get(['/app', '/app/*', '/link'], sendApp);
  } else {
    app.get('/', sendApp);
  }

  // index:false so static doesn't auto-serve index.html at `/` (we route it above).
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // Bind all interfaces so the app is reachable inside a container / behind a
  // platform proxy (not just loopback).
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      // Tell the agent runtime where the MCP `ask` sidecar should POST answers
      // (loopback — the sidecar always runs on this host alongside the server).
      setBaseUrl(`http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}
