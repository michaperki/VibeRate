import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { hashToken, encryptSecret, decryptSecret } from './auth.js';

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

// Find the user that has claimed a given owner hash (or null). Lets an
// account-linked machine token act with the account's full project scope.
export function findUserByOwnerHash(ownerHash) {
  let files = [];
  try {
    files = fs.readdirSync(usersDir());
  } catch {
    return null; // no users dir yet
  }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const u = readJson(path.join(usersDir(), f), null);
    if (u && Array.isArray(u.ownerHashes) && u.ownerHashes.includes(ownerHash)) return u;
  }
  return null;
}

// --- per-user GitHub connection (ONBOARDING.md Fork 2 Slice 2) ------------------
// A user can connect their GitHub account with `repo` scope so we can list their
// repos and clone/push private ones with THEIR token instead of the shared instance
// `GITHUB_TOKEN`. The OAuth access token is stored ENCRYPTED at rest (encryptSecret)
// and only ever decrypted in-memory at clone/push time — never returned to the
// browser. Shape: `user.github = { token: <enc>, login, connectedAt }`.
export function setGithubConnection(id, { token, login }) {
  const file = path.join(usersDir(), `${id}.json`);
  const user = readJson(file, null);
  if (!user) return null;
  user.github = { token: encryptSecret(token), login: login || null, connectedAt: new Date().toISOString() };
  user.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(user, null, 2));
  return user;
}

export function clearGithubConnection(id) {
  const file = path.join(usersDir(), `${id}.json`);
  const user = readJson(file, null);
  if (!user) return null;
  delete user.github;
  user.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(user, null, 2));
  return user;
}

// Decrypt a connected user's GitHub token (or null). Server-side use only.
export function getGithubToken(user) {
  if (!user || !user.github || !user.github.token) return null;
  return decryptSecret(user.github.token);
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
