// WS3 smoke gate — PLAN_HARNESS_VERSIONING.md.
//
// The tripwire that makes "auto-grab latest" SAFE: pipe golden fixtures through the
// REAL parsers and assert the load-bearing schema we depend on still holds. When a
// Claude Code release changes a parsed field, this turns red in CI BEFORE the image
// ships — so we adapt the UI on our schedule, not after a user hits a broken turn.
//
// Coverage maps to the §0 coupling inventory:
//   1. stream-json event shape  → src/agent.js handleRawEvent (via __replayForTest)
//   2. JSONL transcript schema   → src/parsers.js parseClaude
//   3. hook event names + payload → src/hooks.js eventFromPayload
//   4. usage / cache token keys   → asserted across all three
//
// Run: `npm run test:harness` (or `node test/harness-smoke.test.mjs`). Zero deps.
// Fixtures should be RE-CAPTURED from a real driven session occasionally so they
// track our own evolving usage, not drift into a stale hand-authored shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { __replayForTest } from '../src/agent.js';
import { parseClaude } from '../src/parsers.js';
import { eventFromPayload } from '../src/hooks.js';
import { cmpSemver, behindCount, parseVersion } from '../src/harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  }
}

function readJsonl(file) {
  return fs.readFileSync(path.join(FIX, file), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------- 1. stream-json (the live agent.js path) ----------

test('stream-json: system/init carries model, version, and tool count', () => {
  const { events, session } = __replayForTest(readJsonl('claude-stream.jsonl'));
  const sys = events.find((e) => e.kind === 'system');
  assert.ok(sys, 'expected a system event from system/init');
  assert.equal(sys.model, 'claude-opus-4-8[1m]', 'init.model must be surfaced');
  assert.equal(sys.version, '2.1.185', 'init.version (WS1) must be captured');
  assert.equal(sys.tools, 4, 'init.tools[] length must be surfaced');
  assert.equal(session.claudeSessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(session.harnessVersion, '2.1.185', 'version must stick to the session');
});

test('stream-json: thinking + text deltas stream as partials', () => {
  const { events } = __replayForTest(readJsonl('claude-stream.jsonl'));
  assert.ok(events.some((e) => e.kind === 'thinking_start'), 'thinking_start');
  const td = events.filter((e) => e.kind === 'thinking_delta').map((e) => e.text).join('');
  assert.equal(td, 'Let me read the plan first.', 'thinking_delta text');
  const at = events.filter((e) => e.kind === 'assistant_text_delta').map((e) => e.text).join('');
  assert.equal(at, 'On it — reading the plan.Got it.', 'assistant_text_delta text across both blocks');
});

test('stream-json: streamed text is NOT double-emitted as a whole assistant_text', () => {
  const { events } = __replayForTest(readJsonl('claude-stream.jsonl'));
  // streamedText/streamedThinking flags must suppress the consolidated message,
  // else the reader renders every reply twice (the dedupe in handleRawEvent).
  assert.equal(events.filter((e) => e.kind === 'assistant_text').length, 0, 'no duplicate assistant_text');
  assert.equal(events.filter((e) => e.kind === 'thinking').length, 0, 'no duplicate thinking');
});

test('stream-json: tool_use is surfaced with name + input, and the plan is inferred', () => {
  const { events, session } = __replayForTest(readJsonl('claude-stream.jsonl'));
  const tu = events.find((e) => e.kind === 'tool_use');
  assert.ok(tu, 'tool_use event');
  assert.equal(tu.name, 'Read');
  assert.equal(tu.input.file_path, '/repo/PLAN_HARNESS_VERSIONING.md');
  assert.equal(session.currentPlan, 'PLAN_HARNESS_VERSIONING.md', 'planDocOf must pick up the PLAN file');
  assert.equal(session.lastAction.verb, 'read');
});

test('stream-json: tool_result comes back as a synthetic user turn', () => {
  const { events } = __replayForTest(readJsonl('claude-stream.jsonl'));
  const tr = events.find((e) => e.kind === 'tool_result');
  assert.ok(tr, 'tool_result event');
  assert.equal(tr.isError, false);
  assert.match(tr.text, /PLAN_HARNESS_VERSIONING/);
});

test('stream-json: interim + final usage feed the context meter (cache keys intact)', () => {
  const { events, session } = __replayForTest(readJsonl('claude-stream.jsonl'));
  const usageEvents = events.filter((e) => e.kind === 'usage');
  assert.ok(usageEvents.length >= 1, 'at least one usage event from message_start');
  const u = usageEvents[0].usage;
  for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    assert.ok(k in u, `usage must carry ${k}`);
  }
  // Final result usage recomputes the meter: 1500 + 3200 + 600 = 5300.
  assert.equal(session.ctxTokens, 5300, 'ctxTokens from the result usage');
});

test('stream-json: result carries cost, usage, and duration', () => {
  const { events } = __replayForTest(readJsonl('claude-stream.jsonl'));
  const r = events.find((e) => e.kind === 'result');
  assert.ok(r, 'result event');
  assert.equal(r.isError, false);
  assert.equal(r.costUsd, 0.0123, 'total_cost_usd surfaced (not on subscription in test)');
  assert.equal(r.durationMs, 4210);
  assert.equal(r.usage.output_tokens, 42);
});

// ---------- 2. JSONL transcript (the parsers.js / capture path) ----------

test('JSONL: parseClaude yields the normalized session shape', async () => {
  const s = await parseClaude(path.join(FIX, 'claude-transcript.jsonl'));
  assert.equal(s.source, 'claude');
  assert.equal(s.cwd, '/repo');
  assert.equal(s.title, 'Read SEED.md and start the harness work');
  assert.equal(s.startedAt, '2026-06-23T10:00:00.000Z');
  assert.ok(s.messageCount > 0);
});

test('JSONL: every content-block type is normalized', async () => {
  const s = await parseClaude(path.join(FIX, 'claude-transcript.jsonl'));
  const kinds = new Set(s.messages.map((m) => m.kind));
  for (const k of ['text', 'thinking', 'tool_use', 'tool_result']) {
    assert.ok(kinds.has(k), `expected a ${k} message`);
  }
  const toolUse = s.messages.find((m) => m.kind === 'tool_use');
  assert.equal(toolUse.name, 'Read');
  assert.equal(toolUse.input.file_path, '/repo/SEED.md');
});

test('JSONL: assistant usage is normalized with the cache buckets + 1M window', async () => {
  const s = await parseClaude(path.join(FIX, 'claude-transcript.jsonl'));
  const withUsage = s.messages.find((m) => m.usage);
  assert.ok(withUsage, 'an assistant part must carry usage');
  const u = withUsage.usage;
  for (const k of ['input', 'cacheRead', 'cacheCreate', 'output', 'context', 'window']) {
    assert.ok(k in u, `normalized usage must have ${k}`);
  }
  assert.equal(u.context, 1000 + 2000 + 300, 'context = input + cacheRead + cacheCreate');
  assert.equal(u.window, 1_000_000, '[1m] model → 1M context window');
});

// ---------- 3. hook event names (the hooks.js path) ----------

test('hooks: every wired event name maps to the expected compact event', () => {
  const cases = [
    [{ hook_event_name: 'UserPromptSubmit', session_id: 's' }, 'prompt', null],
    [{ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x' } }, 'tool', 'start'],
    [{ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 'tool', 'end'],
    [{ hook_event_name: 'Stop' }, 'idle', null],
    [{ hook_event_name: 'SessionStart' }, 'start', null],
    [{ hook_event_name: 'SessionEnd' }, 'end', null],
  ];
  for (const [payload, ev, phase] of cases) {
    const out = eventFromPayload(payload);
    assert.ok(out, `event for ${payload.hook_event_name}`);
    assert.equal(out.ev, ev, `${payload.hook_event_name} → ev:${ev}`);
    if (phase) assert.equal(out.phase, phase);
  }
});

test('hooks: PreToolUse classifies the tool into a coarse category', () => {
  const out = eventFromPayload({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/a.js' } });
  assert.equal(out.cat, 'edit');
  assert.equal(out.target, '/repo/a.js'); // no cwd → absolute path kept
});

// ---------- 4. harness drift math (the rail's computation) ----------

test('harness: semver compare + behind-count + version parse', () => {
  assert.equal(cmpSemver('2.1.185', '2.1.186'), -1);
  assert.equal(cmpSemver('2.1.186', '2.1.186'), 0);
  assert.equal(cmpSemver('2.2.0', '2.1.999'), 1);
  assert.equal(parseVersion('2.1.185 (Claude Code)'), '2.1.185');
  const latestData = { latest: '2.1.187', releases: ['2.1.187', '2.1.186', '2.1.185', '2.1.184'], time: {} };
  assert.equal(behindCount(latestData, '2.1.185'), 2, '186 and 187 are ahead');
  assert.equal(behindCount(latestData, '2.1.187'), 0, 'up to date');
});

// ---------- report ----------

if (failures.length) {
  console.error(`\n✗ harness smoke gate: ${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) {
    console.error(`  ✗ ${f.name}`);
    console.error(`    ${String(f.err && f.err.message || f.err).split('\n').join('\n    ')}`);
  }
  console.error('\nThe parsed harness schema changed. Adapt the parser (src/agent.js /');
  console.error('parsers.js / hooks.js) to the new shape BEFORE shipping this harness update.\n');
  process.exit(1);
}
console.log(`\n✓ harness smoke gate: all ${passed} checks passed — parsed schema is intact.\n`);
