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
import { parseClaude } from './parsers.js';
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
