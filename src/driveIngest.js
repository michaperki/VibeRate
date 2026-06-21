// Drive → rail ingest: the watcher-free path that makes a driven session appear
// in the Convos rail (DRIVE_CONVO_INGEST_GAP.md).
//
// The read-only capture pipeline (vbrt watch/push) assumes an *external* observer
// polling ~/.claude for a process it didn't spawn. Hosted Drive has no such
// observer — nothing runs `vbrt watch` on the Fly volume, and the JSONL the
// spawned `claude` writes lands under CLAUDE_CONFIG_DIR (the volume), which the
// capture side's claudeRoots() doesn't even look at. So driven sessions wrote a
// durable transcript that nothing ever ingested.
//
// Here we close that gap directly: the Drive runtime already *owns* the process,
// so when a turn ends we know its claude session id. We locate that exact JSONL
// under the config dir the CLI actually used, parse it with the same parser the
// capture pipeline uses, and fold it into the bound project. Event-triggered, not
// polled — no second process, no lock file.

import fs from 'node:fs';
import path from 'node:path';
import { parseClaude, peekClaude } from './parsers.js';
import { claudeConfigDir } from './agent.js';
import { ingestDriveSession } from './storage.js';

// Find the per-session JSONL for `claudeSessionId`. Claude stores it at
// <config>/projects/<cwd-hash>/<sessionId>.jsonl; we know the id but not the
// hashed folder name, so scan the project folders for that exact filename. Using
// claudeConfigDir() (which honors CLAUDE_CONFIG_DIR) is the crux — it points at
// the same dir the spawned binary wrote to, in both local and hosted Drive.
function findSessionJsonl(claudeSessionId) {
  const root = path.join(claudeConfigDir(), 'projects');
  const name = `${claudeSessionId}.jsonl`;
  let folders;
  try {
    folders = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const f of folders) {
    if (!f.isDirectory()) continue;
    const candidate = path.join(root, f.name, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Ingest the transcript of a finished Drive turn into its bound project. Safe to
// call after every turn: parseClaude derives the session id from the filename, so
// it equals claudeSessionId and re-ingests upsert in place (a follow-up turn just
// refreshes the same rail entry rather than duplicating it). Returns the ingest
// result, or null when unbound / not found yet (e.g. the JSONL hasn't flushed).
export async function ingestDriveTurn({ projectSlug, claudeSessionId }) {
  if (!projectSlug || !claudeSessionId) return null;
  const file = findSessionJsonl(claudeSessionId);
  if (!file) return null;
  const session = await parseClaude(file);
  return ingestDriveSession(projectSlug, session);
}

// Claude stores a workspace's sessions under projects/<encoded-cwd>/, where the
// folder name is the absolute cwd with every non-alphanumeric run collapsed to a
// single dash (e.g. /data/workspaces/viberate → -data-workspaces-viberate). This
// encoding is deterministic, so we can name the folder directly instead of
// scanning every project folder.
function encodeCwdFolder(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]+/g, '-');
}

// List every Drive session ever run in a project's workspace by reading the
// durable on-disk transcripts under the config dir — NOT the in-memory session
// Map (which a redeploy wipes) and NOT the browser's localStorage log (which is
// per-device). This is the cross-device, server-side session index the fleet work
// needs: a session started on a phone shows up when you open the project on a
// laptop. Each entry is keyed by the durable claudeSessionId so it re-adopts off
// the same transcript the per-browser log already resumes from.
//
// We peek each JSONL for its first prompt (title) and turn count, and stat it for
// last-active (mtime). Sessions with no typed user turn (an aborted start) are
// dropped — they have nothing to resume. Sorted newest-active first.
export async function listWorkspaceSessions(cwd) {
  if (!cwd) return [];
  const dir = path.join(claudeConfigDir(), 'projects', encodeCwdFolder(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // no sessions in this workspace yet (folder absent)
  }
  const out = [];
  for (const f of files) {
    const file = path.join(dir, f);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    let peek;
    try { peek = await peekClaude(file); } catch { continue; }
    if (!peek || !peek.userTurns) continue; // nothing typed → nothing to resume
    out.push({
      claudeSessionId: f.replace(/\.jsonl$/, ''),
      title: peek.preview || null,
      userTurns: peek.userTurns,
      startedAt: peek.startedAt ? Date.parse(peek.startedAt) || null : null,
      lastAt: Math.round(stat.mtimeMs),
      cwd: peek.cwd || cwd,
    });
  }
  return out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

// Load the saved transcript for a claude session id, parsed into the normalized
// {cwd, title, messages} shape — or null if no JSONL exists on the volume. Powers
// the Drive runtime's adoptSession ("return to Drive" after a redeploy): the
// in-memory session is gone, but this on-disk transcript is the durable record we
// replay to revive it. Same locate+parse as ingest, minus the storage write.
export async function loadDriveTranscript(claudeSessionId) {
  if (!claudeSessionId) return null;
  const file = findSessionJsonl(claudeSessionId);
  if (!file) return null;
  return parseClaude(file);
}
