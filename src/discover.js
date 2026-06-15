import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { claudeRoots, codexRoots, canonicalKey } from './paths.js';
import { peekClaude, peekCodex } from './parsers.js';

function listFilesRecursive(dir, ext = '.jsonl') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, ext));
    else if (e.isFile() && e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// Read up to `maxLines` JSON lines, returning the first object that satisfies
// `pick` (used to grab a `cwd` cheaply without parsing the whole file).
async function probe(file, pick, maxLines = 40) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let n = 0;
  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      const val = pick(obj);
      if (val) return val;
      if (++n >= maxLines) break;
    }
  } finally {
    rl.close();
  }
  return null;
}

const claudeCwd = (o) => o.cwd || null;
const codexCwd = (o) => (o.type === 'session_meta' ? o.payload?.cwd : null) || null;

function listSubdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

const baseName = (key) => key.split('/').filter(Boolean).pop() || '';

// Find all Claude + Codex sessions for `targetCwd`, across every known store
// root (local home + WSL distros). A session matches if its cwd canonicalizes
// to the target ('exact'), or if it's the same project folder reached by a
// different absolute path, e.g. /home/me/dev/X vs /mnt/c/.../dev/X ('alias').
export async function discoverSessions(targetCwd) {
  const target = canonicalKey(targetCwd);
  const targetBase = baseName(target);
  const found = [];

  const classify = (cwd) => {
    if (!cwd) return null;
    const k = canonicalKey(cwd);
    if (k === target) return 'exact';
    if (targetBase && baseName(k) === targetBase) return 'alias';
    return null;
  };

  // --- Claude: each project folder is scoped to one cwd; probe one file per
  // folder, then take every session in the matching folders. ---
  for (const root of claudeRoots()) {
    for (const folder of listSubdirs(root)) {
      const files = fs
        .readdirSync(folder)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(folder, f));
      if (files.length === 0) continue;

      let folderCwd = null;
      for (const f of files) {
        folderCwd = await probe(f, claudeCwd);
        if (folderCwd) break;
      }
      const match = classify(folderCwd);
      if (!match) continue;

      for (const file of files) {
        const meta = await peekClaude(file);
        found.push({ source: 'claude', file, aliasMatch: match === 'alias', ...meta });
      }
    }
  }

  // --- Codex: date-organized; cheap first-line cwd probe, peek matches. ---
  for (const root of codexRoots()) {
    for (const file of listFilesRecursive(root)) {
      const cwd = await probe(file, codexCwd, 2);
      const match = classify(cwd);
      if (!match) continue;
      const meta = await peekCodex(file);
      found.push({ source: 'codex', file, aliasMatch: match === 'alias', ...meta });
    }
  }

  // Newest first.
  found.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return found;
}
