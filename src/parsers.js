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

function claudeContentToParts(content, role) {
  const parts = [];
  if (typeof content === 'string') {
    if (content.trim()) parts.push({ role, kind: 'text', text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
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
        if (Array.isArray(text)) {
          text = text.map((c) => (typeof c === 'string' ? c : c.text || '')).join('\n');
        }
        parts.push({ role, kind: 'tool_result', text: typeof text === 'string' ? text : JSON.stringify(text) });
        break;
      }
      default:
        break;
    }
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
    for (const part of claudeContentToParts(msg.content, role)) {
      part.ts = ts;
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

export async function parseCodex(file) {
  const messages = [];
  let cwd = null;
  let id = null;
  let startedAt = null;
  let endedAt = null;
  let firstUserText = null;

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

    if (obj.type === 'event_msg') {
      if (p.type === 'user_message') {
        const text = p.message || '';
        if (text.trim() && !text.startsWith('<')) {
          if (!firstUserText) firstUserText = text;
          messages.push({ role: 'user', kind: 'text', text, ts });
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
    startedAt,
    endedAt,
    messageCount: messages.length,
    file,
    messages,
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
