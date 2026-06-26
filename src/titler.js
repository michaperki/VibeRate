// Smart conversation titles. A captured Drive session's raw "title" is just its
// first typed prompt — which scans badly in a list: every row opens with the same
// boilerplate ("You're a retrospective agent. As a retrospec…") and the
// distinguishing content is past the truncation point (UI review 2026-06-26, the
// single biggest scannability win). This module turns that opening message into a
// short, human-readable title with Haiku — the same cheap-catalog-model pattern as
// classify.js — and caches the result on disk keyed by the durable claudeSessionId,
// so we summarize a conversation once, ever.
//
// Best-effort by design: no key, an API error, or an empty prompt all yield null,
// and every caller falls back to the raw preview. The Anthropic SDK is lazy-imported
// (like classify.js / evidence.js) so this file stays copy-safe into the dep-free
// skill bundle.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const MODEL = 'claude-haiku-4-5';
const CACHE_FILE = path.join(DATA_DIR, 'session-titles.json');

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Disk-backed cache, loaded once. { [claudeSessionId]: { title, at } }.
let _cache = null;
function cache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
  } catch {
    _cache = {};
  }
  return _cache;
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache()));
  } catch {
    /* cache is an optimization — never let a write failure break the list endpoint */
  }
}

export function cachedTitle(id) {
  const e = cache()[id];
  return (e && e.title) || null;
}

let _client = null;
async function client() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic();
  return _client;
}

const SYSTEM = `You write a short, human-scannable title for one coding-agent conversation, given its opening message. Rules:
- 2 to 6 words. No trailing punctuation, no quotes, no markdown, no emoji.
- Capture the SPECIFIC task or intent, never the agent's role boilerplate ("You are a … agent", "As a …", "Your job is to …").
- Phrase it like a good PR/commit title — imperative or a noun phrase ("Tighten the example gallery", "Retrospective on past sessions", "Fix the SSE backfill flash").
- If the message is vague or generic, summarize what it actually asks for in the same short form.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { title: { type: 'string' } },
  required: ['title'],
};

// Tidy the model's output: strip wrapping quotes/backticks, drop trailing
// punctuation, and clamp length so one runaway title can't blow out a row.
function clean(t) {
  let s = String(t || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[.?!,;:]+$/, '')
    .trim();
  if (s.length > 56) s = s.slice(0, 55).trim() + '…';
  return s;
}

const inflight = new Set();

// Generate (and cache) a smart title for one session from its opening prompt.
// Returns the title, or null on no-key / error / empty. Concurrent calls for the
// same id dedupe (the first wins; the rest see the cache or back off).
export async function generateTitle(id, firstPrompt) {
  if (!hasKey() || !id) return null;
  const cached = cachedTitle(id);
  if (cached) return cached;
  const prompt = String(firstPrompt || '').trim().slice(0, 1200);
  if (!prompt) return null;
  if (inflight.has(id)) return null;
  inflight.add(id);
  try {
    const c = await client();
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 64,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `Opening message:\n${prompt}` }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = (res.content.find((b) => b.type === 'text') || {}).text || '';
    const title = clean(JSON.parse(text).title);
    if (!title) return null;
    cache()[id] = { title, at: Date.now() };
    persist();
    return title;
  } catch (e) {
    // Best-effort: swallow so it never breaks the list, but log so failures are observable.
    console.error('[titler] call failed:', e && (e.status || ''), e && (e.message || e));
    return null;
  } finally {
    inflight.delete(id);
  }
}

// Resolve smart titles for a batch of { id, firstPrompt }. Returns an id->title map
// for those resolved (cached first, then freshly generated up to `max`, newest-first
// per the caller's ordering). The overflow beyond `max` is generated in the
// background (fire-and-forget) so a later load is instant — keeping the first call's
// latency bounded even for a project with dozens of sessions. Unresolved ids simply
// aren't in the map; the caller falls back to the raw preview.
export async function titlesFor(items, { concurrency = 5, max = 14 } = {}) {
  const out = {};
  for (const it of items) {
    const t = cachedTitle(it.id);
    if (t) out[it.id] = t;
  }
  if (!hasKey()) return out;
  const pending = items.filter((it) => it.id && it.firstPrompt && !out[it.id]);
  const todo = pending.slice(0, max);
  const overflow = pending.slice(max);
  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((it) => generateTitle(it.id, it.firstPrompt)));
    batch.forEach((it, j) => { if (res[j]) out[it.id] = res[j]; });
  }
  // Warm the cache for the long tail in the background — bounded to the same
  // concurrency, never awaited — so a project with dozens of sessions doesn't fan out
  // dozens of parallel API calls, and a later load finds them already cached.
  if (overflow.length) {
    (async () => {
      for (let i = 0; i < overflow.length; i += concurrency) {
        const batch = overflow.slice(i, i + concurrency);
        await Promise.all(batch.map((it) => generateTitle(it.id, it.firstPrompt)));
      }
    })().catch(() => {});
  }
  return out;
}
