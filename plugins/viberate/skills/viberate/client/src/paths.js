import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

// Where vbrt stores captured projects (flat JSON on disk). Default to ~/.viberate
// but fall back to the legacy ~/.ratemyprompt if it exists and the new one doesn't,
// so projects captured before the rename still show without a migration step.
function defaultDataDir() {
  const nu = path.join(HOME, '.viberate');
  const legacy = path.join(HOME, '.ratemyprompt');
  try {
    if (!fs.existsSync(nu) && fs.existsSync(legacy)) return legacy;
  } catch {
    /* ignore */
  }
  return nu;
}
export const DATA_DIR = process.env.VBRT_DATA_DIR || process.env.RMP_DATA_DIR || defaultDataDir();
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

// Normalize any path (Windows or WSL/Linux, any case) to one comparable key.
//   C:\Users\PerkD\Documents\dev\X  ->  /mnt/c/users/perkd/documents/dev/x
//   /mnt/c/Users/PerkD/documents/dev/X -> /mnt/c/users/perkd/documents/dev/x
// This lets a session recorded in WSL match an `rmp` run from Windows (and
// papers over the documents/Documents casing difference).
export function canonicalKey(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').trim();
  const drive = s.match(/^([a-zA-Z]):\/(.*)$/);
  if (drive) s = `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

// Turn a cwd into a short, filesystem-safe, environment-stable project slug.
export function slugify(cwd) {
  const key = canonicalKey(cwd);
  const base = key.split('/').filter(Boolean).pop() || 'root';
  return base.replace(/[^a-z0-9._-]/g, '-');
}

function existing(p) {
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// When run from Windows, the actual session logs usually live in a WSL distro's
// home dir, reachable via \\wsl.localhost\<distro>\home\<user>\... Probe those.
function wslHomeBases() {
  if (process.platform !== 'win32') return [];
  const bases = [];
  for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
    let distros;
    try {
      distros = fs.readdirSync(prefix, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of distros) {
      const homeDir = path.join(prefix, d.name, 'home');
      let users;
      try {
        users = fs.readdirSync(homeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const u of users) bases.push(path.join(homeDir, u.name));
    }
  }
  return bases;
}

function storeRoots(envVars, ...subdirs) {
  const roots = [];
  for (const v of envVars) if (process.env[v]) roots.push(process.env[v]);
  roots.push(path.join(HOME, ...subdirs));
  for (const base of wslHomeBases()) roots.push(path.join(base, ...subdirs));
  return [...new Set(roots)].filter(existing);
}

// Every existing Claude `projects` dir we should search.
export function claudeRoots() {
  return storeRoots(['VBRT_CLAUDE_DIR', 'RMP_CLAUDE_DIR'], '.claude', 'projects');
}

// Every existing Codex `sessions` dir we should search.
export function codexRoots() {
  return storeRoots(['VBRT_CODEX_DIR', 'RMP_CODEX_DIR'], '.codex', 'sessions');
}
