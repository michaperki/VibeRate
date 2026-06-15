import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { hashToken } from './auth.js';

// Web accounts: one JSON file per user under DATA_DIR/users. A user is keyed by
// a stable hash of provider+providerId, and carries the machine-token owner
// hashes they've claimed (via /link) — that's how CLI pushes attach to a signed-in
// account. Email lets the same person reconcile across providers later if wanted.

const usersDir = () => path.join(DATA_DIR, 'users');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function userIdFor(provider, providerId) {
  return hashToken(`${provider}:${providerId}`).slice(0, 24);
}

export function getUser(id) {
  if (!id) return null;
  return readJson(path.join(usersDir(), `${id}.json`), null);
}

export function upsertUser({ provider, providerId, email, name }) {
  const id = userIdFor(provider, providerId);
  fs.mkdirSync(usersDir(), { recursive: true });
  const file = path.join(usersDir(), `${id}.json`);
  const user = readJson(file, null) || {
    id,
    provider,
    providerId: String(providerId),
    ownerHashes: [],
    createdAt: new Date().toISOString(),
  };
  user.email = email || user.email || null;
  user.name = name || user.name || null;
  user.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(user, null, 2));
  return user;
}

// Bind a machine-token owner hash to a user (idempotent). Returns the user.
export function linkOwner(id, ownerHash) {
  const file = path.join(usersDir(), `${id}.json`);
  const user = readJson(file, null);
  if (!user) return null;
  if (!user.ownerHashes.includes(ownerHash)) {
    user.ownerHashes.push(ownerHash);
    user.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(user, null, 2));
  }
  return user;
}
