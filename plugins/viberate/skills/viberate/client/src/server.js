import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, getSession, getActivity, getGit, getDocs, getMemory, getWorkspaceRollup, ingestBundle } from './storage.js';
import { getProjectMemory } from './workspace.js';
import { getContext } from './context.js';
import { BUNDLE_SCHEMA } from './bundle.js';
import { newToken, hashToken, bearer } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Hosted mode (set in fly.toml) makes the server multi-tenant: `/` is a public
// landing page, the project list is scoped to its owner token, and pushes mint
// ownership. Local `vbrt serve` leaves this off and behaves single-user: `/` is
// your workspace home and the list shows every project on the machine.
const HOSTED = process.env.VBRT_HOSTED === '1';

export function startServer(port = 4317) {
  const app = express();
  // Behind Fly's (or any) TLS-terminating proxy, honor X-Forwarded-Proto so
  // req.protocol is 'https' — otherwise minted share links come out as http://.
  app.set('trust proxy', true);
  app.use(express.json({ limit: '50mb' })); // bundles carry full conversations

  // Liveness probe for the host's health checks. Cheap, no I/O.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, hosted: HOSTED, schema: BUNDLE_SCHEMA });
  });

  // Project list. Hosted: requires an owner token and returns only that owner's
  // projects (no anonymous enumeration). Local: returns everything.
  app.get('/api/projects', (req, res) => {
    if (!HOSTED) return res.json(listProjects());
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'auth required' });
    res.json(listProjects(hashToken(token)));
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
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'auth required' });
    res.json(getWorkspaceRollup(hashToken(token)));
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
      const { id } = ingestBundle(bundle, owner);
      const url = `${req.protocol}://${req.get('host')}/p/${id}`;
      res.status(201).json({ id, url, ...(minted ? { token: minted } : {}) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/projects/:slug', (req, res) => {
    const project = getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'not found' });
    res.json(project);
  });

  app.get('/api/projects/:slug/activity', (req, res) => {
    const activity = getActivity(req.params.slug);
    if (!activity) return res.status(404).json({ error: 'not found' });
    res.json(activity);
  });

  app.get('/api/projects/:slug/git', (req, res) => {
    const git = getGit(req.params.slug);
    if (!git) return res.status(404).json({ error: 'not found' });
    res.json(git);
  });

  // Prefer a live read of the local ~/.claude store (always fresh, used by the
  // local viewer). When none exists — e.g. the hosted server, which only has the
  // uploaded bundle — fall back to the memory snapshot saved from that bundle.
  app.get('/api/projects/:slug/memory', (req, res) => {
    const live = getProjectMemory(req.params.slug);
    if (live && live.ok) return res.json(live);
    res.json(getMemory(req.params.slug) || live);
  });

  app.get('/api/projects/:slug/docs', (req, res) => {
    const docs = getDocs(req.params.slug);
    if (!docs) return res.status(404).json({ error: 'not found' });
    res.json(docs);
  });

  app.get('/api/projects/:slug/sessions/:id', (req, res) => {
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
    app.get(['/app', '/app/*'], sendApp);
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
