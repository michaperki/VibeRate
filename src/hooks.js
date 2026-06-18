import fs from 'node:fs';
import path from 'node:path';

// Real-time agent activity, captured from Claude Code (or compatible) hooks rather
// than the session log. CC flushes its `.jsonl` transcript in chunks, so parsing it
// lags ~20–30s; hooks fire the instant each event happens, in the harness, at zero
// model/token cost. We append a compact event per hook to `<cwd>/.vbrt/stream.jsonl`,
// which `vbrt watch` fingerprints + ships, so the dashboard ticker reflects "what is
// the agent doing right now" — working/idle, the current action, and context load —
// within the watch push cadence instead of the transcript flush cadence.
//
// Wire-compatible event shape (one JSON object per line):
//   { t, sid?, ev: 'prompt'|'tool'|'idle'|'start', phase?, name?, cat?, target?,
//     ctx?, ctxPct?, model? }
// `sid` is the agent's session id (CC's session_id), so consumers can group a
// repo's merged stream back into one panel per concurrently-running agent.

const STREAM_REL = path.join('.vbrt', 'stream.jsonl');
const MAX_LINES = 400; // trim the sidecar so it never grows unbounded
const KEEP_LINES = 200;

// Same coarse buckets as the viewer's classifyTool / storage's classifyToolName, so
// the live ticker reads identically to the convo chips and the log-derived ticker.
const VERB = { edit: 'editing', read: 'reading', cmd: 'running', search: 'searching', web: 'fetching', other: 'using' };
function classify(name) {
  const n = String(name || '').toLowerCase();
  if (/write|edit|apply_patch|create|notebook|patch|update_plan/.test(n)) return 'edit';
  if (/read|cat|view|open/.test(n)) return 'read';
  if (/bash|exec|shell|command|run|terminal/.test(n)) return 'cmd';
  if (/grep|glob|search|find|^ls|list/.test(n)) return 'search';
  if (/fetch|web|browser|http/.test(n)) return 'web';
  return 'other';
}

// Short human label for a tool action — file touched, command run, or query — from
// CC's tool_input (object) shape. Mirrors storage.toolLabel but for the hook payload.
function labelFor(cat, input, cwd) {
  const inp = input || {};
  const rel = (f) => {
    const s = String(f).replace(/\\/g, '/');
    const c = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
    return c && s.toLowerCase().startsWith(c.toLowerCase() + '/') ? s.slice(c.length + 1) : s;
  };
  if (typeof inp === 'object') {
    const file = inp.file_path || inp.path || inp.notebook_path;
    if (file) return rel(file);
    if (cat === 'cmd' && inp.command) {
      return String(inp.command).replace(/\s+/g, ' ').trim().replace(/^cd\s+\S+\s+(?:&&\s+|;\s+)?(?=\S)/, '').slice(0, 80);
    }
    if (cat === 'search' && (inp.pattern || inp.query)) return String(inp.pattern || inp.query).slice(0, 60);
    if (inp.description) return String(inp.description).slice(0, 60);
  }
  return '';
}

// Known context windows — the 200k standard, or 1M for the [1m] beta models.
function windowOf(model) {
  const m = String(model || '').toLowerCase();
  return m.includes('[1m]') || m.includes('-1m') ? 1_000_000 : 200_000;
}

// Best-effort current context load from the transcript tail: the last assistant
// message's usage block (input + cache read + cache creation = what the model saw).
// Reads only the file's tail so it stays cheap even on long sessions. Returns null
// when the transcript is missing/absent or carries no usage yet.
function contextFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const stat = fs.statSync(transcriptPath);
    const start = Math.max(0, stat.size - 96 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line || line[0] !== '{') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      const u = msg && msg.usage;
      if (!u) continue;
      const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (!ctx) continue;
      const model = msg.model || null;
      const win = windowOf(model);
      return { ctx, ctxPct: Math.min(100, Math.round((ctx / win) * 100)), model, output: u.output_tokens || 0 };
    }
  } catch { /* unreadable tail — skip usage */ }
  return null;
}

// Map a raw CC hook payload to our compact stream event. Returns null for events we
// don't surface, so the caller can no-op cleanly.
function eventFromPayload(p) {
  const name = p.hook_event_name || p.hookEventName || '';
  const t = Date.now();
  const sid = p.session_id || p.sessionId || null;
  const ctx = contextFromTranscript(p.transcript_path || p.transcriptPath);
  const base = { ...(sid ? { sid } : {}), ...(ctx ? { ctx: ctx.ctx, ctxPct: ctx.ctxPct, model: ctx.model } : {}) };
  switch (name) {
    case 'UserPromptSubmit':
      return { t, ev: 'prompt', ...base };
    case 'PreToolUse': {
      const cat = classify(p.tool_name);
      return { t, ev: 'tool', phase: 'start', name: p.tool_name || '', cat, verb: VERB[cat], target: labelFor(cat, p.tool_input, p.cwd), ...base };
    }
    case 'PostToolUse': {
      const cat = classify(p.tool_name);
      return { t, ev: 'tool', phase: 'end', name: p.tool_name || '', cat, verb: VERB[cat], target: labelFor(cat, p.tool_input, p.cwd), ...base };
    }
    case 'Stop':
    case 'SubagentStop':
      return { t, ev: 'idle', ...base };
    case 'SessionStart':
      return { t, ev: 'start', ...base };
    case 'SessionEnd':
      // Graceful close (/exit, clear, logout). Unlike Stop (end-of-turn → idle),
      // this means the session is *gone* — the live dashboard auto-hides it. Hard
      // kills (Ctrl-C, terminal close, restart) never fire this, so those linger
      // until the user dismisses the panel by hand.
      return { t, ev: 'end', ...base };
    case 'Notification':
      return { t, ev: 'note', text: String(p.message || '').slice(0, 120), ...base };
    default:
      return null;
  }
}

function streamPath(cwd) {
  return path.join(cwd || process.cwd(), STREAM_REL);
}

// Append an event, trimming the sidecar back to KEEP_LINES once it passes MAX_LINES so
// it never grows without bound. All best-effort: a hook must never fail the agent.
function appendEvent(cwd, event) {
  const file = streamPath(cwd);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
    let lineCount = 0;
    try { lineCount = fs.readFileSync(file, 'utf8').split('\n').length; } catch { /* ignore */ }
    if (lineCount > MAX_LINES) {
      const kept = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-KEEP_LINES);
      fs.writeFileSync(file, kept.join('\n') + '\n');
    }
  } catch { /* best-effort */ }
}

// `vbrt hook`: read a hook payload from stdin (JSON), record it, exit 0 no matter
// what. Reads cwd from the payload (the agent's repo), falling back to process.cwd().
export async function recordHookFromStdin() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch { /* no stdin */ }
  let payload = {};
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
  const cwd = payload.cwd || process.cwd();
  const event = eventFromPayload(payload);
  if (event) appendEvent(cwd, event);
}

// Read the last `n` stream events (newest last) for inclusion in a watch bundle.
export function readStream(cwd, n = 40) {
  try {
    const lines = fs.readFileSync(streamPath(cwd), 'utf8').trim().split('\n').filter(Boolean);
    const events = [];
    for (const line of lines.slice(-n)) {
      try { events.push(JSON.parse(line)); } catch { /* skip */ }
    }
    return events;
  } catch {
    return [];
  }
}

// A cheap fingerprint (mtime:size) so `vbrt watch` can detect a hook append and push.
export function streamSignature(cwd) {
  try {
    const st = fs.statSync(streamPath(cwd));
    return `stream:${Math.floor(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'stream:0';
  }
}
