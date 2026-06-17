import { listProjects, getSession } from './storage.js';
import { getRatingSummary, getUserVote } from './ratings.js';
import { attachEvidence } from './evidence.js';

// A globally-addressable card id: project ~ session ~ turn index. '~' is URL-safe
// and absent from slugs/session ids, so it round-trips cleanly in /c/<id>.
export const makeCardId = (slug, sessionId, index) => `${slug}~${sessionId}~${index}`;
export function parseCardId(id) {
  const parts = String(id).split('~');
  const index = Number(parts.pop());
  const sessionId = parts.pop();
  return { slug: parts.join('~'), sessionId, index };
}

// The "prompt unit" — VibeRate's atom. A session is a chain of these. Each unit:
//   before  — the minimal context the prompt replies to (prior agent ask ± prior
//             prompt), so a dependent mid-convo prompt ("the latter") is legible
//   prompt  — the user's turn: what gets rated / discussed / permalinked
//   after   — a capped narrative of what the agent did (reasoning/actions/verdict)
//   docRefs — .md files the prompt points at (inlined from captured docs)
// Pure acknowledgements ("go ahead", "continue") are flagged isAck and folded —
// they're connective tissue, not publishable will-expressions.

const ACK_RE = /^(continue|go ahead|go for it|keep going|proceed|go|yes|yep|yup|y|ok|okay|sure|next|do it|please continue|sure go for it|sure do it|resume|carry on)[.! ]*$/i;
const isAck = (t) => {
  const s = String(t || '').trim();
  return !s || ACK_RE.test(s) || s.length < 12;
};

// Tooling/system artifacts that ride in as user-role text but aren't prompts:
// slash-command wrappers, skill injections, interrupt markers, harness tags.
const NOISE_RE = /<command-(message|name|args)>|<system-reminder>|<environment_context>|<local-command-|<task-notification>|^\s*\[Request interrupted|Base directory for this skill:|This session is being continued from a previous conversation|Caveat: The messages below were generated|^\s*<(ide_|task-)/i;
const isNoise = (t) => NOISE_RE.test(String(t || ''));

const clip = (s, n, tail = false) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  return tail ? '…' + s.slice(-n) : s.slice(0, n) + '…';
};
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function toolCmd(m) {
  const inp = m.input;
  if (inp && typeof inp === 'object') {
    const c = inp.command || inp.cmd;
    return Array.isArray(c) ? c.join(' ') : c || null;
  }
  return null;
}
function toolFile(m) {
  const inp = m.input;
  if (inp && typeof inp === 'object') return inp.file_path || inp.path || inp.notebook_path || null;
  if (typeof inp === 'string') {
    const x = inp.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
    if (x) return x[1].trim();
  }
  return null;
}

function docRefs(text) {
  const m = String(text || '').match(/\b[\w./-]+\.md\b/gi) || [];
  return [...new Set(m.map((x) => x.split(/[\/\\]/).pop()))].slice(0, 5);
}

// Group messages into turns delimited by user text messages.
function buildTurns(messages) {
  const turns = [];
  let cur = null;
  for (const m of messages || []) {
    if (m.kind === 'text' && m.role === 'user') {
      cur = { user: m, items: [] };
      turns.push(cur);
    } else {
      if (!cur) {
        cur = { user: null, items: [] };
        turns.push(cur);
      }
      cur.items.push(m);
    }
  }
  return turns;
}

const lastAssistantText = (items) => {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m.kind === 'text' && m.role === 'assistant') return m.text;
  }
  return null;
};

// How full the model's context window was when this prompt was sent: read the
// usage off the first assistant message that answered it (that request's input
// includes this prompt + everything before it). null when usage wasn't captured
// (e.g. Codex sessions). Surfaced per-prompt as the "dumb zone" gauge.
function contextAt(items) {
  for (const m of items) {
    const u = m.usage;
    if (u && u.context) {
      const window = u.window || 200000;
      return { tokens: u.context, window, pct: Math.min(100, Math.round((u.context / window) * 100)), model: u.model || null };
    }
  }
  return null;
}

// Capped after-narrative: reasoning first-lines + tool actions, plus the final
// assistant text as the "verdict". stepCount lets the UI show "+N more".
function summarizeAfter(items, cap = 6) {
  const steps = [];
  let verdict = null;
  for (const m of items) {
    if (m.kind === 'text' && m.role === 'assistant') verdict = m.text;
    else if (m.kind === 'thinking') steps.push({ kind: 'reason', text: firstLine(m.text).slice(0, 120) });
    else if (m.kind === 'tool_use') {
      const f = toolFile(m);
      const c = toolCmd(m);
      steps.push({ kind: 'action', text: `${m.name || 'tool'}${f ? ': ' + f : c ? ': ' + clip(c, 100) : ''}` });
    }
  }
  return { steps: steps.slice(0, cap), stepCount: steps.length, verdict: verdict ? clip(verdict, 400) : null };
}

export function extractPromptUnits(session, sessionId, slug = null, { evidence = null } = {}) {
  const turns = buildTurns(session.messages);
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (!t.user) continue;
    const prompt = t.user.text || '';
    const prev = turns[i - 1];
    let before = null;
    if (prev) {
      const agent = lastAssistantText(prev.items);
      const pu = prev.user ? prev.user.text : null;
      if (agent || pu) before = { prompt: pu ? clip(pu, 200) : null, agent: agent ? clip(agent, 320, true) : null };
    }
    out.push({
      id: `${sessionId}#${i}`,
      cardId: slug ? makeCardId(slug, sessionId, i) : null,
      index: i,
      prompt,
      ts: t.user.ts || null,
      isAck: isAck(prompt),
      isNoise: isNoise(prompt),
      before,
      after: summarizeAfter(t.items),
      docRefs: docRefs(prompt),
      context: contextAt(t.items),
      chars: prompt.length,
    });
  }
  if (evidence) attachEvidence(out, evidence, sessionId);
  return out;
}

// The discover feed: substantive (non-ack) prompt units across published projects,
// newest first. `publicOnly` is off locally (everything is yours) and on when hosted.
export function buildFeed(limit = 60, { publicOnly = true, userId = null } = {}) {
  const projects = listProjects().filter((p) => !publicOnly || p.visibility === 'public');
  const cards = [];
  for (const p of projects) {
    for (const s of p.sessions || []) {
      const sess = getSession(p.slug, s.id);
      if (!sess) continue;
      for (const u of extractPromptUnits(sess, s.id, p.slug)) {
        if (u.isAck || u.isNoise || u.chars < 20) continue;
        cards.push({
          ...u,
          project: { slug: p.slug, name: p.name || p.slug },
          source: s.source,
          sessionId: s.id,
          sessionTitle: s.title,
          rating: getRatingSummary(u.cardId),
          myVote: userId ? getUserVote(u.cardId, userId) : 0,
        });
      }
    }
  }
  // newest first for now; top-rated / most-discussed sorts come with the feed work
  cards.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return cards.slice(0, limit);
}
