import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjects, getProject, getSession, getActivity, getGit, getDocs, getMemory, ingestBundle } from './storage.js';
import { getProjectMemory } from './workspace.js';
import { getContext } from './context.js';
import { BUNDLE_SCHEMA } from './bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

export function startServer(port = 4317) {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // bundles carry full conversations

  // Liveness probe for the host's health checks. Cheap, no I/O.
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, schema: BUNDLE_SCHEMA });
  });

  app.get('/api/projects', (_req, res) => {
    res.json(listProjects());
  });

  // Cold-start context: what each agent preloads when launched in a directory.
  app.get('/api/context', (_req, res) => {
    res.json(getContext());
  });

  // Ingest: accept a pushed bundle, store it under a fresh unlisted id, and
  // return the shareable URL. Anonymous (gist-style) — no auth required in v1.
  app.post('/api/projects', (req, res) => {
    const bundle = req.body;
    if (!bundle || typeof bundle !== 'object' || !bundle.project || !Array.isArray(bundle.sessions)) {
      return res.status(400).json({ error: 'invalid bundle' });
    }
    if (bundle.schema !== BUNDLE_SCHEMA) {
      return res.status(409).json({ error: `unsupported schema ${bundle.schema}; expected ${BUNDLE_SCHEMA}` });
    }
    try {
      const { id } = ingestBundle(bundle);
      const url = `${req.protocol}://${req.get('host')}/p/${id}`;
      res.status(201).json({ id, url });
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

  // Hosted single-project page: /p/<id> serves the SPA, which reads the id from
  // the URL and loads that project directly (no picker).
  app.get('/p/:id', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use(express.static(PUBLIC_DIR));

  // Bind all interfaces so the app is reachable inside a container / behind a
  // platform proxy (not just loopback).
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => resolve({ server, port }));
  });
}
