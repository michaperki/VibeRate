// VibeRate's MCP `ask` tool — the B2 inline picker (PLAN_AGENT_RUNTIME.md).
//
// The built-in AskUserQuestion is un-answerable headless (it auto-denies even
// with stdin open and emits no can_use_tool). So instead we give the driven
// agent OUR own MCP tool: a `tools/call` blocks until the server returns, which
// lets us fan the question to the Drive UI, wait for the click, and hand the
// answer back as the tool result — the agent continues the SAME turn.
//
// This is a standalone stdio MCP server that `claude` launches as a child (via
// the per-turn --mcp-config that agent.js writes). It speaks the minimal MCP
// JSON-RPC by hand (no SDK — keeps the repo's lean dependency footprint) and,
// on an `ask` call, POSTs the questions to the VibeRate server on loopback and
// long-polls for the answer.
//
//   usage: node src/mcpAsk.js <driveSessionId> <baseUrl>
//
// Verified end-to-end in a spike (claude 2.1.183): tool discovered + callable,
// and a 35s human-scale answer delay round-trips when MCP_TOOL_TIMEOUT is
// generous and the tool is allowlisted via --allowedTools.

import process from 'node:process';
import http from 'node:http';

const SESSION_ID = process.argv[2];
const BASE_URL = process.argv[3];

const log = (...a) => process.stderr.write('[mcpAsk] ' + a.join(' ') + '\n');

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// The tool the agent sees. Schema mirrors the built-in AskUserQuestion so the
// model fills it out the same way it already knows how to.
const ASK_TOOL = {
  name: 'ask',
  description:
    'Ask the user one or more questions and wait for their answer. Use this ' +
    'whenever you need a decision, preference, or clarification from the user. ' +
    'A picker appears in their UI and your call returns once they respond.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'One or more questions to put to the user.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question text.' },
            header: { type: 'string', description: 'A short (<=12 char) label/chip for the question.' },
            multiSelect: { type: 'boolean', description: 'Allow selecting multiple options.' },
            options: {
              type: 'array',
              description: 'The choices. The user can also answer with free text.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
};

// POST the questions to the VibeRate server and resolve with its JSON answer.
// The server holds the response open until the user answers (or it times out
// and returns a "no answer" payload), so this promise is the human round-trip.
function postAsk(questions) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL('/api/agent/internal/ask', BASE_URL);
    } catch (e) {
      return reject(e);
    }
    const body = JSON.stringify({ sessionId: SESSION_ID, questions });
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('bad answer payload: ' + (e && e.message)));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Render the server's answer into text for the model. `selections` is aligned
// to the questions: each carries the chosen option label(s) and/or free text.
function formatAnswer(answer) {
  const sels = (answer && answer.selections) || [];
  if (answer && answer.timedOut) {
    return 'The user did not answer in time. Proceed using your best judgment.';
  }
  if (!sels.length) return 'The user dismissed the question without choosing.';
  return sels
    .map((s) => {
      const label = s.header || s.question || 'answer';
      const parts = [];
      // Keep picked options and free-text distinct so the agent doesn't read a
      // typed note as if it were another option label.
      if ((s.selectedLabels || []).length) parts.push(s.selectedLabels.join(', '));
      if (s.customText) parts.push(`free-text note: "${s.customText}"`);
      return `${label}: ${parts.length ? parts.join('; ') : '(no selection)'}`;
    })
    .join('\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'viberate', version: '0.1.0' },
      },
    });
    return;
  }
  // Notifications carry no id and get no response.
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [ASK_TOOL] } });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== 'ask') {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } });
      return;
    }
    const questions = (params.arguments && params.arguments.questions) || [];
    try {
      const answer = await postAsk(questions);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: formatAnswer(answer) }] } });
    } catch (e) {
      log('ask failed:', e && e.message);
      // Surface as a tool error (is_error) rather than a protocol error so the
      // agent can read it and carry on instead of the turn falling over.
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'Could not reach the user: ' + (e && e.message) }], isError: true },
      });
    }
    return;
  }
  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
log(`up for session ${SESSION_ID} → ${BASE_URL}`);
