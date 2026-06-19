import fs from 'node:fs';
import readline from 'node:readline';

// A normalized session shape used by both the CLI and the viewer:
// {
//   id, source: 'claude'|'codex', cwd, title, startedAt, endedAt,
//   messageCount, file, messages: [{ role, kind, text?, name?, input?, ts }]
// }

function truncate(s, n = 100) {
  if (!s) return '';
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat;
}

// The most recent user-typed message — what the sidebar previews so a convo reads
// as "where it is now", not its opening prompt ("read SEED.md").
function lastUserOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'user' && String(m.text || '').trim()) return m.text;
  }
  return null;
}

// Known model context windows. Default to the 200k standard; the [1m] beta
// models advertise a million-token window. Used to turn raw token counts into a
// "how full was the window" percentage (the prompt-time "dumb zone" signal).
function contextWindow(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('[1m]') || m.includes('-1m')) return 1_000_000;
  return 200_000;
}

// Normalize a Claude assistant message's `usage` block into the context size the
// model actually saw on that turn: fresh input + cache reads + cache creation.
// (output_tokens is the reply, not context.) Returns null when usage is absent.
function claudeUsage(msg) {
  const u = msg && msg.usage;
  if (!u) return null;
  const input = u.input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  const context = input + cacheRead + cacheCreate;
  return {
    input,
    cacheRead,
    cacheCreate,
    output: u.output_tokens || 0,
    context,
    model: msg.model || null,
    window: contextWindow(msg.model),
  };
}

async function* readLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      /* skip malformed lines */
    }
  }
}

// ---------- Claude Code ----------

// Images a user pasted into a prompt (screenshots, design refs) — the artifact
// that often lives *inside* the prompt, not after it. Claude logs them as `image`
// blocks in two shapes: {source:{data, media_type}} or {file:{base64}}. We keep
// them as data URLs bound to the prompt so the reader can show what the user was
// looking at. Capped so a pasted screenshot can't bloat the bundle.
const MAX_IMG_B64 = 1_500_000; // ~1.1 MB decoded; skip anything larger
const MAX_IMGS_PER_MSG = 6;

function imageDataUrl(block) {
  const src = block.source || block.file || {};
  const data = src.data ?? src.base64;
  if (typeof data !== 'string' || !data) return null;
  if (data.startsWith('data:')) return data.length > MAX_IMG_B64 ? null : data;
  if (data.length > MAX_IMG_B64) return null;
  const mt = src.media_type || src.mediaType || 'image/png';
  return `data:${mt};base64,${data}`;
}

function claudeContentToParts(content, role) {
  const parts = [];
  if (typeof content === 'string') {
    if (content.trim()) parts.push({ role, kind: 'text', text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  const images = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text && block.text.trim()) parts.push({ role, kind: 'text', text: block.text });
        break;
      case 'thinking':
        if (block.thinking && block.thinking.trim())
          parts.push({ role, kind: 'thinking', text: block.thinking });
        break;
      case 'tool_use':
        parts.push({ role, kind: 'tool_use', name: block.name, input: block.input });
        break;
      case 'tool_result': {
        let text = block.content;
        const imgs = [];
        if (Array.isArray(text)) {
          for (const c of text) {
            if (c && c.type === 'image' && imgs.length < MAX_IMGS_PER_MSG) {
              const url = imageDataUrl(c);
              if (url) imgs.push(url);
            }
          }
          text = text.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
        }
        const part = { role, kind: 'tool_result', text: typeof text === 'string' ? text : JSON.stringify(text) };
        // Screenshots / images the agent's tools returned during the turn — the
        // images that actually populate real Claude logs (pasted prompt images are
        // rare; tool-result images are common). Bound to the prompt unit downstream.
        if (imgs.length) part.images = imgs;
        parts.push(part);
        break;
      }
      case 'image': {
        if (images.length < MAX_IMGS_PER_MSG) {
          const url = imageDataUrl(block);
          if (url) images.push(url);
        }
        break;
      }
      default:
        break;
    }
  }
  // Bind pasted images to the message's text part (an image-only paste still
  // forms a turn via an empty text part so the prompt unit exists).
  if (images.length) {
    const host = parts.find((p) => p.kind === 'text' && p.role === role);
    if (host) host.images = images;
    else parts.push({ role, kind: 'text', text: '', images });
  }
  return parts;
}

export async function parseClaude(file) {
  const messages = [];
  let cwd = null;
  let startedAt = null;
  let endedAt = null;
  let firstUserText = null;

  for await (const obj of readLines(file)) {
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const msg = obj.message;
    if (!msg) continue;
    const role = msg.role || obj.type;
    const ts = obj.timestamp || null;
    if (ts) {
      if (!startedAt) startedAt = ts;
      endedAt = ts;
    }
    const usage = role === 'assistant' ? claudeUsage(msg) : null;
    for (const part of claudeContentToParts(msg.content, role)) {
      part.ts = ts;
      if (usage) part.usage = usage;
      if (part.kind === 'text' && role === 'user' && !firstUserText) {
        firstUserText = part.text;
      }
      messages.push(part);
    }
  }

  return {
    id: file.split(/[/\\]/).pop().replace(/\.jsonl$/, ''),
    source: 'claude',
    cwd,
    title: truncate(firstUserText) || '(no prompt)',
    lastUserText: truncate(lastUserOf(messages), 160) || null,
    startedAt,
    endedAt,
    messageCount: messages.length,
    file,
    messages,
  };
}

// Fast metadata pass for the picker (no full parse).
export async function peekClaude(file) {
  let cwd = null;
  let startedAt = null;
  let firstUserText = null;
  let userTurns = 0;
  for await (const obj of readLines(file)) {
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.timestamp && !startedAt) startedAt = obj.timestamp;
    if (obj.type === 'user' && obj.message) {
      const c = obj.message.content;
      let text = null;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        const t = c.find((b) => b && b.type === 'text');
        if (t) text = t.text;
      }
      // Skip tool-result-only user turns (no actual typed text).
      if (text && text.trim()) {
        userTurns++;
        if (!firstUserText) firstUserText = text;
      }
    }
  }
  return { cwd, startedAt, userTurns, preview: truncate(firstUserText) };
}

// ---------- Codex ----------

function codexPushOutput(parts, output) {
  let text = output;
  if (typeof output !== 'string') {
    try {
      const o = JSON.parse(output);
      text = o.output || JSON.stringify(o);
    } catch {
      text = String(output);
    }
  }
  parts.push({ role: 'tool', kind: 'tool_result', text });
}

const CODEX_VERB = { edit: 'editing', read: 'reading', cmd: 'running', search: 'searching', web: 'fetching', other: 'using' };
function codexToolAction(name, input) {
  const n = String(name || '').toLowerCase();
  const cat = /write|edit|apply_patch|create|notebook|patch|update_plan/.test(n) ? 'edit'
    : /read|cat|view|open/.test(n) ? 'read'
      : /bash|exec|shell|command|run|terminal/.test(n) ? 'cmd'
        : /grep|glob|search|find|^ls|list/.test(n) ? 'search'
          : /fetch|web|browser|http/.test(n) ? 'web' : 'other';
  let label = name || cat;
  if (input && typeof input === 'object') {
    label = input.file_path || input.path || input.notebook_path || input.description || input.pattern || input.query || label;
    if (cat === 'cmd' && (input.command || input.cmd)) label = String(input.command || input.cmd).replace(/\s+/g, ' ').slice(0, 80);
  } else if (typeof input === 'string') {
    // Codex custom tools wrap their real arguments in JavaScript. Pull the first
    // command/path-like value when possible; otherwise keep a short useful tail.
    const cmd = input.match(/\b(?:cmd|command|path)\s*:\s*["'`]([^"'`]{1,160})/);
    label = (cmd ? cmd[1] : input.replace(/\s+/g, ' ').trim()).slice(0, 80) || label;
  }
  return { cat, verb: CODEX_VERB[cat], label: String(label).slice(0, 100) };
}

export async function parseCodex(file) {
  const messages = [];
  let cwd = null;
  let id = null;
  let startedAt = null;
  let endedAt = null;
  let firstUserText = null;
  // Codex writes task lifecycle + token counts directly into each rollout. Keep a
  // compact latest-state snapshot so consumers can render it live without hooks.
  let live = { state: 'idle', action: null, ctx: null, ctxPct: null, model: null, ts: null };

  for await (const obj of readLines(file)) {
    const ts = obj.timestamp || null;
    const p = obj.payload || {};
    if (obj.type === 'session_meta') {
      cwd = p.cwd || cwd;
      id = p.id || id;
      startedAt = p.timestamp || ts || startedAt;
      continue;
    }
    if (ts) endedAt = ts;
    // Reasoning and tool-output records are also proof the active turn moved,
    // even when they don't change the user-facing action label.
    if (ts && live.state === 'working') live.ts = ts;

    if (obj.type === 'turn_context') live.model = p.model || live.model;

    if (obj.type === 'event_msg') {
      if (p.type === 'task_started') {
        live = { ...live, state: 'working', action: null, ts };
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        live = { ...live, state: 'idle', action: null, ts };
      } else if (p.type === 'token_count') {
        const info = p.info || {};
        const usage = info.last_token_usage || {};
        const window = info.model_context_window || null;
        const ctx = usage.input_tokens ?? usage.total_tokens ?? null;
        live = { ...live, ctx, ctxPct: ctx != null && window ? Math.min(100, Math.round((ctx / window) * 100)) : live.ctxPct, ts: ts || live.ts };
      } else if (p.type === 'user_message') {
        const text = p.message || '';
        if (text.trim() && !text.startsWith('<')) {
          if (!firstUserText) firstUserText = text;
          messages.push({ role: 'user', kind: 'text', text, ts });
          live = { ...live, state: 'working', action: { cat: 'other', verb: 'reading', label: 'your prompt' }, ts };
        }
      } else if (p.type === 'agent_message') {
        if (p.message && p.message.trim())
          messages.push({ role: 'assistant', kind: 'text', text: p.message, ts });
      } else if (p.type === 'agent_reasoning') {
        if (p.text && p.text.trim())
          messages.push({ role: 'assistant', kind: 'thinking', text: p.text, ts });
      }
    } else if (obj.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.arguments ?? p.input;
        try {
          if (typeof input === 'string') input = JSON.parse(input);
        } catch {
          /* keep as string */
        }
        messages.push({ role: 'assistant', kind: 'tool_use', name: p.name, input, ts });
        live = { ...live, state: 'working', action: codexToolAction(p.name, input), ts };
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        codexPushOutput(messages, p.output);
        messages[messages.length - 1].ts = ts;
      }
    }
  }

  return {
    id: id || file.split(/[/\\]/).pop().replace(/\.jsonl$/, ''),
    source: 'codex',
    cwd,
    title: truncate(firstUserText) || '(no prompt)',
    lastUserText: truncate(lastUserOf(messages), 160) || null,
    startedAt,
    endedAt,
    messageCount: messages.length,
    file,
    messages,
    live,
  };
}

export async function peekCodex(file) {
  let cwd = null;
  let startedAt = null;
  let firstUserText = null;
  let userTurns = 0;
  for await (const obj of readLines(file)) {
    const p = obj.payload || {};
    if (obj.type === 'session_meta') {
      cwd = p.cwd || cwd;
      startedAt = p.timestamp || obj.timestamp || startedAt;
    } else if (obj.type === 'event_msg' && p.type === 'user_message') {
      const text = p.message || '';
      if (text.trim() && !text.startsWith('<')) {
        userTurns++;
        if (!firstUserText) firstUserText = text;
      }
    }
  }
  return { cwd, startedAt, userTurns, preview: truncate(firstUserText) };
}
