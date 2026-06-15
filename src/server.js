import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, getSession, getActivity, getGit, getDocs, getMemory, getWorkspaceRollup, ingestBundle, setVisibility } from './storage.js';
import { getProjectMemory } from './workspace.js';
import { getContext } from './context.js';
import { BUNDLE_SCHEMA } from './bundle.js';
import { newToken, hashToken, bearer } from './auth.js';
import { mountAuth, currentUser } from './oauth.js';
import { linkOwner } from './accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Hosted mode (set in fly.toml) makes the server multi-tenant: `/` is a public
// landing page, the project list is scoped to its owner token, and pushes mint
// ownership. Local `vbrt serve` leaves this off and behaves single-user: `/` is
// your workspace home and the list shows every project on the machine.
const HOSTED = process.env.VBRT_HOSTED === '1';

// The owner hashes a request can act as: a signed-in account's linked tokens, or
// a single machine token via Bearer. null = unauthenticated (hosted), or local
// (unrestricted). [] = signed in but nothing linked yet.
function currentOwners(req) {
  if (!HOSTED) return null;
  const user = currentUser(req);
  if (user) return user.ownerHashes || [];
  const token = bearer(req);
  return token ? [hashToken(token)] : null;
}

// A project's reads (its page + APIs) are allowed when: we're local (single-user),
// the project is published public, or the requester owns it (session or token).
// Private projects are invisible to everyone but their owner — push ≠ publish.
function canRead(project, req) {
  if (!HOSTED) return true;
  if (!project) return false;
  if (project.visibility === 'public') return true;
  const owners = currentOwners(req);
  return !!owners && owners.includes(project.owner);
}

export function startServer(port = 4317) {
  const app = express();
  // Behind Fly's (or any) TLS-terminating proxy, honor X-Forwarded-Proto so
  // req.protocol is 'https' — otherwise minted share links come out as http://.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' })); // bundles carry full conversations

  if (HOSTED) mountAuth(app); // /auth/* sign-in, /api/me, /api/auth/providers

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
  app.post('/api/projects', (req, res) => {
    const bundle = req.body;
    if (!bundle || typeof bundle !== 'object' || !bundle.project || !Array.isArray(bundle.sessions)) {
      return res.status(400).json({ error: 'invalid bundle' });
    }
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
      const visibility = HOSTED ? (req.query.public === '1' ? 'public' : 'private') : 'public';
      const { id } = ingestBundle(bundle, { owner, visibility });
      const url = `${req.protocol}://${req.get('host')}/p/${id}`;
      res.status(201).json({ id, url, visibility, ...(minted ? { token: minted } : {}) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

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

  // Publish / unpublish a project (owner-only in hosted mode).
  app.post('/api/projects/:slug/visibility', (req, res) => {
    const project = getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'not found' });
    if (HOSTED) {
      const token = bearer(req);
      if (!token || hashToken(token) !== project.owner) return res.status(403).json({ error: 'forbidden' });
    }
    const updated = setVisibility(req.params.slug, req.body && req.body.visibility);
    res.json({ slug: req.params.slug, visibility: updated ? updated.visibility : 'private' });
  });

  app.get('/api/projects/:slug', (req, res) => {
    const project = guardRead(req, res);
    if (project) res.json(project);
  });

  app.get('/api/projects/:slug/activity', (req, res) => {
    if (!guardRead(req, res)) return;
    const activity = getActivity(req.params.slug);
    if (!activity) return res.status(404).json({ error: 'not found' });
    res.json(activity);
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

  app.get('/api/projects/:slug/sessions/:id', (req, res) => {
    if (!guardRead(req, res)) return;
    const session = getSession(req.params.slug, req.params.id);
    if (!session) return res.status(404).json({ error: 'not found' });
    res.json(session);
  });

  const sendApp = (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'));

  // Public single-project page: /p/<id> serves the SPA, which reads the id from
  // the URL and loads that project directly (no picker). Always public — the
  // unguessable id is the share secret.
  app.get('/p/:id', sendApp);

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
    const server = app.listen(port, '0.0.0.0', () => resolve({ server, port }));
  });
}
