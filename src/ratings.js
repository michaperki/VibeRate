import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.js';

// Votes on prompt cards. One file per card (keyed by a hash of the card id) so
// concurrent votes on different cards never clobber each other. A user gets one
// vote per card (+1/-1), togg.leable to 0. Score = ups - downs; later, controversy
// = how split the votes are.

const dir = () => path.join(DATA_DIR, 'ratings');
const file = (cardId) => path.join(dir(), crypto.createHash('sha1').update(String(cardId)).digest('hex') + '.json');

function read(cardId) {
  try {
    return JSON.parse(fs.readFileSync(file(cardId), 'utf8'));
  } catch {
    return { cardId, votes: {} };
  }
}

export function getRatingSummary(cardId) {
  const r = read(cardId);
  let up = 0;
  let down = 0;
  for (const v of Object.values(r.votes)) {
    if (v > 0) up++;
    else if (v < 0) down++;
  }
  return { score: up - down, up, down, count: up + down };
}

export function getUserVote(cardId, userId) {
  if (!userId) return 0;
  return read(cardId).votes[userId] || 0;
}

export function voteCard(cardId, userId, value) {
  const r = read(cardId);
  const v = value > 0 ? 1 : value < 0 ? -1 : 0;
  if (v === 0) delete r.votes[userId];
  else r.votes[userId] = v;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(cardId), JSON.stringify(r));
  return getRatingSummary(cardId);
}
