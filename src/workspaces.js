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

// The repo's bare name, e.g. https://github.com/me/viberate(.git) -> "viberate".
function repoLeaf(repo) {
  const m = /([^/:]+?)(?:\.git)?\/*$/.exec(String(repo || '').trim());
  return m ? m[1] : '';
}

// Lowercase, filesystem-safe leaf (no separators, so it can't escape the root).
function slugifyLeaf(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// Choose the on-disk checkout dir. Hosted project slugs are unguessable base64url
// ids (so share links can't be enumerated), which makes for opaque paths like
// <root>/kEdJ_GdLCGx. For the checkout itself we'd rather read <root>/viberate, so
// derive a friendly name from the repo. Rules: once a dir is chosen it's sticky
// (persisted on the manifest) so re-clones stay put; the friendly name is only
// claimed if free, else we namespace it by slug — because startClone rm -rf's the
// dir, two projects sharing a repo basename must never resolve to the same path.
function pickWorkspaceDir(slug, repo, existingDir) {
  if (existingDir) return existingDir;
  const leaf = slugifyLeaf(repoLeaf(repo));
  if (!leaf) return workspaceDir(slug);
  const friendly = path.join(workspacesRoot(), leaf);
  if (!fs.existsSync(friendly)) return friendly;
  return path.join(workspacesRoot(), `${leaf}-${slug}`);
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
// Install Node deps after a fresh clone so a driven session doesn't boot straight
// into `Cannot find package 'express'`. node_modules isn't cloned, and that was the
// single most common stall in driven sessions — past agents burned turns rediscovering
// they had to `npm install` first. Best-effort: a failure here (offline, odd repo)
// leaves the checkout usable and the agent can still install by hand. Only runs when
// there's a package.json and node_modules isn't already present.
async function installDeps(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return;
  if (fs.existsSync(path.join(dir, 'node_modules'))) return;
  const opts = { cwd: dir, timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 };
  const hasLock = fs.existsSync(path.join(dir, 'package-lock.json'));
  try {
    // `npm ci` is reproducible and never rewrites the lockfile (keeps the checkout
    // clean for the agent's own commits); fall back to `install` if the lock is
    // missing or out of sync with package.json.
    await exec('npm', hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'], opts);
  } catch {
    try { await exec('npm', ['install', '--no-audit', '--no-fund'], opts); } catch { /* leave it to the agent */ }
  }
}

export async function startClone(slug, { repo, branch } = {}) {
  if (!validRepo(repo)) throw new Error('a valid https or git@ repo URL is required');
  const cur = getWorkspace(slug);
  if (!cur) throw new Error('unknown project');
  if (cur.workspace && cur.workspace.status === 'cloning') throw new Error('a clone is already in progress');
  const dir = pickWorkspaceDir(slug, repo, cur.workspace && cur.workspace.dir);

  const ws = setWorkspace(slug, { repo, branch: branch || null, dir, status: 'cloning', error: null });

  // Run the clone in the background; the route returns the `cloning` status and the
  // UI polls GET /workspace/:slug until it flips to ready/error.
  (async () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(workspacesRoot(), { recursive: true });
      const args = ['clone'];
      if (branch) args.push('--branch', branch, '--single-branch');
      // Clone with the plain repo URL. Auth for private github https repos is supplied
      // on demand by the global credential helper (ensureGitAuth, src/agent.js), so the
      // GITHUB_TOKEN is never written into this checkout's .git/config — unlike embedding
      // it in the clone URL, which git persists there. No token touches disk.
      args.push(repo, dir);
      await exec('git', args, { timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
      // Stay in `cloning` while deps install so the agent isn't handed a node_modules-less
      // checkout the instant the git clone returns.
      await installDeps(dir);
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
