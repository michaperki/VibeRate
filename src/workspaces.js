// Drive workspaces (PLAN_DRIVE_WORKSPACES.md): a project's real git checkout on
// the Drive host. Hosted Drive runs agents on the Fly volume, so for "✦ Drive in
// project X" to work *on X's code* we clone X once into <root>/<slug> and bind it
// to the project manifest. Cloning is one-time project setup — never per-convo.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from './paths.js';
import { getWorkspace, setWorkspace } from './storage.js';

const exec = promisify(execFile);

// Root for all checkouts — a dedicated dir on the volume, never /app (server
// source) or the project store. Override with VBRT_WORKSPACES_DIR.
export function workspacesRoot() {
  return process.env.VBRT_WORKSPACES_DIR || path.join(DATA_DIR, 'workspaces');
}

// A slug is filesystem-safe (slugify) or a base64url id (A-Za-z0-9_-). Reject
// anything that could escape the root, then map to <root>/<slug>.
export function workspaceDir(slug) {
  if (!slug || /[/\\]|\.\./.test(slug)) throw new Error('invalid project slug');
  return path.join(workspacesRoot(), slug);
}

// Build the URL git actually clones from. For a private github https repo we inject
// the instance's GITHUB_TOKEN (a Fly secret) as x-access-token; the token is used
// only here and never persisted or returned. No token ever travels via the browser.
function authedRepoUrl(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    const m = /^https:\/\/(github\.com\/.+)$/.exec(repo);
    if (m) return `https://x-access-token:${token}@${m[1]}`;
  }
  return repo;
}

// Keep a leaked token out of error text / logs.
function redact(s) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let out = String(s || '');
  if (token) out = out.split(token).join('***');
  return out.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}

// Accept only real git URLs (https or scp-style ssh). Refuse file:// and local
// paths so the control plane can't be coaxed into cloning arbitrary host paths.
function validRepo(repo) {
  return typeof repo === 'string' && (/^https:\/\/\S+$/.test(repo) || /^git@[\w.-]+:\S+$/.test(repo));
}

async function headSha(dir) {
  try {
    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD']);
    return stdout.trim() || null;
  } catch { return null; }
}

// Clone (or re-clone) a project's repo into its workspace dir. Marks the manifest
// `cloning` immediately so the UI can poll, then `ready`/`error` on completion.
// Returns the initial workspace record (status `cloning`).
export async function startClone(slug, { repo, branch } = {}) {
  if (!validRepo(repo)) throw new Error('a valid https or git@ repo URL is required');
  const dir = workspaceDir(slug);
  const cur = getWorkspace(slug);
  if (!cur) throw new Error('unknown project');
  if (cur.workspace && cur.workspace.status === 'cloning') throw new Error('a clone is already in progress');

  const ws = setWorkspace(slug, { repo, branch: branch || null, dir, status: 'cloning', error: null });

  // Run the clone in the background; the route returns the `cloning` status and the
  // UI polls GET /workspace/:slug until it flips to ready/error.
  (async () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(workspacesRoot(), { recursive: true });
      const args = ['clone'];
      if (branch) args.push('--branch', branch, '--single-branch');
      args.push(authedRepoUrl(repo), dir);
      await exec('git', args, { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      setWorkspace(slug, { status: 'ready', head: await headSha(dir), error: null });
    } catch (err) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      setWorkspace(slug, { status: 'error', error: redact(err && err.message ? err.message : String(err)) });
    }
  })();

  return ws;
}

// Refresh a ready workspace to the remote tip (fetch + hard reset). Agents can also
// pull/push themselves; this is the manual "catch up" button.
export async function syncWorkspace(slug) {
  const cur = getWorkspace(slug);
  if (!cur || !cur.workspace || cur.workspace.status !== 'ready') throw new Error('workspace is not ready');
  const dir = cur.workspace.dir || workspaceDir(slug);
  const branch = cur.workspace.branch;
  try {
    await exec('git', ['-C', dir, 'fetch', '--prune', 'origin'], { timeout: 2 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const target = branch ? `origin/${branch}` : 'origin/HEAD';
    await exec('git', ['-C', dir, 'reset', '--hard', target]);
    return setWorkspace(slug, { status: 'ready', head: await headSha(dir), error: null });
  } catch (err) {
    return setWorkspace(slug, { status: 'error', error: redact(err && err.message ? err.message : String(err)) });
  }
}

// The cwd a driven session should use for this project, or null if it isn't ready.
export function resolveProjectCwd(slug) {
  const cur = getWorkspace(slug);
  if (!cur || !cur.workspace || cur.workspace.status !== 'ready') return null;
  const dir = cur.workspace.dir || workspaceDir(slug);
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// Status for the UI: the binding + the repo URL to prefill the setup form.
export function workspaceStatus(slug) {
  const cur = getWorkspace(slug);
  if (!cur) return null;
  return { workspace: cur.workspace, suggestedRepo: cur.suggestedRepo, name: cur.name };
}
