import { listProjects, getSession, getGit, getEvidence, getClassify } from './storage.js';
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

function classifyTool(name) {
  const n = (name || '').toLowerCase();
  if (/write|edit|apply_patch|create|notebook|patch|update_plan/.test(n)) return 'edit';
  if (/bash|exec|shell|command|run|terminal/.test(n)) return 'cmd';
  if (/read|cat|view|open/.test(n)) return 'read';
  if (/grep|glob|search|find|^ls|list/.test(n)) return 'search';
  if (/fetch|web|browser|http/.test(n)) return 'web';
  return 'other';
}

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

function deriveOutcomes(items, prompt, ctx) {
  const files = new Set();
  const brainDocs = new Set();
  // Per-doc read/edit identity (basenames) — the brain web joins these to nodes for
  // the "orphan" signal (a node nothing links AND nothing reads). Kept separate from
  // `brainDocsChanged` (a count) and only high-confidence direct file tools; shell
  // `cat`/`rg` land in `cmd` and are deliberately not counted as reads.
  const docsRead = new Set();
  const docsEdited = new Set();
  let edits = 0;
  let commands = 0;
  let tools = 0;
  for (const m of items || []) {
    if (m.kind === 'tool_use') {
      tools++;
      const cat = classifyTool(m.name);
      if (cat === 'edit') edits++;
      if (cat === 'cmd' || toolCmd(m)) commands++;
      const f = toolFile(m);
      if (f) {
        files.add(f);
        if (/\.md$/i.test(f)) {
          const base = f.split(/[/\\]/).pop();
          brainDocs.add(base);
          if (cat === 'edit') docsEdited.add(base);
          else if (cat === 'read') docsRead.add(base);
        }
      }
    }
  }
  for (const d of docRefs(prompt)) brainDocs.add(d);
  return {
    filesChanged: files.size,
    commandsRun: commands,
    brainDocsChanged: brainDocs.size,
    screenshots: 0,
    commitsProduced: 0,
    brainCommits: 0,
    contextPct: ctx ? ctx.pct : null,
    tools,
    edits,
    docsRead: [...docsRead],
    docsEdited: [...docsEdited],
  };
}

// ---------- Stage 2 outcome artifacts (PROJECT_VIEW_PLAN §C) ----------
// A small, deterministic `outcomeArtifact` blob the polymorphic rail renders for
// the `test` / `record` families. Everything here is lifted from data already in
// the bundle (the prompt text + the agent's tool_results) — no new capture, no
// model call. We stay deliberately conservative: a tool's *exit code* "fired on
// normal runs and meant nothing" (§C), so test detection requires a real
// pass/fail summary, and we never fabricate which option was executed from a
// brittle keyword match — the menu is lifted verbatim, execution state is left to
// the provenance layer.

// Recognized test-runner invocations — the *gate* for the whole test family. A
// pass/fail verdict is only read out of a tool_result when the command that
// produced it was an actual test run. Without this gate, `testStatusOf` scraped
// every tool_result (diffs, file reads, `vbrt status`) and stitched fake verdicts
// out of stray "passed"/"failed" tokens or any ✓ character — which is exactly the
// "guess command pass/fail from output" noise the product deliberately dropped
// (PRODUCT_STRATEGY.md). Test runs are the one place a real runner summary exists.
const TEST_CMD =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|jest|vitest|mocha|ava|tap\b|pytest|tox|nose|go\s+test|cargo\s+test|cargo\s+nextest|rspec|phpunit|gradlew?\s+test|mvn\s+test|make\s+test)\b/i;

// The shell command behind a tool_use, across agents (Claude `Bash`, Codex
// `shell`/`local_shell`/`exec`), or null if it isn't a shell call. Non-shell
// tools (Read/Grep/Edit/…) never run tests, so they gate out immediately.
function shellCommand(toolUse) {
  if (!toolUse || toolUse.kind !== 'tool_use') return null;
  if (!/^(bash|shell|local_shell|exec)$/i.test(String(toolUse.name || ''))) return null;
  const c = toolUse.input && (toolUse.input.command ?? toolUse.input.cmd);
  if (Array.isArray(c)) return c.join(' ');
  return c == null ? null : String(c);
}

const isTestCommand = (toolUse) => {
  const cmd = shellCommand(toolUse);
  return cmd != null && TEST_CMD.test(cmd);
};

// One test runner's verdict from its output, or null if there's no recognizable
// runner summary. Only called on output we already know came from a test command
// (see the gate above), so it can trust counts / a PASS|FAIL line without the
// over-broad bare-✓ heuristic that used to fire on any tool output.
function testStatusOf(text) {
  const s = String(text || '');
  if (!s || s.length > 20000) return null; // huge dumps aren't a test summary
  const failed = (s.match(/(\d+)\s+(?:failed|failing)\b/i) || [])[1];
  const passed = (s.match(/(\d+)\s+(?:passed|passing)\b/i) || [])[1];
  const flaky = (s.match(/(\d+)\s+(?:flaky|skipped|pending)\b/i) || [])[1];
  if (failed != null || passed != null) {
    const f = Number(failed || 0), p = Number(passed || 0), k = Number(flaky || 0);
    const label = [p ? `${p} passed` : '', f ? `${f} failed` : '', k ? `${k} flaky/skipped` : '']
      .filter(Boolean).join(', ');
    return { status: f > 0 ? 'r' : k > 0 ? 'a' : 'g', label };
  }
  if (/^\s*FAIL\b/m.test(s)) return { status: 'r', label: 'failures' };
  if (/^\s*PASS\b/m.test(s) || /all tests passed/i.test(s)) return { status: 'g', label: 'passing' };
  return null;
}

// Test-status timeline (#10/#4): the pass→fail→green arc across the turn's *test
// runs*. Each tool_result is read only if its immediately preceding tool_use was a
// recognized test command. Collapses consecutive identical states so "green green
// green" reads as one. (Pairing is positional, not by tool_use_id — the parser
// doesn't keep ids — so a test run batched *in parallel* with other tool calls can
// be missed. That's the safe direction: a dropped verdict, never a fabricated one.)
function extractTestTimeline(items) {
  const segs = [];
  let lastWasTest = false;
  for (const m of items || []) {
    if (m.kind === 'tool_use') { lastWasTest = isTestCommand(m); continue; }
    if (m.kind !== 'tool_result') continue;
    if (!lastWasTest) continue; // output of a non-test command — never a verdict
    const v = testStatusOf(m.text);
    if (v) segs.push(v);
  }
  if (!segs.length) return null;
  const collapsed = segs.filter((s, i) => i === 0 || s.status !== segs[i - 1].status);
  const last = collapsed[collapsed.length - 1];
  return {
    kind: 'test',
    segments: collapsed.map((s) => s.status),
    label: segs[segs.length - 1].label,
    verdict: last.status === 'r' ? 'FAIL' : last.status === 'a' ? 'FLAKY' : 'PASS',
  };
}

// Enumerated "options menu" (#8): the choices the prompt put on the table. The
// menu parses cleanly; per-item executed/deferred state is *not* inferred here
// (it needs a transcript↔option semantic match — deferred to the provenance
// layer rather than faked from keyword hits).
function extractOptions(prompt) {
  const items = [];
  for (const ln of String(prompt || '').split('\n')) {
    const m = ln.match(/^\s*(\d{1,2})[.):]?\s+(\S.{2,118}?)\s*$/);
    if (m) items.push({ n: Number(m[1]), text: m[2].trim() });
  }
  if (items.length < 2) return null; // a real menu, not one stray "1."
  return { kind: 'options', items: items.slice(0, 10) };
}

// A labeled value the author typed: `EXPECTED: …`, `RESULT - …`.
function labelVal(s, label) {
  const m = String(s).match(new RegExp(`\\b${label}\\b\\s*[:\\-]\\s*(.{3,220}?)(?:\\n|$)`, 'i'));
  return m ? clip(m[1], 180) : null;
}

// Experiment-as-prompt (#4): the user pastes a designed test + observed result +
// a verdict, in their own words. We lift those labeled blocks verbatim — the
// author's stated outcome, not our guess.
function extractExperiment(prompt) {
  const s = String(prompt || '');
  const expected = labelVal(s, 'expected') || labelVal(s, 'expect');
  const actual = labelVal(s, 'actual') || labelVal(s, 'response') || labelVal(s, 'got');
  const result = labelVal(s, 'result') || labelVal(s, 'outcome');
  if (!expected && !actual && !result) return null;
  let verdict = null;
  if (/\bpartial\b/i.test(result || '')) verdict = 'PARTIAL';
  else if (/\b(fail|wrong|broke|incorrect)\b|[✗✘]/i.test(result || '')) verdict = 'FAIL';
  else if (/\b(pass|works?|correct|good)\b|[✓✔]/i.test(result || '')) verdict = 'PASS';
  return { kind: 'experiment', expected, actual, result, verdict };
}

// Route a prompt-unit to its `outcomeArtifact` (or null). Archetype gates the
// prompt-parse families (experiment/options) so their patterns can't false-fire
// on unrelated prompts; the transcript-derived test timeline is universal but
// self-gating (it only emits on a real runner summary).
function extractOutcomeArtifact(prompt, items, arch) {
  if (arch === 'experiment') {
    const e = extractExperiment(prompt);
    if (e) return e;
  }
  if (arch === 'options') {
    const o = extractOptions(prompt);
    if (o) return o;
  }
  return extractTestTimeline(items);
}

function attachGitOutcomes(units, session, git) {
  const commits = (git && git.commits) || [];
  if (!commits.length || !units.length) return;
  const start = Date.parse(session.startedAt || '') - 5 * 60 * 1000;
  const end = Date.parse(session.endedAt || '') + 30 * 60 * 1000;
  for (const c of commits) {
    if (!c || Number.isNaN(c.t)) continue;
    if (!Number.isNaN(start) && c.t < start) continue;
    if (!Number.isNaN(end) && c.t > end) continue;
    let target = null;
    for (let i = 0; i < units.length; i++) {
      const t = Date.parse(units[i].ts || '');
      if (Number.isNaN(t) || c.t < t) continue;
      const nextT = Date.parse((units[i + 1] && units[i + 1].ts) || '');
      if (Number.isNaN(nextT) || c.t < nextT) {
        target = units[i];
        break;
      }
    }
    if (!target) continue;
    target.outcomes.commitsProduced++;
    if ((c.docs || []).length) target.outcomes.brainCommits++;
  }
}

function finalizeEvidenceOutcomes(units) {
  for (const u of units) {
    if (!u.outcomes) continue;
    u.outcomes.screenshots = (u.evidence || []).length;
  }
}

export function extractPromptUnits(session, sessionId, slug = null, { evidence = null, git = null, classify = null } = {}) {
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
    const context = contextAt(t.items);
    // Images bound to this prompt: ones the user pasted *in* (input), and ones the
    // agent's tools returned during the turn (working screenshots). Capped at 3 so a
    // screenshot-heavy turn stays light in the upload (~<0.4 MB); pasted-input images
    // come first so they're never crowded out by agent shots.
    const attachments = [
      ...((t.user && t.user.images) || []).map((src) => ({ src, kind: 'pasted' })),
      ...t.items.flatMap((m) => (m.images || []).map((src) => ({ src, kind: 'tool' }))),
    ].slice(0, 3);
    // Intent archetype (classify.js) — { archetype, confidence, rationale } or null.
    const archetype = classify && slug ? classify[makeCardId(slug, sessionId, i)] || null : null;
    out.push({
      id: `${sessionId}#${i}`,
      cardId: slug ? makeCardId(slug, sessionId, i) : null,
      index: i,
      prompt,
      ts: t.user.ts || null,
      // A pasted image is a will-expression — don't fold it as a bare ack.
      isAck: isAck(prompt) && !(t.user.images && t.user.images.length),
      isNoise: isNoise(prompt),
      before,
      after: summarizeAfter(t.items),
      docRefs: docRefs(prompt),
      context,
      outcomes: deriveOutcomes(t.items, prompt, context),
      // Images bound to this prompt — `{src, kind}`, kind ∈ pasted | tool.
      attachments,
      archetype,
      // Stage 2 outcome artifact for the test/record families (or null).
      outcomeArtifact: extractOutcomeArtifact(prompt, t.items, archetype && archetype.archetype),
      chars: prompt.length,
    });
  }
  if (evidence) attachEvidence(out, evidence, sessionId);
  if (git) attachGitOutcomes(out, session, git);
  finalizeEvidenceOutcomes(out);
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
      for (const u of extractPromptUnits(sess, s.id, p.slug, { evidence: getEvidence(p.slug), git: getGit(p.slug), classify: getClassify(p.slug) })) {
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
