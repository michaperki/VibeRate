// Server-side intent classification: tag each substantive prompt-unit with one of
// the 12 PROMPT_GALLERY archetypes (or `default` for the banal majority). Runs at
// ingest, keyed by cardId, cached/incremental — classify a prompt once, ever.
//
// Design (PROJECT_VIEW_PLAN §C): an LLM beats embedding-nearest-centroid here
// because the taxonomy is half-structural (#8 enumerated options, #4 pasted
// result+verdict, #10 console block). Model is Haiku 4.5 — the cheapest catalog
// model — with the rubric in a cached system block and structured output, so a
// high-volume "reads every prompt" pass stays in fractions-of-a-cent territory.
//
// The Anthropic SDK is **lazy-imported** so this file can be copied into the
// dependency-free skill bundle by build-skill.mjs without breaking it: the skill
// never calls classify(), so it never resolves '@anthropic-ai/sdk'. Same trick
// evidence.js uses for Playwright.

const MODEL = 'claude-haiku-4-5';

// The 12 archetypes (PROMPT_GALLERY.md) + the catch-all. `id` is the stable tag
// stored per cardId; `def` is the one-line rubric the model classifies against.
export const ARCHETYPES = [
  { id: 'seed', label: 'Conceptual seed', def: 'Proposes an idea/frame by analogy, not a task ("essentially BPE but for agent behavior").' },
  { id: 'pickup', label: 'Structured pickup', def: 'An LLM-formatted handoff that onboards a fresh agent: names exact files to read, collapses the job to one question.' },
  { id: 'screenshot', label: 'Screenshot redesign', def: 'Frontend/visual/"feel" work, often with images attached; asks for design direction.' },
  { id: 'experiment', label: 'Experiment-as-prompt', def: 'A designed test with pasted results: expected vs actual, asks for a causal explanation (TEST A… RESPONSE… RESULT).' },
  { id: 'handoff', label: 'Cross-conversation handoff', def: 'Pastes another model/session’s reasoning to redirect this one ("consider this conversation I had with Claude…").' },
  { id: 'critique-tool', label: 'Visual critique → tool', def: 'Numbered visual critique that escalates from "fix this pixel" to "build the tool that tunes this class of problem".' },
  { id: 'positioning', label: 'Positioning correction', def: 'Re-steers the agent’s mental model / corrects a recurring misframe, then dumps unstructured direction.' },
  { id: 'options', label: 'Options menu', def: 'Enumerated choices the agent is told to pick from ("pick one, all, or none"): GAME UI: 1… 2… 3….' },
  { id: 'spec', label: 'Spec deliverable', def: 'A mini-RFC: named deliverable file, flags, ordered algorithm, edge cases. Almost no ambiguity.' },
  { id: 'console-debug', label: 'Console-paste debug', def: 'Raw pasted terminal/test output is the prompt, with a short observation ("all tests passed; now some fail").' },
  { id: 'feasibility', label: 'Feasibility discussion', def: 'Thinking aloud about future capability; opens a design space and explicitly defers the decision. No deliverable demanded.' },
  { id: 'tool-genesis', label: 'Tool-genesis', def: 'Describes a tool that doesn’t exist yet — a vague wish for new capability ("I’d like more visibility in real time…").' },
];

const VALID = new Set([...ARCHETYPES.map((a) => a.id), 'default']);

function systemPrompt() {
  const list = ARCHETYPES.map((a, i) => `${i + 1}. ${a.id} — ${a.label}: ${a.def}`).join('\n');
  return `You classify a single developer prompt (a turn a developer typed to a terminal coding agent) into exactly one archetype. The archetypes:

${list}

If the prompt fits none of these, is a bare acknowledgement, or is banal connective tissue, use "default". Pick the SINGLE best archetype. Judge by what the prompt is *doing* (its structure and intent), not just its topic — e.g. enumerated choices → options; pasted terminal output + an observation → console-debug; a named deliverable file + an algorithm → spec. Give a confidence and a one-line rationale.`;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    archetype: { type: 'string', enum: [...ARCHETYPES.map((a) => a.id), 'default'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    rationale: { type: 'string' },
  },
  required: ['archetype', 'confidence', 'rationale'],
};

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let _client = null;
async function client() {
  if (_client) return _client;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  _client = new Anthropic();
  return _client;
}

// Compact, cheap outcome signals that help the half-structural archetypes
// (#4/#8/#9/#10) without sending the whole transcript.
function signalLine(u) {
  const o = (u && u.outcomes) || {};
  const bits = [];
  if (o.filesChanged) bits.push(`${o.filesChanged} files`);
  if (o.commandsRun) bits.push(`${o.commandsRun} cmds`);
  if (o.commitsProduced) bits.push(`${o.commitsProduced} commits`);
  if (u.attachments && u.attachments.length) bits.push(`${u.attachments.length} images`);
  if (u.before) bits.push('mid-conversation');
  bits.push(`${u.chars || (u.prompt || '').length} chars`);
  return bits.join(', ');
}

// Classify one prompt. Returns { archetype, confidence, rationale } or null on
// no-key / error (classification is best-effort and must never break ingest).
export async function classifyUnit(u) {
  if (!hasKey()) return null;
  const prompt = String(u.prompt || '').slice(0, 4000); // cap input tokens
  if (!prompt.trim()) return null;
  try {
    const c = await client();
    const res = await c.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: `signals: ${signalLine(u)}\n\nprompt:\n${prompt}` }],
    });
    if (res.stop_reason === 'refusal') return null;
    const text = (res.content.find((b) => b.type === 'text') || {}).text || '';
    const out = JSON.parse(text);
    if (!VALID.has(out.archetype)) return null;
    return { archetype: out.archetype, confidence: out.confidence, rationale: out.rationale };
  } catch {
    return null;
  }
}

// Classify a set of prompt-units, skipping ones already classified (incremental)
// and the banal (acks/noise/too-short never hit the model). Returns a map
// cardId -> result, merged over `existing`. Sequential with a tiny concurrency
// cap so an ingest with many new prompts doesn't fan out unboundedly.
export async function classifyUnits(units, existing = {}, { concurrency = 4 } = {}) {
  const out = { ...existing };
  if (!hasKey()) return out;
  const todo = (units || []).filter(
    (u) => u.cardId && !out[u.cardId] && !u.isAck && !u.isNoise && (u.chars || 0) >= 20,
  );
  for (let i = 0; i < todo.length; i += concurrency) {
    const batch = todo.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((u) => classifyUnit(u)));
    batch.forEach((u, j) => {
      if (results[j]) out[u.cardId] = results[j];
    });
  }
  return out;
}
