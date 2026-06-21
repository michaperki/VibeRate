const el = (sel) => document.querySelector(sel);

const state = {
  project: null,
  projectData: null,
  projectMemory: null,
  context: null,
  session: null,
  activity: { ok: false, byId: {} },
  git: { ok: false, commits: [] },
  docs: { ok: false, files: [] },
  docTab: null,
  docOpen: false, // doc reader overlay shown for the selected node
  docGraph: null,
  live: false, // "follow" mode: poll for new snapshots and animate the diff in
  _livePoll: null,
  _liveStamp: null, // last-seen project updatedAt
  _liveLastUpdate: null, // when the last live change landed (for the readout)
  _liveFlash: null, // node names changed since the last snapshot (flash them)
  _streamIn: null, // node names newly added this live update (fade them in)
  _liveSeenConvos: null, // id → userCount, to detect new/grown convos on a live update
  _liveSeenCommits: null, // commit hashes seen, to detect new commits
  _liveFreshConvos: null, // convos new/grown this update (highlight in the ribbon)
  _liveFreshCommits: null, // commits new this update
  _readerFresh: null, // ordinals of new reader cards on a live session update
  _unitsSig: null, // signature of the open session's prompt units (skip no-op refreshes)
  docHistory: null, // { capturedAt, docHistory: { path: [{hash,t,status,content}] } }
  timeTravel: false, // brain time-travel mode active
  ttIndex: 0, // selected commit index within the brain-history timeline
  ttFocus: null, // doc path whose diff is shown in the panel
  docLayout: 'web', // 'web' | 'tree' | 'recent'
  sourceFilter: 'all',
  colorById: {},
  selectedConvo: null,
  brush: null,
  turnAnchors: [],
  currentTurn: 0,
  token: null, // hosted dashboard: owner token, sent as Bearer on API calls
  railMode: 'prompts',
  promptUnits: [],
  ticker: null, // live agent ticker: { sessionId, items:[{cat,verb,label,ts}] }
  _liveSeenPrompts: null,
  _liveFreshPrompts: null,
  _pendingTurn: null,
  // Drive — the live agent runtime, ported in from the old standalone /drive page.
  driveable: null, // null = unprobed, false = unavailable/forbidden, true = usable
  driveDefaultCwd: null, // health.defaultCwd — prefill for a new session's cwd
  driveBin: null, // health.bin — the claude binary the host will spawn
  drive: null, // active driven session: { id, status, claudeSessionId, cwd, es }
  driveProject: null, // slug whose workspace the current/next driven session runs in
  _driveOpen: false, // the Drive view owns #conversation (suppress timeline re-renders)
  _driveLive: { text: null, thinking: null }, // streaming partial bubbles being filled
  _drivePoll: null, // setTimeout handle while polling a workspace clone
  // Option B (DRIVE_CONVO_RECONCILIATION.md): the live driven turn shown in the rail
  // as a provisional card that "cools" into the real parsed unit once ingest lands.
  driveProvisional: null, // { project, sessionId, prompt, status } | null
  _driveCoolPoll: null, // setTimeout handle awaiting ingest after a turn's `result`
  // The durable handle to a driven session — survives navigating away (and a page
  // reload, via localStorage). Distinct from state.drive, which is the *live view
  // binding* (SSE) that only exists while the Drive view is open. Keeping this lets
  // the rail + project bar offer "return to Drive" instead of stranding a session
  // that's still running server-side. { id, project, claudeSessionId, cwd, status }.
  driveActive: null,
};

// ---------- helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

function fmtTime(iso) {
  if (!iso) return '';
  return iso.slice(11, 16);
}

// "1 msg" / "2 msgs" — count + correctly-pluralized word. `plw` returns just the
// word (for when the number is rendered separately, e.g. bolded).
function plw(n, word, suffix = 's') {
  return word + (n === 1 ? '' : suffix);
}
function plural(n, word, suffix = 's') {
  return `${n} ${plw(n, word, suffix)}`;
}

// Last couple of path segments of a cwd — a compact differentiator for projects
// that share a display name (e.g. .../documents/dev/viberate).
function pathTail(cwd, n = 2) {
  const parts = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.slice(-n).join('/') || String(cwd || '');
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return `${h}h ${rem}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

async function api(path) {
  const headers = state.token ? { authorization: `Bearer ${state.token}` } : {};
  const res = await fetch(path, { headers });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const headers = { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) };
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

// Drive (agent runtime) calls. Unlike api()/apiPost(), these surface the route's
// `{ error }` body — the control plane returns human messages we show in a banner.
async function driveApi(path, opts) {
  const headers = { ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) };
  if (opts && opts.body) headers['content-type'] = 'application/json';
  const res = await fetch('/api/agent' + path, opts ? { ...opts, headers } : { headers });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}
const drivePost = (path, body) => driveApi(path, { method: 'POST', body: JSON.stringify(body || {}) });

// Probe the runtime once. Success → the host can spawn agents for this caller
// (loopback locally, or an admin-allowlisted account hosted) and we light up the
// Drive entry point. A 403/failure leaves driveable=false (read-only dashboard).
async function ensureDriveProbe() {
  if (state.driveable !== null) return state.driveable;
  try {
    const h = await driveApi('/health');
    state.driveable = !!h.ok;
    state.driveDefaultCwd = h.defaultCwd || null;
    state.driveBin = h.bin || 'claude';
  } catch {
    state.driveable = false;
  }
  return state.driveable;
}

// Light markdown: fenced code blocks, inline code, bold. Newlines via CSS.
function formatText(raw) {
  const parts = String(raw ?? '').split('```');
  let html = '';
  parts.forEach((seg, i) => {
    if (i % 2 === 1) {
      const body = seg.replace(/^[^\n]*\n/, (m) => (/\s/.test(m.trim()) ? m : '')); // drop lang line
      html += `<pre class="code">${esc(body.replace(/^[a-zA-Z0-9_+-]*\n/, ''))}</pre>`;
    } else {
      let t = esc(seg);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html += t;
    }
  });
  return html;
}

// Compact Markdown → HTML for the centerpiece docs (headers, lists, code
// fences, blockquotes, hr, inline code/bold/italic/links).
function inlineMd(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, url) => `<a href="${esc(url)}" target="_blank" rel="noopener">${txt}</a>`);
  return t;
}

function renderMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let inList = null;
  const closeList = () => {
    if (inList) {
      html += `</${inList}>`;
      inList = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (/^```/.test(t)) {
      closeList();
      let code = '';
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code += lines[i++] + '\n';
      i++;
      html += `<pre class="md-code">${esc(code.replace(/\n$/, ''))}</pre>`;
      continue;
    }
    if (t === '') {
      closeList();
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      closeList();
      html += '<hr/>';
      i++;
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      html += `<h${lvl} class="md-h md-h${lvl}">${inlineMd(h[2])}</h${lvl}>`;
      i++;
      continue;
    }
    if (/^>\s?/.test(t)) {
      closeList();
      html += `<blockquote>${inlineMd(t.replace(/^>\s?/, ''))}</blockquote>`;
      i++;
      continue;
    }
    // GitHub-style table: a row of `| … |` followed by a `| --- | :--: |` delimiter.
    if (t.includes('|') && i + 1 < lines.length
      && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(lines[i + 1].trim())) {
      closeList();
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const heads = cells(t);
      i += 2; // consume header + delimiter
      let rows = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows += `<tr>${cells(lines[i]).map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`;
        i++;
      }
      html += `<table class="md-table"><thead><tr>${heads.map((h) => `<th>${inlineMd(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (inList !== 'ul') {
        closeList();
        html += '<ul>';
        inList = 'ul';
      }
      html += `<li>${inlineMd(ul[1])}</li>`;
      i++;
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inList !== 'ol') {
        closeList();
        html += '<ol>';
        inList = 'ol';
      }
      html += `<li>${inlineMd(ol[1])}</li>`;
      i++;
      continue;
    }
    closeList();
    let para = t;
    i++;
    while (i < lines.length) {
      const n = lines[i];
      const nt = n.trim();
      if (
        nt === '' ||
        /^```/.test(nt) ||
        /^(#{1,6})\s/.test(nt) ||
        /^>\s?/.test(nt) ||
        /^\s*[-*+]\s+/.test(n) ||
        /^\s*\d+[.)]\s+/.test(n) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nt)
      )
        break;
      para += ' ' + nt;
      i++;
    }
    html += `<p>${inlineMd(para)}</p>`;
  }
  closeList();
  return html;
}

// ---------- tool classification / stats ----------

function classifyTool(name) {
  const n = (name || '').toLowerCase();
  if (/write|edit|apply_patch|create|notebook|patch|update_plan/.test(n)) return 'edit';
  if (/read|cat|view|open/.test(n)) return 'read';
  if (/bash|exec|shell|command|run|terminal/.test(n)) return 'cmd';
  if (/grep|glob|search|find|^ls|list/.test(n)) return 'search';
  if (/fetch|web|browser|http/.test(n)) return 'web';
  return 'other';
}

function toolFile(m) {
  const inp = m.input;
  if (inp && typeof inp === 'object') return inp.file_path || inp.path || inp.notebook_path || null;
  if (typeof inp === 'string') {
    const match = inp.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/);
    if (match) return match[1].trim();
  }
  return null;
}

const CAT_LABEL = { edit: 'edit', read: 'read', cmd: 'cmd', search: 'search', web: 'web', other: 'other' };

function statsFor(messages) {
  const cats = { edit: 0, read: 0, cmd: 0, search: 0, web: 0, other: 0 };
  const files = new Set();
  let toolCalls = 0;
  let thinking = 0;
  let userTurns = 0;
  let assistantTexts = 0;
  for (const m of messages) {
    if (m.kind === 'tool_use') {
      toolCalls++;
      cats[classifyTool(m.name)]++;
      const f = toolFile(m);
      if (f) files.add(f);
    } else if (m.kind === 'thinking') {
      thinking++;
    } else if (m.kind === 'text' && m.role === 'user') {
      userTurns++;
    } else if (m.kind === 'text' && m.role === 'assistant') {
      assistantTexts++;
    }
  }
  return { cats, files, toolCalls, thinking, userTurns, assistantTexts };
}

function statChips(s) {
  const order = ['edit', 'cmd', 'read', 'search', 'web', 'other'];
  const chips = order
    .filter((c) => s.cats[c] > 0)
    .map((c) => `<span class="chip ${c}">${s.cats[c]} ${CAT_LABEL[c]}</span>`)
    .join('');
  return chips;
}

// ---------- conversation termination ----------

// Transcript flush lags ~20–30s, so allow a longer quiet window than the real-time hook
// ticker (2 min) before we stop calling a followed session "working".
const LIVE_WORKING_TTL_MS = 3 * 60 * 1000;

// `live` = we're following this session as it streams. While live, a trailing tool
// call or assistant *narration* doesn't mean the convo ended — a working agent
// emits text between tool batches, which used to flip the marker to "End of
// conversation" prematurely (then more turns kept arriving). So while live those
// both read as "Agent working…".
// BUT liveness is never asserted: a hard exit (Ctrl-C, terminal close, crash) fires no
// hook and stops the transcript, yet a still-running `vbrt watch` keeps the project in
// the streaming window — which used to pin this to "Agent working…" forever. So "working"
// also requires *recent* activity (`lastActivityTs`); past the TTL we show the real end
// state. See LIVE_ORCHESTRATION §8a.
function endState(messages, live = false, lastActivityTs = 0) {
  const fresh = live && lastActivityTs && (Date.now() - lastActivityTs) < LIVE_WORKING_TTL_MS;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'user') {
      return { cls: 'pending', text: 'Agent response pending' };
    }
    if (m.kind === 'tool_use' || m.kind === 'tool_result') {
      return fresh
        ? { cls: 'working', text: 'Agent working…' }
        : { cls: 'paused', text: 'Stopped while agent work was in progress' };
    }
    if (m.kind === 'text' && m.role === 'assistant') {
      return fresh
        ? { cls: 'working', text: 'Agent working…' }
        : { cls: 'ok', text: '■ End of conversation' };
    }
  }
  return { cls: 'ok', text: '■ End of conversation' };
}

// The end-marker shows a pulsing work-dot whenever the agent isn't done.
const endWorking = (cls) => cls === 'pending' || cls === 'working';

// ---------- projects + sessions ----------

async function loadProjects() {
  const projects = await api('/api/projects');
  const box = el('#projects');
  if (projects.length === 0) {
    box.innerHTML = '<div class="empty">No projects yet.<br>Run <code>vbrt add</code> in a folder.</div>';
    return;
  }
  const dash = document.body.classList.contains('workspace');
  // Disambiguate identically-named projects (a real navigation hazard) with a
  // path tail — only shown when a name actually collides.
  const nameCounts = {};
  for (const p of projects) {
    const k = (p.name || p.slug).toLowerCase();
    nameCounts[k] = (nameCounts[k] || 0) + 1;
  }
  box.innerHTML = projects
    .map((p) => {
      const vis = p.visibility || 'public';
      const pill = dash ? `<span class="vis ${vis}">${vis === 'public' ? '🌐 public' : '🔒 private'}</span>` : '';
      const toggle = dash
        ? `<button class="vis-toggle" data-slug="${esc(p.slug)}" data-to="${vis === 'public' ? 'private' : 'public'}">${vis === 'public' ? 'unpublish' : 'publish'}</button>`
        : '';
      const collides = nameCounts[(p.name || p.slug).toLowerCase()] > 1;
      const disambig = collides
        ? `<div class="proj-path" title="${esc(p.cwd || '')}">${esc(pathTail(p.cwd))}${p.updatedAt ? ` · ${fmtAgo(Date.parse(p.updatedAt))}` : ''}</div>`
        : '';
      return `
      <div class="proj" data-slug="${esc(p.slug)}">
        <div class="name">${esc(p.name || p.slug)}</div>
        ${disambig}
        <div class="meta">${plural(p.sessions.length, 'session')} ${pill}</div>
        ${toggle}
      </div>`;
    })
    .join('');
  box.querySelectorAll('.proj').forEach((node) => {
    node.addEventListener('click', (e) => {
      if (e.target.closest('.vis-toggle')) return; // let the toggle handle its own click
      selectProject(node.dataset.slug);
    });
  });
  box.querySelectorAll('.vis-toggle').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await apiPost(`/api/projects/${btn.dataset.slug}/visibility`, { visibility: btn.dataset.to });
        await loadProjects();
      } catch {
        btn.disabled = false;
      }
    });
  });
}

// --- Tier 1: Workspace / Home (agent memory + projects rollup) ---
const MEM_BADGE = { index: 'index', user: 'you', feedback: 'feedback', project: 'project', reference: 'ref', note: 'note', distilled: 'distilled' };

function showHome() {
  document.body.classList.remove('view-project');
  document.body.classList.add('view-home');
  document.querySelectorAll('.proj.active').forEach((n) => n.classList.remove('active'));
  stopLive();
  // Suspend (don't kill) any open Drive: leaving the project keeps the session
  // resumable — the durable handle persists, so returning to the project re-offers it.
  suspendDrive();
  state.driveProject = null;
  state.driveProvisional = null;
  state.project = null;
  state.session = null;
}

function showProject() {
  document.body.classList.remove('view-home');
  document.body.classList.add('view-project');
}

function homeHeader() {
  return `
    <header class="home-head">
      <h1>Workspace</h1>
      <p class="dim-note">What every agent already knows, in every session — your global instruction files.
        Per-repo memory lives on each repo's page.
        <span class="mem-load always">● always in context</span></p>
    </header>`;
}

async function loadContext() {
  try {
    state.context = await api('/api/context');
  } catch {
    state.context = { global: { claude: [], codex: [] }, directories: [] };
  }
  renderHome();
}

function renderHome() {
  return renderContextHome();
}

// Cold-start context view: what each agent preloads when launched in a directory.
function renderContextHome() {
  const c = state.context;
  if (!c) {
    el('#home').innerHTML = `<div class="home-wrap">${homeHeader()}<div class="empty">Loading…</div></div>`;
    return;
  }
  el('#home').innerHTML = `
    <div class="home-wrap">
      ${homeHeader()}
      ${renderGlobalSection()}
    </div>`;
}

// ----- Global memory (Tier-1): decomposed into atomic facts, shown as rows -----
function agentBadges(a) {
  return (a.agents || []).map((ag) => `<span class="mem-src s-${ag}">${ag}</span>`).join('');
}

function bySection(atoms) {
  const m = new Map();
  for (const a of atoms) {
    const s = a.section || 'General';
    if (!m.has(s)) m.set(s, []);
    m.get(s).push(a);
  }
  return [...m.entries()];
}

function atomRows(atoms) {
  return bySection(atoms)
    .map(
      ([section, items]) => `
      <div class="atom-group">
        <div class="atom-section">${esc(section)}</div>
        ${items
          .map(
            (a) => `<div class="atom-row">
              <span class="atom-text">${esc(a.text)}</span>
              <span class="atom-badges">${agentBadges(a)}</span>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');
}

// Global memory has two buckets, split by *loading*, not scope:
//   • always — the CLAUDE.md/AGENTS.md instruction facts (in context every session)
//   • recall — cross-project memory notes (only their MEMORY.md index line preloads;
//              the bodies surface on relevance). Click one to read it.
function renderGlobalSection() {
  const g = (state.context && state.context.global) || {};
  const atoms = g.atoms || [];

  const always = atoms.length
    ? atomRows(atoms)
    : '<div class="empty">Nothing always-loaded — add facts to <code>~/.claude/CLAUDE.md</code> / <code>~/.codex/AGENTS.md</code>.</div>';

  return `
    <section class="home-section">
      <h2>🌐 Global <span class="dim-note">loaded in every session, any directory</span></h2>

      <div class="ctx-bucket">
        <div class="ctx-bucket-head"><span class="mem-load always">● always in context</span><span class="dim-note">instruction files — ${atoms.length} fact${atoms.length === 1 ? '' : 's'}</span></div>
        ${always}
      </div>
    </section>`;
}

function fmtBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

function openMemo(file) {
  if (!file) return;
  const prev = el('.memo-modal');
  if (prev) prev.remove();
  const wrap = document.createElement('div');
  wrap.className = 'memo-modal';
  wrap.innerHTML = `
    <div class="memo-backdrop"></div>
    <div class="memo-panel">
      <div class="memo-head">
        <span class="mem-src s-${file.source === 'codex' ? 'codex' : 'claude'}">${esc(file.source || 'claude')}</span>
        <span class="mem-type t-${esc(file.type)}">${esc(MEM_BADGE[file.type] || file.type)}</span>
        <span class="memo-title">${esc(file.title)}</span>
        <button class="memo-close" title="Close">✕</button>
      </div>
      <div class="docview markdown">${renderMarkdown(file.body || '')}</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.memo-backdrop').onclick = close;
  wrap.querySelector('.memo-close').onclick = close;
}

async function selectProject(slug) {
  showProject();
  const switchingProject = state.project && state.project !== slug;
  if (switchingProject) stopLive(); // don't keep polling a project you've navigated away from
  if (switchingProject && state._driveOpen) suspendDrive(); // keep the session resumable
  state.project = slug;
  state.session = null;
  document.querySelectorAll('.proj').forEach((n) =>
    n.classList.toggle('active', n.dataset.slug === slug),
  );
  state.projectData = await api(`/api/projects/${slug}`);
  if (slug !== state.project) return;
  state._liveStamp = state.projectData.updatedAt || null;
  state.promptUnits = [];
  state._liveSeenPrompts = null;

  // Stable color per thread (golden-angle hues stay distinct across hundreds of
  // threads). Shared by the timeline and the session-list swatches; derived from
  // the manifest, so it's ready for the early shell render below.
  state.colorById = {};
  [...state.projectData.sessions]
    .filter((s) => s.startedAt)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .forEach((s, i) => {
      state.colorById[s.id] = colorForIndex(i);
    });

  // Reset per-project view state to empty defaults up front, so the early shell
  // render (and any failed fetch leg below) is consistent.
  state.activity = { ok: false, byId: {} };
  state.git = { ok: false, commits: [] };
  state.docs = { ok: false, files: [] };
  state.docTab = null;
  state.docGraph = null;
  state.docHistory = null;
  state.timeTravel = false;
  state.ttIndex = 0;
  state.ttFocus = null;
  state.projectMemory = null;
  if (state._ttPlay) { clearInterval(state._ttPlay); state._ttPlay = null; }

  // Paint the shell (sidebar session list) immediately from the manifest, so the
  // project feels open right away instead of after the whole fetch batch. The list
  // degrades gracefully without activity (falls back to manifest message counts).
  renderSessionList();

  // Probe the agent runtime once; if usable, re-paint the rail so the Drive entry
  // point appears. Fire-and-forget — the dashboard is fully functional without it.
  ensureDriveProbe().then((ok) => { if (ok && slug === state.project) renderSessionList(); });

  // Fetch the rest in parallel — was a 6-request serial waterfall, so the open
  // cost the *sum* of six round-trips; now it's the *max*. Commit whatever returns;
  // a failed/absent leg keeps its empty default (mirrors refreshLive's batch).
  const [act, units, gg, d, h, m] = await Promise.all([
    api(`/api/projects/${slug}/activity`).catch(() => null),
    api(`/api/projects/${slug}/prompts`).catch(() => null),
    api(`/api/projects/${slug}/git`).catch(() => null),
    api(`/api/projects/${slug}/docs`).catch(() => null),
    api(`/api/projects/${slug}/dochistory`).catch(() => null),
    api(`/api/projects/${slug}/memory`).catch(() => null),
  ]);
  if (slug !== state.project) return; // navigated away mid-flight

  if (act) state.activity = { ok: true, byId: Object.fromEntries(act.map((a) => [a.id, a])) };
  if (units) state.promptUnits = units;
  if (gg && Array.isArray(gg.commits)) state.git = { ok: true, commits: gg.commits };
  if (d && Array.isArray(d.docs) && d.docs.length) {
    state.docs = { ok: true, files: d.docs };
    state.docTab = d.docs[0].name;
  }
  if (h && h.docHistory) state.docHistory = h.docHistory;
  if (m) state.projectMemory = m;

  // Build the graph now that docs + history are known: include archived docs
  // (deleted in history) as nodes so they can ghost in during time travel. They're
  // laid out with the rest but hidden outside time-travel mode.
  if (state.docs.ok) state.docGraph = buildDocGraph([...state.docs.files, ...archivedPseudoFiles()]);

  state._brainEntrance = true; // play the "just changed" entrance once, on open
  // Auto-follow a project that's actively streaming — whether that's a local
  // `vbrt watch` pushing deltas or a hosted Drive turn ingesting on turn-end — so
  // you don't have to hand-click "Follow". The server's freshness window decides;
  // follow quietly goes idle on its own once updates stop.
  if (state.projectData.streaming && !state.live) startLive();
  renderSessionList();
  renderTimeline();
}

// ---------- streaming (live) ----------

// Build the graph for a refreshed snapshot but PIN existing nodes to their
// current positions, so a live update doesn't reshuffle the whole brain — only
// new docs need placing. (Foundation; the smooth structural tween is a follow-up.)
function buildDocGraphPinned(files, oldGraph) {
  const g = buildDocGraph(files);
  if (oldGraph) {
    const old = new Map(oldGraph.nodes.map((n) => [n.name, n]));
    g.nodes.forEach((n) => { const o = old.get(n.name); if (o) { n.x = o.x; n.y = o.y; } });
  }
  return g;
}

function startLive() {
  if (state._livePoll) return;
  state.live = true;
  // Baseline what's already here so the first live update only highlights what's
  // genuinely new/grown since you went live (not the whole existing timeline).
  const sessions = timelineSessions();
  state._liveSeenConvos = new Map(sessions.map((s) => [s.id, s.userCount]));
  state._liveSeenCommits = new Set(windowCommits(sessions).map((c) => c.hash));
  state._liveSeenPrompts = new Set((state.promptUnits || []).map((u) => u.cardId || u.id));
  state._livePoll = setInterval(pollLive, 2000);
  fetchTicker(); // populate the agent ticker immediately, don't wait for the next push
}

// Compute which convos are new/grown and which commits are new since the last
// live update, for the ribbon's "just arrived" highlight; advance the seen state.
function computeFreshActivity(sessions) {
  const seenC = state._liveSeenConvos || new Map();
  const freshConvos = new Set();
  for (const s of sessions) {
    const prev = seenC.get(s.id);
    if (prev === undefined || s.userCount > prev) freshConvos.add(s.id);
    seenC.set(s.id, s.userCount);
  }
  const seenK = state._liveSeenCommits || new Set();
  const freshCommits = new Set();
  for (const c of windowCommits(sessions)) {
    if (!seenK.has(c.hash)) { freshCommits.add(c.hash); seenK.add(c.hash); }
  }
  state._liveSeenConvos = seenC;
  state._liveSeenCommits = seenK;
  state._liveFreshConvos = freshConvos;
  state._liveFreshCommits = freshCommits;
}

function computeFreshPrompts(units) {
  const seen = state._liveSeenPrompts || new Set();
  const fresh = new Set();
  for (const u of units || []) {
    const id = u.cardId || u.id;
    if (!id) continue;
    if (!seen.has(id)) fresh.add(id);
    seen.add(id);
  }
  state._liveSeenPrompts = seen;
  state._liveFreshPrompts = fresh;
}

// New commits since the last live snapshot, without advancing the seen-set (that's
// computeFreshActivity's job) — a peek for the orchestration digest.
function freshCommitCount() {
  const seen = state._liveSeenCommits;
  if (!seen) return 0;
  return windowCommits(timelineSessions()).filter((c) => !seen.has(c.hash)).length;
}

// Orchestration: roll up everything one snapshot changed into a single line, so a
// live event reads as one concerted acknowledgment (a transient pulse on the
// Activity header) rather than each surface — rail, timeline, brain, ticker —
// flashing on its own. One-shot: consumed by overviewHeader on the next render.
function noteLiveEvent({ brain = 0, prompts = 0, commits = 0 } = {}) {
  const bits = [];
  if (prompts) bits.push(`+${prompts} ${plw(prompts, 'message')}`);
  if (brain) bits.push(`${brain} 🧠 ${plw(brain, 'brain edit')}`);
  if (commits) bits.push(`+${commits} ${plw(commits, 'commit')}`);
  state._liveDigest = bits.length ? bits.join(' · ') : null;
}

function stopLive() {
  state.live = false;
  if (state._livePoll) { clearInterval(state._livePoll); state._livePoll = null; }
  state.ticker = null; // a stale "what's the agent doing" line is worse than none
  updateTicker();
}

// ---------- live agent ticker ----------

// One-shot ticker fetch (used when going live so the readout appears without waiting
// for the next push). The poll path refreshes it as part of refreshLive's batch.
async function fetchTicker() {
  const slug = state.project;
  if (!slug) return;
  try { const t = await api(`/api/projects/${slug}/ticker`); if (slug === state.project) { state.ticker = t; updateTicker(); } } catch { /* ignore */ }
}

const fmtTokens = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

// The agent ticker under the brain (live only). The server merges Claude hook
// agents with Codex rollout agents; old servers still degrade to one log-tail row.
function tickerHtml() {
  const t = state.ticker;
  if (!state.live || !t) return '';
  const renderAgent = (agent) => {
    const items = (agent.items || []).slice(-4);
    if (agent.live) {
      const live = agent.live;
      const working = live.state === 'working';
      const ended = live.state === 'ended';
      // We never *assert* liveness — stale hook/log events downgrade to idle.
      const word = working ? 'working' : ended ? 'closed' : 'idle';
      const lastMove = live.ts ? fmtAgo(live.ts) : null;
      const now = working
        ? (live.action
          ? `${esc(live.action.verb || 'using')} <span class="tick-label">${esc(live.action.label || live.action.cat || '')}</span>`
          : 'thinking…')
        : ended
          ? `session closed${lastMove ? ` · ${lastMove}` : ''}`
          : live.stale
            ? `no activity${lastMove ? ` · last move ${lastMove}` : ''}`
            : 'waiting for you';
      const ctx = live.ctx != null
        ? `<span class="tick-ctx" title="context window used — ${live.ctx.toLocaleString()} tokens${live.model ? ' · ' + esc(live.model) : ''}">◔ ${fmtTokens(live.ctx)}${live.ctxPct != null ? ` · ${live.ctxPct}%` : ''}</span>`
        : '';
      const trail = items.length
        ? `<span class="tick-trail">${items.map((it) => `<span class="tick-dot ${esc(it.cat || 'other')}" title="${esc((it.verb || '') + ' ' + (it.label || ''))}"></span>`).join('')}</span>`
        : '';
      return `<div class="brain-ticker ${working ? 'working' : 'idle'}">
        <span class="tick-tag ${esc(agent.source || '')}">${esc(agent.source || 'agent')}</span>
        <span class="tick-state"><span class="tick-pulse"></span>${word}</span>
        <span class="tick-now">${now}</span>
        ${trail}${ctx}
      </div>`;
    }
    if (!items.length) return '';
    const row = items
      .map((it, i) => {
        const cur = i === items.length - 1 ? ' cur' : '';
        return `<span class="tick-item${cur}"><span class="tick-dot ${esc(it.cat || 'other')}"></span><span class="tick-verb">${esc(it.verb || 'using')}</span> <span class="tick-label">${esc(it.label || '')}</span></span>`;
      })
      .join('<span class="tick-sep">›</span>');
    return `<div class="brain-ticker"><span class="tick-tag ${esc(agent.source || '')}">${esc(agent.source || 'agent')}</span>${row}</div>`;
  };
  const agents = t.agents && t.agents.length ? t.agents : [t];
  const rows = agents.map(renderAgent).filter(Boolean).join('');
  return rows ? `<div class="brain-tickers" id="brainTicker">${rows}</div>` : '';
}

// Patch the ticker in place (the brain itself updates in-place on live ticks, so the
// centerpiece isn't rebuilt — we surgically replace just the ticker node).
function updateTicker() {
  const card = el('#conversation .dash-card.centerpiece');
  if (!card) return;
  const existing = card.querySelector('.brain-tickers, .brain-ticker');
  const html = tickerHtml();
  if (!html) { if (existing) existing.remove(); return; }
  const tmp = document.createElement('template');
  tmp.innerHTML = html.trim();
  const node = tmp.content.firstElementChild;
  if (existing) existing.replaceWith(node);
  else {
    const wrap = card.querySelector('.brain-wrap');
    if (wrap) wrap.insertAdjacentElement('afterend', node);
  }
}

// Cheap change-detection: poll the project manifest and compare updatedAt.
async function pollLive() {
  const slug = state.project;
  if (!slug) return;
  try {
    const p = await api(`/api/projects/${slug}`);
    if (slug !== state.project) return;
    const stamp = p.updatedAt || '';
    if (stamp && stamp !== state._liveStamp) {
      state._liveStamp = stamp;
      state._liveLastUpdate = Date.now();
      await (state.session ? refreshLiveSession() : refreshLive());
    }
  } catch { /* transient; try again next tick */ }
  updateLiveReadout(); // keep the "updated Ns ago" ticking even with no change
}

// Show "· updated Ns ago" next to the Live toggle, without re-rendering.
function updateLiveReadout() {
  const ago = el('#conversation .live-ago');
  if (!ago) return;
  if (!state.live || !state._liveLastUpdate) { ago.textContent = ''; return; }
  const secs = Math.round((Date.now() - state._liveLastUpdate) / 1000);
  ago.textContent = ` · updated ${secs < 60 ? `${secs}s` : fmtAgo(state._liveLastUpdate).replace(' ago', '')} ago`;
}

// A new snapshot arrived: refetch the brain-relevant data, diff which docs
// changed, rebuild the graph with pinned positions, and re-render — flashing the
// changed nodes so the eye catches what just happened.
async function refreshLive() {
  const slug = state.project;
  // Diff against the *visible* brain (archived/graveyarded nodes excluded) so a doc
  // that crosses 100% this snapshot — and thus newly archives — reads as "gone" and
  // animates out to the graveyard, instead of silently staying put (just filled to
  // 100%) until the next full render.
  const before = new Map((state.docGraph?.nodes || []).filter((n) => !n.archived).map((n) => [n.name, (n.content || '').length + ':' + (n.content || '').slice(0, 64)]));
  // Fetch the live-relevant data in parallel (was 6 serial round-trips) and only
  // commit the results that came back — a failed leg keeps the prior value.
  const [proj, act, units, gg, h, d, tk] = await Promise.all([
    api(`/api/projects/${slug}`).catch(() => null),
    api(`/api/projects/${slug}/activity`).catch(() => null),
    api(`/api/projects/${slug}/prompts`).catch(() => null),
    api(`/api/projects/${slug}/git`).catch(() => null),
    api(`/api/projects/${slug}/dochistory`).catch(() => null),
    api(`/api/projects/${slug}/docs`).catch(() => null),
    api(`/api/projects/${slug}/ticker`).catch(() => null),
  ]);
  if (slug !== state.project) return;
  if (proj) state.projectData = proj;
  if (act) state.activity = { ok: true, byId: Object.fromEntries(act.map((a) => [a.id, a])) };
  if (units) { computeFreshPrompts(units); state.promptUnits = units; }
  if (gg && Array.isArray(gg.commits)) state.git = { ok: true, commits: gg.commits };
  if (h) state.docHistory = h.docHistory || null;
  if (d && Array.isArray(d.docs)) state.docs = { ok: true, files: d.docs };
  if (tk) state.ticker = tk;

  const newGraph = state.docs.ok ? buildDocGraphPinned([...state.docs.files, ...archivedPseudoFiles()], state.docGraph) : state.docGraph;
  // Visible nodes only — mirrors `before`. A node that auto-retired (hit 100%) is
  // still in newGraph.nodes but archived, so it drops out here and the diff below
  // treats it as removed → it streams out to the graveyard.
  const visNodes = (newGraph?.nodes || []).filter((n) => !n.archived);
  // changed = nodes new or with different content since the last snapshot
  const flash = new Map();
  for (const n of visNodes) {
    const sig = (n.content || '').length + ':' + (n.content || '').slice(0, 64);
    if (!before.has(n.name)) flash.set(n.name, 'added');
    else if (before.get(n.name) !== sig) flash.set(n.name, 'modified');
  }
  state.docGraph = newGraph;
  state.docTab = state.docGraph && state.docGraph.nodes[0] ? (state.docGraph.nodes.find((n) => n.name === state.docTab)?.name || state.docGraph.nodes[0].name) : null;
  state.colorById = state.colorById || {};
  // Capture the digest before the renders below consume the per-surface fresh sets.
  noteLiveEvent({
    prompts: (state._liveFreshPrompts && state._liveFreshPrompts.size) || 0,
    brain: flash.size,
    commits: freshCommitCount(),
  });
  renderSessionList();
  if (state.session) return; // reading a session — data's updated; render on return

  // Smooth path: node set unchanged (the common case — a doc's content changed)
  // → animate the brain in place (rings fill, changed nodes glow) + refresh the
  // activity card, no rebuild.
  const svg = el('#conversation .brain');
  const sameSet = svg && before.size === visNodes.length && visNodes.every((n) => before.has(n.name));
  if (sameSet) {
    streamUpdateBrain(newGraph, new Set(flash.keys()));
    refreshActivityCard();
    refreshBrainHistoryCard(); // keep Brain history in sync without rebuilding the brain
    updateTicker();
    return;
  }
  // Add/remove path: fade out gone nodes, then re-render with the new ones fading
  // in (positions are pinned, so existing nodes don't jump).
  state._liveFlash = flash.size ? flash : null;
  const newNames = new Set(visNodes.map((n) => n.name));
  state._streamIn = visNodes.some((n) => !before.has(n.name))
    ? new Set(visNodes.filter((n) => !before.has(n.name)).map((n) => n.name))
    : null;
  const removed = svg ? [...before.keys()].filter((name) => !newNames.has(name)) : [];
  if (removed.length) {
    for (const name of removed) {
      const gEl = svg.querySelector(`.gnode[data-doc="${CSS.escape(name)}"]`);
      if (gEl) gEl.classList.add('stream-out');
    }
    setTimeout(() => { if (state.project && !state.session) renderTimeline(); }, 450);
  } else {
    renderTimeline();
  }
}

// In-place brain update for a live snapshot: fill/empty completion rings smoothly
// (CSS transitions) and drop a "just changed" glow on changed nodes — no rebuild,
// so transitions actually run. (The same in-place pattern as time-travel scrubbing.)
function streamUpdateBrain(newGraph, changedNames) {
  const svg = el('#conversation .brain');
  if (!svg) return;
  const byName = new Map(newGraph.nodes.map((n) => [n.name, n]));
  svg.querySelectorAll('.gnode').forEach((gEl) => {
    const n = byName.get(gEl.dataset.doc);
    if (!n) return;
    const prog = gEl.querySelector('.gcprog');
    const track = gEl.querySelector('.gctrack');
    if (prog && track) {
      if (n.completion) {
        const C = 2 * Math.PI * (n.r + 5);
        prog.setAttribute('stroke-dasharray', `${((n.completion.pct / 100) * C).toFixed(1)} ${C.toFixed(1)}`);
        prog.setAttribute('stroke', pctColor(n.completion.pct));
        prog.style.opacity = track.style.opacity = '';
      } else {
        prog.style.opacity = track.style.opacity = '0';
      }
    }
    if (changedNames.has(n.name)) {
      const ex = gEl.querySelector('.live-glow');
      if (ex) ex.remove();
      const glow = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      glow.setAttribute('class', 'live-glow');
      glow.setAttribute('cx', n.x.toFixed(1));
      glow.setAttribute('cy', n.y.toFixed(1));
      glow.setAttribute('r', (n.r + 9).toFixed(1));
      glow.setAttribute('fill', n.color);
      gEl.insertBefore(glow, gEl.firstChild); // behind the node; animation plays on insert
    }
  });
}

// Re-render just the Activity card in place (so new prompts/commits show) without
// touching the brain SVG — keeps the brain's in-flight transitions intact.
function refreshActivityCard() {
  const card = el('#conversation .dash-card.activity');
  if (!card) return;
  const sessions = timelineSessions();
  computeFreshActivity(sessions); // mark just-arrived convos/commits for the ribbon
  card.outerHTML = `
      <section class="dash-card activity">
        <div class="dash-head"><span>📊 Activity</span></div>
        ${overviewHeader(sessions)}
        ${renderRibbon(sessions)}
        ${ribbonLegend()}
      </section>`;
  state._liveFreshConvos = state._liveFreshCommits = null; // consumed
  wireActivity();
}

// Surgically refresh the 🧠 Brain history card on a live tick. The smooth path
// updates the brain SVG in place and must NOT call renderTimeline (that rebuilds
// the brain and kills the in-place animation) — but Brain history only renders
// inside renderTimeline, so without this it goes stale until you navigate away and
// back (the reported bug). Handles all three transitions: replace, remove (history
// emptied), and insert (the first brain-doc commit of a live session, when the card
// didn't exist yet). Re-wires the doc chips so they still open the reader.
function refreshBrainHistoryCard() {
  const conv = el('#conversation');
  if (!conv) return;
  const existing = conv.querySelector('.brain-history');
  const html = renderBrainHistory().trim();
  if (!html) { if (existing) existing.remove(); return; }
  const tmp = document.createElement('template');
  tmp.innerHTML = html;
  const node = tmp.content.firstElementChild;
  if (!node) return;
  if (existing) existing.replaceWith(node);
  else {
    // No card yet — drop it in right after the brain centerpiece (its place in
    // renderTimeline), falling back to after the activity card.
    const anchor = conv.querySelector('.centerpiece') || conv.querySelector('.dash-card.activity');
    if (anchor) anchor.insertAdjacentElement('afterend', node);
    else return;
  }
  node.querySelectorAll('[data-bh-doc]').forEach((n) => (n.onclick = () => {
    const dn = currentDocNode(n.dataset.bhDoc);
    if (dn) openDocLightbox(dn);
  }));
}

// Map of node→change to flash on the next render (one-shot, from a live update).
function liveFlashMap() {
  const m = state._liveFlash || new Map();
  state._liveFlash = null; // consume
  return m;
}

function filteredSessions() {
  let all = state.projectData.sessions;
  if (state.sourceFilter !== 'all') all = all.filter((s) => s.source === state.sourceFilter);
  if (state.brush) {
    const [a, b] = state.brush;
    all = all.filter((s) => {
      const t = new Date(s.startedAt).getTime();
      return t >= a && t <= b;
    });
  }
  return all;
}

function filteredPromptUnits() {
  let all = state.promptUnits || [];
  if (state.sourceFilter !== 'all') all = all.filter((u) => u.source === state.sourceFilter);
  if (state.brush) {
    const [a, b] = state.brush;
    all = all.filter((u) => {
      const t = Date.parse(u.ts || u.sessionStartedAt || '');
      return !Number.isNaN(t) && t >= a && t <= b;
    });
  }
  return all;
}

function renderSessionList() {
  const p = state.projectData;
  const counts = p.sessions.reduce((a, s) => ((a[s.source] = (a[s.source] || 0) + 1), a), {});
  const chip = (key, label) =>
    `<button class="filter ${state.sourceFilter === key ? 'on' : ''}" data-f="${key}">${label}</button>`;

  // A session you never typed into (no user messages) is noise — fold these out
  // of the main list into a collapsed group of thin rows so they don't eat space.
  const userCountOf = (s) => { const act = state.activity.byId[s.id]; return act ? act.userCount : s.messageCount; };
  const all = filteredSessions();
  const substantive = all.filter((s) => userCountOf(s) > 0);
  const empties = all.filter((s) => userCountOf(s) === 0);
  // Most-recently-active convo on top — so a convo bumps up as you send into it.
  substantive.sort((a, b) => new Date(b.endedAt || 0) - new Date(a.endedAt || 0));
  // "Just grew" detection for the live flash: compare to the pre-update baseline
  // (advanced later in this same refresh by computeFreshActivity), so it's correct
  // at render time and never false-flashes on a plain re-render.
  const seen = state._liveSeenConvos;
  const isFresh = (s) => state.live && seen && seen.get(s.id) !== undefined && userCountOf(s) > seen.get(s.id);

  const card = (s) => {
    const dur = s.startedAt && s.endedAt ? fmtDuration(new Date(s.endedAt) - new Date(s.startedAt)) : '';
    const act = state.activity.byId[s.id];
    const label = act ? plural(act.userCount, 'msg') : `${s.messageCount} total`;
    const color = (state.colorById || {})[s.id] || 'var(--muted)';
    const dl = act ? diffLabel(act) : '';
    // Preview the most-recent prompt ("where the convo is now"), not its opener.
    const preview = esc(s.lastUserText || s.title || '');
    const driving = railIsLive(s.id);
    return `
        <div class="sess${isFresh(s) ? ' fresh' : ''} ${state.session === s.id ? 'active' : ''}${state.selectedConvo === s.id ? ' hl' : ''}${driving ? ' driving' : ''}" data-id="${esc(s.id)}">
          <div class="row">
            <span class="sw" style="background:${color}"></span>
            <span class="badge ${s.source}">${s.source}</span>
            ${driving ? '<span class="meta drive-live"><span class="live-dot"></span>live</span>' : `<span class="meta">${fmtDate(s.endedAt || s.startedAt)}</span>`}
          </div>
          <div class="sess-preview">${preview}</div>
          <div class="meta">${label}${dur ? ` · ${dur}` : ''}${dl ? ` · ${dl}` : ''}</div>
        </div>`;
  };
  const thinRow = (s) => `
        <div class="sess empty-sess ${state.session === s.id ? 'active' : ''}" data-id="${esc(s.id)}">
          <span class="badge ${s.source}">${s.source}</span>
          <span class="es-title">${esc(s.title)}</span>
          <span class="es-date">${fmtDate(s.startedAt)}</span>
        </div>`;
  const list = substantive.map(card).join('');
  const emptyBlock = empties.length
    ? `<details class="empty-sessions"><summary>${plural(empties.length, 'empty session')} · you sent no prompt</summary>${empties.map(thinRow).join('')}</details>`
    : '';

  const brushBanner = state.brush
    ? `<div class="list-brush">▭ filtered to ${fmtShort(state.brush[0])} – ${fmtShort(state.brush[1])} <button class="linkbtn" data-list-brush-clear>clear</button></div>`
    : '';
  const railToggle = `
    <div class="rail-toggle" role="tablist" aria-label="Project rail">
      <button class="${state.railMode === 'prompts' ? 'on' : ''}" data-rail="prompts">Prompts</button>
      <button class="${state.railMode === 'sessions' ? 'on' : ''}" data-rail="sessions">Sessions</button>
    </div>`;
  const hostedProject = document.body.classList.contains('hosted');
  // The Drive entry point — only when the runtime probed usable for this caller.
  // If a session for this project is still alive (we navigated away without ending
  // it), the entry point becomes "Return to Drive" and reconnects to that session.
  const hasActiveDrive = state.driveActive && state.driveActive.project === state.project && !state._driveOpen;
  const driveBtn = !state.driveable ? ''
    : hasActiveDrive
      ? `<button class="pb-drive resume" data-drive-resume title="Return to your running agent session — it kept going while you were away">✦ Return to Drive</button>`
      : `<button class="pb-drive" data-drive-new title="Start a new agent session here — chat with Claude in the browser">✦ Drive</button>`;
  const projectBar = hostedProject ? '' : `
    <div class="project-bar">
      <button class="back-projects" data-back-projects title="Back to workspace">←</button>
      <div class="project-bar-title">
        <div class="pb-name">${esc(p.name || p.slug)}</div>
        <div class="pb-meta">${plural((state.promptUnits || []).length, 'prompt')} · ${plural(p.sessions.length, 'session')}</div>
      </div>
      ${driveBtn}
    </div>`;
  const paneTitle = hostedProject
    ? `<div class="pane-title">${esc(p.name || p.slug)} · ${plural((state.promptUnits || []).length, 'prompt')} · ${plural(p.sessions.length, 'session')}${driveBtn}</div>`
    : '';

  const promptRows = () => {
    const fresh = state._liveFreshPrompts || new Set();
    const units = filteredPromptUnits().filter((u) => !u.isNoise);
    const row = (u) => {
      const color = (state.colorById || {})[u.sessionId] || 'var(--muted)';
      const id = u.cardId || u.id;
      const active = state.session === u.sessionId && state.currentTurn === u.index ? ' active' : '';
      const driving = railIsLive(u.sessionId);
      return `<div class="prompt-row${fresh.has(id) ? ' fresh' : ''}${active}${driving ? ' driving' : ''}" data-session="${esc(u.sessionId)}" data-turn="${u.index}">
        <div class="row">
          <span class="sw" style="background:${color}"></span>
          <span class="badge ${esc(u.source)}">${esc(u.source)}</span>
          ${driving ? '<span class="meta drive-live"><span class="live-dot"></span>live</span>' : `<span class="meta">${fmtDate(u.ts || u.sessionStartedAt)}</span>`}
        </div>
        <div class="sess-preview">${esc(u.prompt || '')}</div>
        ${outcomeChips(u, { compact: true })}
      </div>`;
    };
    return units.length ? units.map(row).join('') : '<div class="empty">No prompts in this range.</div>';
  };

  el('#sessions').innerHTML = `
    ${projectBar}
    ${paneTitle}
    ${railToggle}
    <div class="filters">
      ${chip('all', `all ${p.sessions.length}`)}
      ${counts.claude ? chip('claude', `claude ${counts.claude}`) : ''}
      ${counts.codex ? chip('codex', `codex ${counts.codex}`) : ''}
    </div>
    <div class="list-legend"><span class="sw legend-rainbow"></span> a colour per session · <span class="badge claude">claude</span> / <span class="badge codex">codex</span> = agent</div>
    ${brushBanner}
    ${driveProvisionalRow()}
    ${state.railMode === 'prompts' ? promptRows() : `${list || (empties.length ? '' : '<div class="empty">No sessions in this range.</div>')}${emptyBlock}`}`;

  const back = el('#sessions').querySelector('[data-back-projects]');
  if (back) back.addEventListener('click', showHome);

  const driveNew = el('#sessions').querySelector('[data-drive-new]');
  if (driveNew) driveNew.addEventListener('click', () => openDriveForProject(state.project));
  const driveResume = el('#sessions').querySelector('[data-drive-resume]');
  if (driveResume) driveResume.addEventListener('click', () => resumeDrive(state.project));
  // The live driven turn's provisional card is a handle back into the session.
  const prov = el('#sessions').querySelector('.prompt-row.provisional');
  if (prov) prov.addEventListener('click', () => resumeDrive(state.project));

  const bc = el('#sessions').querySelector('[data-list-brush-clear]');
  if (bc) bc.addEventListener('click', () => {
    state.brush = null;
    renderSessionList();
    renderTimeline();
  });
  el('#sessions')
    .querySelectorAll('.filter')
    .forEach((b) => b.addEventListener('click', () => {
      state.sourceFilter = b.dataset.f;
      renderSessionList();
    }));
  el('#sessions')
    .querySelectorAll('[data-rail]')
    .forEach((b) => b.addEventListener('click', () => {
      state.railMode = b.dataset.rail;
      renderSessionList();
    }));
  el('#sessions')
    .querySelectorAll('.sess')
    .forEach((node) => node.addEventListener('click', () => {
      // The actively-driven convo returns to Drive; everything else opens the reader.
      if (isActiveDrive(node.dataset.id)) return resumeDrive(state.project);
      selectSession(state.project, node.dataset.id);
    }));
  el('#sessions')
    .querySelectorAll('.prompt-row:not(.provisional)')
    .forEach((node) => node.addEventListener('click', () => {
      if (isActiveDrive(node.dataset.session)) return resumeDrive(state.project);
      selectSession(state.project, node.dataset.session, Number(node.dataset.turn));
    }));
  state._liveFreshPrompts = null;
}

// Scroll the left session list to the convo picked from the timeline ribbon.
function scrollConvoIntoList(id) {
  const node = el('#sessions') && el('#sessions').querySelector(`.sess[data-id="${CSS.escape(id)}"]`);
  if (node) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- timeline (project overview) ----------

// Golden-angle hue spacing keeps colors distinguishable across many threads.
const colorForIndex = (i) => `hsl(${Math.round((i * 137.508) % 360)} 62% 62%)`;

// "5 files · +210/−45" — the agent's edit footprint for a conversation.
function diffLabel(s) {
  if (!s.fileCount && !s.added && !s.removed) return '';
  return `${s.fileCount} file${s.fileCount === 1 ? '' : 's'} · +${s.added}/−${s.removed}`;
}

const fmtShort = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtShortDT = (ms) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Sessions sorted by start, each assigned a stable thread color + its msgs.
function timelineSessions() {
  return state.projectData.sessions
    .filter((s) => s.startedAt)
    .map((s) => ({
      id: s.id,
      source: s.source,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      start: new Date(s.startedAt).getTime(),
      end: new Date(s.endedAt || s.startedAt).getTime(),
      msgs: state.activity.byId[s.id]?.msgs || [],
      userCount: state.activity.byId[s.id]?.userCount ?? s.messageCount,
      files: state.activity.byId[s.id]?.files || [],
      fileCount: state.activity.byId[s.id]?.fileCount || 0,
      added: state.activity.byId[s.id]?.added || 0,
      removed: state.activity.byId[s.id]?.removed || 0,
      color: (state.colorById || {})[s.id] || 'var(--muted)',
    }))
    .filter((s) => (s.userCount || 0) > 0) // drop conversations where you sent nothing
    .sort((a, b) => a.start - b.start);
}

function renderTimeline() {
  if (state._driveOpen) return; // Drive owns #conversation — don't repaint over it
  const sessions = timelineSessions();
  if (sessions.length === 0) {
    el('#conversation').innerHTML = '<div class="empty">No timestamped sessions.</div>';
    return;
  }
  const enriched = state.activity.ok;
  const tMin = Math.min(...sessions.map((s) => s.start));
  const tMax = Math.max(...sessions.map((s) => s.end));

  el('#conversation').innerHTML = `
    <div class="conv-toolbar dash-toolbar">
      <div class="conv-head">
        <h2>${esc(state.projectData.name)}</h2>
        <div class="meta">${plural(sessions.length, 'conversation')} · ${fmtShort(tMin)} → ${fmtShort(tMax)}${
          enriched ? '' : ' · <span class="warn-inline">restart <code>vbrt serve</code> for message data</span>'
        }</div>
      </div>
      <button class="live-toggle${state.live ? ' on' : ''}" data-live-toggle title="Follow this project — new commits, prompts &amp; brain edits animate in as they land (a local watch or a Drive turn)."><span class="live-dot"></span>${state.live ? 'Following' : 'Follow'}<span class="live-ago"></span></button>
    </div>
    <div class="dashboard">
      <section class="dash-card activity">
        <div class="dash-head"><span>📊 Activity</span></div>
        ${overviewHeader(sessions)}
        ${renderRibbon(sessions)}
        ${ribbonLegend()}
      </section>
      ${renderCenterpiece()}
      ${renderBrainHistory()}
      ${renderProjectMemory()}
    </div>`;

  el('#conversation')
    .querySelectorAll('[data-open]')
    .forEach((n) =>
      n.addEventListener('click', () => {
        if (n.dataset.open) selectSession(state.project, n.dataset.open);
      }),
    );
  el('#conversation')
    .querySelectorAll('[data-pmem]')
    .forEach((b) => (b.onclick = () => openMemo((state._projMem || [])[Number(b.dataset.pmem)])));
  // Brain-history doc → open that (still-existing) doc in the brain reader.
  el('#conversation')
    .querySelectorAll('[data-bh-doc]')
    .forEach((n) => (n.onclick = () => {
      const node = currentDocNode(n.dataset.bhDoc);
      if (node) openDocLightbox(node);
    }));
  wireDocTabs();
  wireActivity();
  const lt = el('#conversation [data-live-toggle]');
  if (lt) lt.onclick = () => { state.live ? stopLive() : startLive(); renderTimeline(); };
  state._brainEntrance = false; // consumed — don't replay on layout toggles / re-renders
  state._streamIn = null; // consumed — the new nodes have rendered with their fade-in
  liveBrain.attach(el('#conversation').querySelector('.centerpiece')); // start the live force-sim
}

// Tier-2: this repo's cold-start context — what an agent preloads when launched
// here (instruction files + memory index = always; memory notes = recall).
function renderProjectMemory() {
  const m = state.projectMemory;
  if (!m || !m.ok) return '';
  const preloaded = m.preloaded || [];
  const notes = m.notes || [];
  if (!preloaded.length && !notes.length && !m.index) return '';
  state._projMem = notes;

  const fileRow = (f) =>
    `<div class="atom-row"><span class="atom-text"><span class="mem-src s-${f.agent}">${f.agent}</span> <code>${esc(f.name)}</code></span>${f.bytes ? `<span class="ctx-bytes">${esc(fmtBytes(f.bytes))}</span>` : ''}</div>`;
  const idxRow = m.index
    ? `<div class="atom-row"><span class="atom-text"><span class="mem-src s-claude">claude</span> <code>MEMORY.md index</code></span></div>`
    : '';
  const alwaysBody =
    preloaded.length || m.index
      ? `<div class="atom-group">${preloaded.map(fileRow).join('')}${idxRow}</div>`
      : '<div class="ctx-empty">No instruction files — only the harness prompt preloads here.</div>';

  const recallBody = notes
    .map(
      (n, i) => `<div class="atom-row recall-row" data-pmem="${i}">
        <span class="atom-text">${esc(n.title)}${n.description ? ` <span class="recall-desc">— ${esc(n.description)}</span>` : ''}</span>
        <span class="atom-badges"><span class="mem-type t-${esc(n.type)}">${esc(n.type)}</span></span>
      </div>`,
    )
    .join('');

  return `
    <section class="dash-card">
      <div class="dash-head"><span>📥 Cold-start context</span><span class="dim-note">what an agent preloads in this repo</span></div>
      <div class="ctx-bucket">
        <div class="ctx-bucket-head"><span class="mem-load always">● always in context</span></div>
        ${alwaysBody}
      </div>
      ${
        notes.length
          ? `<div class="ctx-bucket"><div class="ctx-bucket-head"><span class="mem-load recall">○ recalled when relevant</span><span class="dim-note">${notes.length} note${notes.length === 1 ? '' : 's'}</span></div><div class="atom-group">${recallBody}</div></div>`
          : ''
      }
    </section>`;
}

// --- Brain history: the temporal companion to the brain graph — every commit
// that changed a brain doc, newest first, across the whole project (not the
// session window). Each row shows how each doc changed (added/modified/deleted).
// Clicking a doc that still exists opens it in the reader. ---
function renderBrainHistory() {
  if (!state.git.ok) return '';
  const brainSet = brainNodeSet();
  const entries = (state.git.commits || [])
    .map((c) => ({ c, docs: brainDocsOf(c, brainSet) }))
    .filter((e) => e.docs.length);
  if (!entries.length) return '';

  const rows = entries
    .map(({ c, docs }) => {
      const docChips = docs
        .map((d) => {
          const st = docStatus(d) || 'modified';
          const name = docName(d);
          const live = currentDocNode(name);
          const label = name.split('/').pop();
          const code = live
            ? `<code data-bh-doc="${esc(name)}">${esc(label)}</code>`
            : `<code class="bh-gone" title="no longer in the brain">${esc(label)}</code>`;
          return `<span class="bh-doc"><span class="rp-st st-${st}">${esc(st)}</span>${code}</span>`;
        })
        .join('');
      return `<div class="bh-row">
        <div class="bh-when" title="${esc(fmtShortDT(c.t))}">${esc(fmtAgo(c.t))}</div>
        <div class="bh-body">
          <div class="bh-docs">${docChips}</div>
          <div class="bh-sub">${esc(c.subject || '')} <span class="bh-hash">${esc(c.hash)}</span></div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <section class="dash-card brain-history">
      <div class="dash-head"><span class="jargon" title="Every commit that changed a brain doc, across the whole project — the brain graph's history over time.">🧠 Brain history</span><span class="dim-note">${plural(entries.length, 'change')} · newest first</span></div>
      <div class="bh-list">${rows}</div>
    </section>`;
}

// --- Centerpiece: a "brain map" — the agent docs as a graph of cross-refs ---
const docBase = (name) => name.split('/').pop();

function docColor(base) {
  const b = base.toUpperCase();
  if (b === 'SOUL.MD') return 'var(--accent)';
  if (b === 'AGENTS.MD' || b === 'AGENT.MD') return 'var(--codex)';
  if (b.startsWith('CLAUDE')) return 'var(--claude)';
  if (b === 'SEED.MD') return '#ffd166';
  if (b === 'README.MD') return '#8fa0bd';
  return '#5aa9e6';
}

// Coarse role for a doc, used to cluster the web layout: the agent's
// "constitution" (SOUL/AGENTS/CLAUDE/SEED), its evolving memory, or everything
// else (reference: READMEs, plans, ADRs, design docs…).
function docRole(base) {
  const b = base.toUpperCase();
  if (b === 'MEMORY.MD') return 'memory';
  if (/SOUL/.test(b) || ['AGENTS.MD', 'AGENT.MD', 'CLAUDE.MD', 'CLAUDE.LOCAL.MD', 'SEED.MD', 'SEED_V2.MD'].includes(b)) return 'constitution';
  return 'reference';
}

// Build nodes (docs) + edges (one doc references another's filename) and lay
// them out with a small force simulation. Cached per project so it's stable.
function buildDocGraph(files) {
  const nodes = files.map((f, i) => ({
    name: f.name,
    base: docBase(f.name),
    bytes: f.bytes || (f.content || '').length,
    content: f.content || '',
    mtime: f.mtime || 0,
    rank: i, // server priority order (entry docs first)
    archived: !!f.archived, // git-deleted ghost; self-retirement (auto-100% / markers) added below
    inbound: 0, // # of other docs that link to this one (directed) — drives importance/orphan
    bornT: f.bornT,
    deathT: f.deathT,
  }));
  const seen = new Set();
  const edges = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const re = new RegExp(nodes[j].base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(nodes[i].content)) {
        nodes[j].inbound++; // doc i references doc j → an inbound link for j
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ i, j });
        }
      }
    }
  // Docs the agent actually read or edited across captured turns (basenames, lowercased)
  // — the "reads" half of the orphan signal, joining prompt-unit outcomes to nodes.
  const touched = new Set();
  for (const u of state.promptUnits || []) {
    const o = u.outcomes || {};
    for (const d of o.docsRead || []) touched.add(String(d).toLowerCase());
    for (const d of o.docsEdited || []) touched.add(String(d).toLowerCase());
  }
  // Only fade peripheral docs once a genuine hub exists to contrast against — a flat
  // brain (no doc with ≥5 inbound) stays full-brightness rather than uniformly dim.
  const hasSpine = Math.max(0, ...nodes.map((n) => n.inbound)) >= 5;
  const maxB = Math.max(...nodes.map((n) => n.bytes), 1);
  nodes.forEach((n) => {
    n.r = 9 + Math.round(Math.sqrt(n.bytes / maxB) * 14);
    n.color = docColor(n.base);
    n.role = docRole(n.base);
    n.completion = completionOf(n.content); // has checkboxes? → completion ring
    // Importance = inbound references, as a calm brightness tier only (never resizes the
    // node). The load-bearing spine stays vivid; peripheral docs recede. No alarm.
    n.impTier = !hasSpine ? 'hi' : n.inbound >= 5 ? 'hi' : n.inbound >= 2 ? 'mid' : 'lo';
    // Self-retirement: a live on-disk doc that the default (auto-retire at 100%) or
    // a marker sends to the graveyard. (git-deleted docs are already archived above.)
    if (!n.archived && graveyardOf(n.content, n.completion)) {
      n.archived = true;
      // No deletion commit to read born/death from, so derive them: born from git
      // history, retired ≈ last edit (when it completed). In time-travel the node
      // then shows live up to deathT and ghosts after.
      const born = docBirthT(n.name);
      n.bornT = Number.isFinite(born) ? born : n.mtime;
      n.deathT = n.mtime || Date.now();
    }
    // Orphan = nothing links it AND nothing read/edited it in captured history — the one
    // health signal that pulses, because the action is clear: link it or retire it.
    // Exempt: archived nodes and constitution docs (always-loaded, never "retire me").
    n.orphan = !n.archived && n.role !== 'constitution'
      && n.inbound === 0 && !touched.has(String(n.name).toLowerCase());
  });
  const W = 760;
  const H = Math.round(Math.max(220, Math.min(760, 80 + nodes.length * 15)));
  const g = { nodes, edges, W, H };
  applyLayout(g, state.docLayout);
  return g;
}

// Re-position nodes for the chosen layout mode (cheap; edges are unchanged).
function applyLayout(g, mode) {
  if (mode === 'tree') layoutTree(g.nodes, g.edges, g.W, g.H);
  else if (mode === 'recent') layoutRecent(g.nodes, g.W, g.H);
  else layoutGraph(g.nodes, g.edges, g.W, g.H);
}

function layoutGraph(nodes, edges, W, H) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  // Role clustering: give each present role a region (anchor point) around the
  // center and gently pull its docs there, so constitution / reference / memory
  // settle into their own neighborhoods. Only kicks in with ≥2 roles, and only
  // here (the web layout) — Tree and Recent keep their own axes.
  const ROLE_ORDER = ['constitution', 'reference', 'memory'];
  const present = ROLE_ORDER.filter((r) => nodes.some((n) => n.role === r));
  const cluster = present.length > 1;
  const AR = Math.min(W, H) * 0.27;
  const anchors = {};
  present.forEach((r, k) => {
    const a = -Math.PI / 2 + (k / present.length) * Math.PI * 2;
    anchors[r] = { x: W / 2 + Math.cos(a) * AR, y: H / 2 + Math.sin(a) * AR };
  });
  const anchorOf = (n) => (cluster ? anchors[n.role] : { x: W / 2, y: H / 2 });
  nodes.forEach((n, i) => {
    const an = anchorOf(n);
    n.x = an.x + Math.cos(i * 2.4) * 46 + (rnd() - 0.5) * 30;
    n.y = an.y + Math.sin(i * 2.4) * 40 + (rnd() - 0.5) * 30;
    n.vx = 0;
    n.vy = 0;
  });
  const REP = 1400 + nodes.length * 110;
  for (let iter = 0; iter < 380; iter++) {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[i].x - nodes[j].x;
        let dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const f = REP / d2;
        const fx = (f * dx) / d;
        const fy = (f * dy) / d;
        nodes[i].vx += fx;
        nodes[i].vy += fy;
        nodes[j].vx -= fx;
        nodes[j].vy -= fy;
      }
    for (const e of edges) {
      const a = nodes[e.i];
      const b = nodes[e.j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - 110) * 0.02;
      const fx = (f * dx) / d;
      const fy = (f * dy) / d;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const n of nodes) {
      if (cluster) {
        const an = anchorOf(n);
        n.vx += (an.x - n.x) * 0.013; // pull toward this doc's role region
        n.vy += (an.y - n.y) * 0.013;
      }
      n.vx += (W / 2 - n.x) * 0.001; // weak overall centering keeps it on canvas
      n.vy += (H / 2 - n.y) * 0.001;
      n.x += n.vx * 0.85;
      n.y += n.vy * 0.85;
      n.vx *= 0.84;
      n.vy *= 0.84;
    }
  }
  // Fit the settled cloud to the canvas: center it and scale up to fill the
  // frame like Tree/Recent do. Without this the organic sim can leave the graph
  // small and off-center (e.g. a dominant role's mass bunched in one quadrant).
  const padX = 52;
  const padY = 34;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  const bw = maxX - minX || 1;
  const bh = maxY - minY || 1;
  // Scale each axis to fill its own extent, capping the anisotropy so the web fills a
  // wide card without looking stretched. Previously the fit was anchored to the
  // *uniform* scale (min of the two), so on a wide canvas the tighter (height) axis
  // held the width back and nodes bunched mid-canvas with empty margins left/right.
  const fitX = (W - 2 * padX) / bw;
  const fitY = (H - 2 * padY) / bh;
  const lo = Math.min(fitX, fitY);
  const ANISO = 2.4; // how far the roomier axis may stretch past the tighter fit
  const sx = Math.min(fitX, lo * ANISO);
  const sy = Math.min(fitY, lo * ANISO);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  nodes.forEach((n) => {
    n.x = Math.max(padX, Math.min(W - padX, W / 2 + (n.x - cx) * sx));
    n.y = Math.max(padY, Math.min(H - padY, H / 2 + (n.y - cy) * sy));
  });
}

// Tree: layer nodes by reference depth from the repo-root entry docs. Root-level
// files (no '/' in name — README/AGENTS/SOUL/…) sit on the top row; docs they
// reference cascade downward by BFS distance. Disconnected docs go on a last row.
function layoutTree(nodes, edges, W, H) {
  const adj = nodes.map(() => []);
  for (const e of edges) {
    adj[e.i].push(e.j);
    adj[e.j].push(e.i);
  }
  const depth = nodes.map(() => Infinity);
  const q = [];
  nodes.forEach((n, i) => {
    if (!n.name.includes('/')) {
      depth[i] = 0;
      q.push(i);
    }
  });
  if (!q.length) {
    depth[0] = 0;
    q.push(0); // fallback: highest-priority node as root
  }
  while (q.length) {
    const i = q.shift();
    for (const j of adj[i])
      if (depth[j] > depth[i] + 1) {
        depth[j] = depth[i] + 1;
        q.push(j);
      }
  }
  const finiteMax = Math.max(0, ...depth.filter(Number.isFinite));
  nodes.forEach((n, i) => (n._d = Number.isFinite(depth[i]) ? depth[i] : finiteMax + 1));
  const maxD = Math.max(...nodes.map((n) => n._d));
  const layers = new Map();
  nodes.forEach((n) => {
    if (!layers.has(n._d)) layers.set(n._d, []);
    layers.get(n._d).push(n);
  });
  const topPad = 34;
  const usableH = H - topPad - 34;
  for (const [d, layer] of layers) {
    layer.sort((a, b) => a.rank - b.rank); // stable, entry docs leftmost
    const y = maxD === 0 ? H / 2 : topPad + (usableH * d) / maxD;
    const n = layer.length;
    layer.forEach((node, k) => {
      node.x = n === 1 ? W / 2 : 46 + ((W - 92) * k) / (n - 1);
      node.y = y;
    });
  }
}

// Recent: y by last-modified (newest at top), so docs finished in the same era
// sit together. Nodes fan across columns and get pushed down when they'd collide
// with the one above in their column, so same-burst docs never stack on top of
// each other. If pushing overflows the canvas, the whole thing scales to fit.
function layoutRecent(nodes, W, H) {
  const ts = nodes.map((n) => n.mtime || 0);
  const tMax = Math.max(...ts);
  const tMin = Math.min(...ts);
  const span = tMax - tMin || 1;
  const topPad = 34;
  const usableH = H - topPad - 34;
  const cols = Math.min(4, nodes.length);
  const maxR = Math.max(...nodes.map((n) => n.r || 10));
  const perCol = Math.ceil(nodes.length / cols);
  const minGap = Math.min(2 * maxR + 5, usableH / Math.max(1, perCol - 1) || usableH);
  const order = nodes.map((_, i) => i).sort((a, b) => ts[b] - ts[a]); // newest first
  const colBottom = new Array(cols).fill(-Infinity);
  let maxY = topPad;
  order.forEach((idx, rank) => {
    const col = rank % cols; // zig-zag across columns by recency
    const want = topPad + ((tMax - ts[idx]) / span) * usableH; // ideal era position
    const y = Math.max(want, colBottom[col] + minGap); // don't overlap above
    colBottom[col] = y;
    nodes[idx].x = 56 + ((W - 112) * (col + 0.5)) / cols;
    nodes[idx].y = y;
    if (y > maxY) maxY = y;
  });
  if (maxY > topPad + usableH) {
    const k = usableH / (maxY - topPad); // squeeze back into frame
    nodes.forEach((n) => (n.y = topPad + (n.y - topPad) * k));
  }
}

function renderCenterpiece(opts = {}) {
  if (!state.docs.ok || !state.docGraph) {
    return `
      <section class="dash-card centerpiece">
        <div class="dash-head"><span>🧠 AI architecture</span></div>
        <div class="empty">No agent docs captured (SOUL.md / AGENTS.md / CLAUDE.md / SEED.md…).
          Re-run <code>vbrt</code> in the repo to capture them.</div>
      </section>`;
  }
  // The brain is now the live force-sim (liveBrain): persistent doc/plan/memory
  // nodes seeded from the docGraph + ephemeral code-file nodes that flare off the
  // Drive stream. Callers mount this markup, then call liveBrain.attach(host).
  return liveBrain.panel(opts);

  /* --- superseded: the static doc-graph centerpiece (web/tree/recent + time travel).
     Kept below (unreachable) as reference until the live brain has fully replaced its
     features; remove in a follow-up. --- */
  // eslint-disable-next-line no-unreachable
  const g = state.docGraph;
  const files = state.docs.files;

  // Time-travel: render the graph "as of" the selected brain commit. Nodes born
  // after that point are hidden; the docs changed *at* that commit get a ring.
  const tt = state.timeTravel && state.docHistory;
  const ttLine = tt ? ttTimeline() : [];
  let ttAsof = Infinity;
  const ttChanged = new Map();
  if (tt && ttLine.length) {
    state.ttIndex = Math.max(0, Math.min(ttLine.length - 1, state.ttIndex));
    const cm = ttLine[state.ttIndex];
    ttAsof = cm.t;
    for (const d of brainDocsOf(cm, brainNodeSet())) {
      const node = graphNode(docName(d)); // incl. archived ghosts
      if (node) ttChanged.set(node.name, docStatus(d) || 'modified');
    }
  }
  const hideOf = (n) => ttHiddenOf(n, ttAsof, tt);
  const ghostOf = (n) => ttGhostOf(n, ttAsof, tt);

  const edgesSvg = g.edges
    .map(
      (e) =>
        `<line x1="${g.nodes[e.i].x.toFixed(1)}" y1="${g.nodes[e.i].y.toFixed(1)}" x2="${g.nodes[e.j].x.toFixed(1)}" y2="${g.nodes[e.j].y.toFixed(1)}" class="gedge${hideOf(g.nodes[e.i]) || hideOf(g.nodes[e.j]) ? ' tt-hidden' : ''}"/>`,
    )
    .join('');
  const recent = state.docLayout === 'recent';
  // Flash on render: the open-entrance ring, else a live-update flash. liveChanged
  // also drives a lingering "just changed" glow (the streaming change-signal).
  let entrance;
  let liveChanged = new Map();
  if (state._brainEntrance) entrance = recentBrainChanges();
  else { liveChanged = liveFlashMap(); entrance = liveChanged; }
  const ringMap = tt ? ttChanged : entrance; // in tt mode, rings track the selected commit
  const nodesSvg = g.nodes
    .map((n, i) => {
      const on = state.docOpen && n.name === active.name ? ' on' : '';
      const sub = recent && n.mtime
        ? `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 23).toFixed(1)}" text-anchor="middle" class="gsub">${esc(fmtAgo(n.mtime))}</text>`
        : '';
      const hidden = hideOf(n);
      const ghost = ghostOf(n);
      const chg = hidden ? undefined : ringMap.get(n.name);
      const ringCls = chg === 'added' ? 'born' : 'changed';
      // Lifecycle ring (born/flash) — always in the DOM so scrubbing can replay it
      // on whichever node changed; invisible at rest (CSS opacity 0).
      const lring = `<circle class="gring${chg ? ' ' + ringCls : ''}" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="none" stroke="${n.color}"/>`;
      // Completion ring — included for any node with a checklist (has a % now, or is
      // an archived doc that once did) so the scrub can fill/empty it in place.
      const comp = hidden || ghost ? null : (tt ? completionAt(n, ttAsof) : n.completion);
      const ringable = n.completion || n.archived;
      const cR = (n.r + 5);
      const cC = 2 * Math.PI * cR;
      const cPct = comp ? comp.pct : 0;
      const cHide = comp ? '' : ' style="opacity:0"';
      const cring = ringable
        ? `<circle class="gctrack" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${cR.toFixed(1)}" fill="none"${cHide}/>` +
          `<circle class="gcprog" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${cR.toFixed(1)}" fill="none" stroke="${pctColor(cPct)}" stroke-dasharray="${((cPct / 100) * cC).toFixed(1)} ${cC.toFixed(1)}" transform="rotate(-90 ${n.x.toFixed(1)} ${n.y.toFixed(1)})"${cHide}/>`
        : '';
      // A live-changed node gets a lingering "just changed" glow (the streaming signal).
      const liveGlow = liveChanged.has(n.name)
        ? `<circle class="live-glow" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.r + 9).toFixed(1)}" fill="${n.color}"/>`
        : '';
      // Orphan = the one health signal that pulses (amber breathing ring) — only on a
      // live, visible node. Importance tier (data-imp) drives the calm brightness layer.
      const orphan = !hidden && !ghost && n.orphan;
      const oring = orphan
        ? `<circle class="gorphan-ring" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.r + 4).toFixed(1)}" fill="none"/>`
        : '';
      // Hidden nodes stay in the DOM (now opacity-faded, not display:none) so the
      // node↔group indices stay aligned and birth/death can animate.
      const streamIn = state._streamIn && state._streamIn.has(n.name) ? ' stream-in' : '';
      return `<g class="gnode${on}${chg ? ' just-' + ringCls : ''}${hidden ? ' tt-hidden' : ''}${ghost ? ' ghost' : ''}${orphan ? ' orphan' : ''}${streamIn}" data-doc="${esc(n.name)}" data-imp="${n.impTier || 'lo'}">
        ${liveGlow}${oring}
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${n.color}"/>
        ${lring}${cring}
        <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 12).toFixed(1)}" text-anchor="middle" class="glabel">${esc(n.base)}</text>
        ${sub}
      </g>`;
    })
    .join('');

  const modes = [
    ['web', 'Web', 'organic cross-reference web'],
    ['tree', 'Tree', 'layered by reference depth'],
    ['recent', 'Recent', 'positioned by last modified'],
  ];
  const toggle = modes
    .map(
      ([m, label, tip]) =>
        `<button class="lay-btn${state.docLayout === m ? ' on' : ''}" data-layout="${m}" title="${tip}">${label}</button>`,
    )
    .join('');

  // Recent view: a faint vertical time axis so it's obvious which end is newer
  // (layoutRecent puts the most-recently-edited docs at the top).
  const timeAxis = recent
    ? `<g class="time-axis">
        <line x1="13" y1="20" x2="13" y2="${g.H - 16}" class="taxis-line"/>
        <text x="18" y="22" class="taxis-lab">newer ↑</text>
        <text x="18" y="${g.H - 18}" class="taxis-lab">older ↓</text>
      </g>`
    : '';

  return `
    <section class="dash-card centerpiece">
      <div class="dash-head"><span class="jargon" title="Your agent/brain docs (SOUL, AGENTS, CLAUDE, README, plans…) as a graph — edges mean one doc references another. Hover a node to peek inside.">🧠 AI architecture</span>
        <span class="lay-toggle">${toggle}</span>
        ${state.docHistory && !opts.noTimeTravel ? `<button class="lay-btn tt-toggle${tt ? ' on' : ''}" data-tt="toggle" title="Scrub through the brain's history — watch docs get born, change, and get archived.">🕰 Time travel</button>` : ''}
        ${g.nodes.some((n) => n.completion) ? '<span class="ring-key jargon" title="Ring around a node = its checklist completion (amber → green). Any doc with checkboxes.">◔ ring = % done</span>' : ''}
        <span class="dim-note">${files.length} docs · ${g.edges.filter((e) => !g.nodes[e.i].archived && !g.nodes[e.j].archived).length} links</span></div>
      <div class="brain-wrap">
        <svg class="brain" viewBox="0 0 ${g.W} ${g.H}" preserveAspectRatio="xMidYMid meet">${timeAxis}${edgesSvg}${nodesSvg}</svg>
        <div class="brain-peek" id="brainPeek" hidden></div>
      </div>
      ${tickerHtml()}
      ${tt ? renderTimeTravel(ttLine) : ''}
    </section>`;
}

// The time-travel control strip + diff panel below the graph.
function renderTimeTravel(line) {
  if (!line.length) return '<div class="tt-controls"><span class="dim-note">No brain-doc changes captured to travel through.</span></div>';
  const i = Math.max(0, Math.min(line.length - 1, state.ttIndex));
  const cm = line[i];
  const ticks = line
    .map((c, k) => `<span class="tt-tick${k === i ? ' on' : ''}" style="left:${line.length > 1 ? (k / (line.length - 1)) * 100 : 50}%" title="${esc(fmtShortDT(c.t))} · ${esc(c.subject || '')}"></span>`)
    .join('');
  const changes = brainDocsOf(cm, brainNodeSet());
  const focusable = changes.map((d) => docName(d));
  const focus = state.ttFocus && focusable.includes(state.ttFocus) ? state.ttFocus : focusable[0];
  const chips = changes
    .map((d) => {
      const st = docStatus(d) || 'modified';
      const nm = docName(d);
      return `<span class="tt-chg${nm === focus ? ' on' : ''}"><span class="rp-st st-${st}">${st}</span><code data-tt-focus="${esc(nm)}">${esc(nm.split('/').pop())}</code></span>`;
    })
    .join('');
  const rows = focus ? ttDiffRows(focus, cm.hash) : null;
  const diff = rows
    ? `<div class="tt-diff"><div class="tt-diff-name">${esc(focus)}</div><pre>${rows.map(([cls, l]) => `<span class="${cls}">${esc(l)}</span>`).join('\n')}</pre></div>`
    : '<div class="dim-note">No diff for this doc at this commit.</div>';
  return `
    <div class="tt-controls">
      <div class="tt-scrub">
        <button class="tt-btn" data-tt="prev" title="Previous change">◀</button>
        <button class="tt-btn" data-tt="play" title="Play">${state._ttPlay ? '⏸' : '▶'}</button>
        <input class="tt-range" type="range" min="0" max="${line.length - 1}" step="1" value="${i}" data-tt="range" />
        <button class="tt-btn" data-tt="next" title="Next change">▶</button>
        <button class="tt-btn" data-tt="now" title="Jump to latest">Now</button>
        <span class="tt-asof">as of <b>${esc(fmtShort(cm.t))}</b> · ${i + 1}/${line.length}</span>
      </div>
      <div class="tt-ticks">${ticks}</div>
      <div class="tt-panel">
        <div class="tt-commit">${esc(cm.subject || '(no subject)')} <span class="tt-hash">${esc(cm.hash)}</span></div>
        <div class="tt-changes">${chips}</div>
        ${diff}
      </div>
    </div>`;
}

function rerenderCenterpiece() {
  const cp = el('#conversation').querySelector('.centerpiece');
  if (cp) {
    cp.outerHTML = renderCenterpiece();
    wireDocTabs();
    liveBrain.attach(el('#conversation').querySelector('.centerpiece'));
  }
}

// The doc's H1–H3 outline — what hover-peek shows so a node reveals what's *inside*
// it (its structure), not just its filename.
function docHeadings(content, cap = 14) {
  const out = [];
  for (const l of String(content || '').split('\n')) {
    const m = l.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) out.push({ lvl: m[1].length, text: m[2].slice(0, 70) });
  }
  return { all: out, shown: out.slice(0, cap) };
}

function brainPeekHtml(n) {
  const { all, shown } = docHeadings(n.content);
  const kb = fmtBytes(n.bytes || (n.content || '').length);
  const first = (String(n.content || '')
    .split('\n')
    .find((l) => l.trim() && !/^#/.test(l) && !/^>/.test(l) && !/^[-*]\s/.test(l)) || '')
    .trim()
    .slice(0, 150);
  const list = all.length
    ? shown.map((h) => `<div class="bp-h l${h.lvl}">${h.lvl > 1 ? '§ ' : ''}${esc(h.text)}</div>`).join('') +
      (all.length > shown.length ? `<div class="bp-h l3">+${all.length - shown.length} more</div>` : '')
    : '<div class="bp-flat">no headings — flat doc</div>';
  const comp = n.completion
    ? `<div class="bp-comp"><span class="bp-comp-bar"><span style="width:${n.completion.pct}%;background:${pctColor(n.completion.pct)}"></span></span>${n.completion.pct}% done · ${n.completion.done}/${n.completion.total}</div>`
    : '';
  // Quiet health line: orphan calls for action; otherwise a calm importance read. State,
  // not score — and connectivity stays informational, never an alarm.
  const links = n.inbound || 0;
  const linkTxt = `${links} inbound link${links === 1 ? '' : 's'}`;
  const health = n.orphan
    ? `<div class="bp-health orphan"><span class="bp-dot"></span>orphaned — nothing links or reads it · <b>link it or retire it</b></div>`
    : `<div class="bp-health"><span class="bp-dot t-${n.impTier || 'lo'}"></span>${n.impTier === 'hi' ? 'spine' : n.impTier === 'mid' ? 'connected' : 'peripheral'} · ${linkTxt}</div>`;
  return `<div class="bp-head"><span class="bp-name">${esc(n.base)}</span><span class="bp-meta">${esc(kb)} · ${all.length} section${all.length === 1 ? '' : 's'}</span></div>
    ${health}
    ${comp}
    ${first ? `<div class="bp-first">${esc(first)}</div>` : ''}
    <div class="bp-sections">${list}</div>`;
}

// Hover-peek: hovering a node surfaces its outline + first line in a floating card
// anchored beside it, so you read what's inside without opening the full doc.
// Click still opens the full reader overlay (progressive disclosure).
function wireBrainPeek(root) {
  const peek = root.querySelector('#brainPeek');
  const wrap = root.querySelector('.brain-wrap');
  if (!peek || !wrap) return;
  root.querySelectorAll('.gnode').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      if (state.docOpen) return; // full reader is open — don't peek over it
      // Look up the node live (not a captured map) so a live/stream update shows
      // fresh content without a re-wire.
      const n = (state.docGraph?.nodes || []).find((x) => x.name === g.dataset.doc);
      if (!n) return;
      peek.innerHTML = brainPeekHtml(n);
      peek.hidden = false;
      const wb = wrap.getBoundingClientRect();
      // the body circle (not the glow/ring overlays) for anchoring
      const body = g.querySelector('circle:not(.live-glow):not(.gring):not(.gctrack):not(.gcprog):not(.gorphan-ring)') || g.querySelector('circle');
      const cb = body.getBoundingClientRect();
      const pw = peek.offsetWidth;
      const ph = peek.offsetHeight;
      let left = cb.right - wb.left + 12;
      if (left + pw > wb.width) left = cb.left - wb.left - pw - 12; // flip to the left near the edge
      left = Math.max(6, Math.min(left, wb.width - pw - 6));
      let top = cb.top - wb.top + cb.height / 2 - ph / 2;
      top = Math.max(6, Math.min(top, wb.height - ph - 6));
      peek.style.left = `${left}px`;
      peek.style.top = `${top}px`;
    });
    g.addEventListener('mouseleave', () => {
      peek.hidden = true;
    });
  });
}

function wireDocTabs() {
  const root = el('#conversation');
  root.querySelectorAll('[data-doc]').forEach((b) => {
    b.onclick = () => {
      const node = (state.docGraph?.nodes || []).find((n) => n.name === b.dataset.doc);
      if (node) openDocLightbox(node);
    };
  });
  root.querySelectorAll('[data-layout]').forEach((b) => {
    b.onclick = () => setLayout(b.dataset.layout);
  });
  wireBrainPeek(root);
  wireTimeTravel(root);
}

// Animate the brain to the scrubbed moment *in place* (no DOM rebuild), so births
// fade in, deaths fade to ghost, and rings fill smoothly via CSS transitions. The
// controls/diff panel is refreshed on its own. Shared shape with future streaming.
function applyBrainAsOf() {
  const svg = el('#conversation .brain');
  const g = state.docGraph;
  if (!svg || !g) return;
  const tt = state.timeTravel && state.docHistory;
  const line = tt ? ttTimeline() : [];
  const cm = line[state.ttIndex];
  const asof = cm ? cm.t : Infinity;
  const changed = new Map();
  if (cm) for (const d of brainDocsOf(cm, brainNodeSet())) {
    const node = graphNode(docName(d));
    if (node) changed.set(node.name, docStatus(d) || 'modified');
  }
  const groups = svg.querySelectorAll('.gnode');
  groups.forEach((grp, i) => {
    const n = g.nodes[i];
    if (!n) return;
    const hidden = ttHiddenOf(n, asof, tt);
    const ghost = ttGhostOf(n, asof, tt);
    grp.classList.toggle('tt-hidden', hidden);
    grp.classList.toggle('ghost', ghost);
    // completion ring fills/empties (CSS transitions stroke-dasharray)
    const prog = grp.querySelector('.gcprog');
    const track = grp.querySelector('.gctrack');
    if (prog && track) {
      const comp = hidden || ghost ? null : completionAt(n, asof);
      if (comp) {
        const C = 2 * Math.PI * (n.r + 5);
        prog.setAttribute('stroke-dasharray', `${((comp.pct / 100) * C).toFixed(1)} ${C.toFixed(1)}`);
        prog.setAttribute('stroke', pctColor(comp.pct));
        prog.style.opacity = track.style.opacity = '';
      } else {
        prog.style.opacity = track.style.opacity = '0';
      }
    }
    // replay the born/flash ring on whichever doc changed at this commit
    const gr = grp.querySelector('.gring');
    if (gr) {
      gr.classList.remove('born', 'changed');
      const chg = hidden ? null : changed.get(n.name);
      if (chg) { void gr.getBoundingClientRect(); gr.classList.add(chg === 'added' ? 'born' : 'changed'); }
    }
  });
  svg.querySelectorAll('.gedge').forEach((ln, k) => {
    const e = g.edges[k];
    if (e) ln.classList.toggle('tt-hidden', ttHiddenOf(g.nodes[e.i], asof, tt) || ttHiddenOf(g.nodes[e.j], asof, tt));
  });
}

// Move to a commit and animate there, refreshing only the controls panel (the
// SVG keeps its elements so transitions run).
function scrubTo(idx, len) {
  state.ttIndex = Math.max(0, Math.min(len - 1, idx));
  state.ttFocus = null;
  applyBrainAsOf();
  refreshTTControls();
}

// Wire the time-travel toggle, scrubber, play, and per-doc diff focus.
function wireTimeTravel(root) {
  const len = (state.timeTravel && state.docHistory) ? ttTimeline().length : 0;
  const go = (idx) => scrubTo(idx, len);
  const stopPlay = () => { if (state._ttPlay) { clearInterval(state._ttPlay); state._ttPlay = null; } };
  root.querySelectorAll('[data-tt]').forEach((b) => {
    const act = b.dataset.tt;
    if (act === 'toggle') b.onclick = () => {
      stopPlay();
      state.timeTravel = !state.timeTravel;
      if (state.timeTravel) { state.ttIndex = Math.max(0, ttTimeline().length - 1); state.ttFocus = null; } // start at "now"
      rerenderCenterpiece();
    };
    else if (act === 'prev') b.onclick = () => { stopPlay(); go(state.ttIndex - 1); };
    else if (act === 'next') b.onclick = () => { stopPlay(); go(state.ttIndex + 1); };
    else if (act === 'now') b.onclick = () => { stopPlay(); go(len - 1); };
    else if (act === 'range') b.oninput = () => { stopPlay(); go(Number(b.value)); };
    else if (act === 'play') b.onclick = () => {
      if (state._ttPlay) { stopPlay(); refreshTTControls(); return; }
      if (state.ttIndex >= len - 1) state.ttIndex = 0;
      state._ttPlay = setInterval(() => {
        if (state.ttIndex >= len - 1) { stopPlay(); refreshTTControls(); return; }
        scrubTo(state.ttIndex + 1, len);
      }, 1500);
      scrubTo(state.ttIndex, len); // apply current + flip button to ⏸
    };
  });
  root.querySelectorAll('[data-tt-focus]').forEach((b) => {
    b.onclick = () => { state.ttFocus = b.dataset.ttFocus; refreshTTControls(); }; // diff only, leave the graph
  });
}

// Rebuild just the time-travel control strip + diff panel (not the SVG).
function refreshTTControls() {
  const c = el('#conversation .tt-controls');
  if (c) { c.outerHTML = renderTimeTravel(ttTimeline()); wireTimeTravel(el('#conversation')); }
}

// Switch layout mode and tween nodes/edges from their current spots to the new
// ones, so the graph morphs smoothly instead of snapping.
let layoutRaf = null;
function setLayout(mode) {
  const g = state.docGraph;
  if (!g || state.docLayout === mode) return;
  if (layoutRaf) cancelAnimationFrame(layoutRaf);
  const from = g.nodes.map((n) => ({ x: n.x, y: n.y })); // current (maybe mid-tween) spots
  applyLayout(g, mode); // mutates g.nodes to the target spots
  const to = g.nodes.map((n) => ({ x: n.x, y: n.y }));
  g.nodes.forEach((n, i) => ((n.x = from[i].x), (n.y = from[i].y))); // render starts at `from`
  state.docLayout = mode;
  rerenderCenterpiece(); // rebuild DOM for the new mode (labels/dates) at start positions
  animateGraph(g, from, to);
}

function animateGraph(g, from, to) {
  const svg = el('#conversation .brain');
  if (!svg) {
    g.nodes.forEach((n, i) => ((n.x = to[i].x), (n.y = to[i].y)));
    return;
  }
  const groups = [...svg.querySelectorAll('.gnode')]; // node order matches g.nodes
  const lines = [...svg.querySelectorAll('.gedge')]; // edge order matches g.edges
  const dur = 620;
  const t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad
  const frame = (now) => {
    const e = ease(Math.min(1, (now - t0) / dur));
    g.nodes.forEach((n, i) => {
      n.x = from[i].x + (to[i].x - from[i].x) * e;
      n.y = from[i].y + (to[i].y - from[i].y) * e;
      const grp = groups[i];
      if (!grp) return;
      grp.querySelectorAll('circle').forEach((c) => { // halo + node + rings all follow
        c.setAttribute('cx', n.x.toFixed(1));
        c.setAttribute('cy', n.y.toFixed(1));
        if (c.classList.contains('gcprog')) c.setAttribute('transform', `rotate(-90 ${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
      });
      const lab = grp.querySelector('.glabel');
      if (lab) {
        lab.setAttribute('x', n.x.toFixed(1));
        lab.setAttribute('y', (n.y + n.r + 12).toFixed(1));
      }
      const sub = grp.querySelector('.gsub');
      if (sub) {
        sub.setAttribute('x', n.x.toFixed(1));
        sub.setAttribute('y', (n.y + n.r + 23).toFixed(1));
      }
    });
    lines.forEach((ln, k) => {
      const a = g.nodes[g.edges[k].i];
      const b = g.nodes[g.edges[k].j];
      ln.setAttribute('x1', a.x.toFixed(1));
      ln.setAttribute('y1', a.y.toFixed(1));
      ln.setAttribute('x2', b.x.toFixed(1));
      ln.setAttribute('y2', b.y.toFixed(1));
    });
    layoutRaf = e < 1 ? requestAnimationFrame(frame) : null;
  };
  layoutRaf = requestAnimationFrame(frame);
}

function mergedTicks(tMin, span) {
  const ticks = [];
  for (let i = 0; i <= 5; i++)
    ticks.push(`<span class="tick" style="left:${(i / 5) * 100}%">${fmtShort(tMin + (span * i) / 5)}</span>`);
  return ticks.join('');
}

const SRC_COLOR = { claude: 'var(--claude)', codex: 'var(--codex)' };
const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

// Legend for the Activity timeline — decodes every mark at rest (the review's
// top issue: the marks carry meaning but had no key). Wired in under the ribbon.
function ribbonLegend() {
  const git = state.git.ok;
  return `<div class="ribbon-legend">
    <span class="rl-item"><span class="rl-sw" style="background:var(--claude)"></span><span class="rl-sw" style="background:var(--codex)"></span> agent: claude / codex</span>
    ${git ? '<span class="rl-item"><span class="rl-tick"></span> commit</span>' : ''}
    ${git ? '<span class="rl-item"><span class="rl-diamond"></span> 🧠 brain-doc change</span>' : ''}
    <span class="rl-item"><span class="rl-code"><span class="a"></span><span class="d"></span></span> code: +added / −removed</span>
    <span class="rl-item rl-hint">click a mark for detail · drag the messages row to filter</span>
  </div>`;
}

// ---------- merged Activity widget (3 competing concepts) ----------

function fmtAgo(ms) {
  const d = Date.now() - ms;
  if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))}m ago`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h ago`;
  const days = Math.round(d / 86400000);
  if (days < 30) return `${days}d ago`;
  const mo = Math.round(days / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

// Git commits within the conversation window (± a day).
function windowCommits(sessions) {
  let commits = state.git.commits || [];
  if (sessions.length && commits.length) {
    const lo = Math.min(...sessions.map((s) => s.start)) - 86400000;
    const hi = Math.max(...sessions.map((s) => s.end)) + 86400000;
    commits = commits.filter((c) => c.t >= lo && c.t <= hi);
  }
  return commits;
}

function lastActive(sessions) {
  return Math.max(...sessions.flatMap((s) => (s.msgs || []).map((m) => m.t)).concat(sessions.map((s) => s.start)));
}

// Brain-doc detection unifies the timeline with the graph: a changed .md counts
// as "brain" if it's a node in this project's brain graph. Falls back to a known
// agent-doc basename list when no graph was captured. Tolerant of both the new
// commit-doc shape ({name,status}) and the legacy bare-string shape.
const BRAIN_FALLBACK = new Set(['soul.md', 'agents.md', 'agent.md', 'claude.md', 'claude.local.md', 'seed.md', 'context.md', 'memory.md', 'backlog.md', 'decisions.md', 'attempts.md', 'log.md', 'roadmap.md', 'project.md', 'tasks.md']);
const docName = (d) => (typeof d === 'string' ? d : (d && d.name)) || '';
const docStatus = (d) => (typeof d === 'string' ? null : (d && d.status)) || null;
function brainNodeSet() {
  const g = state.docGraph;
  if (g && g.nodes && g.nodes.length) return new Set(g.nodes.map((n) => n.base.toLowerCase()));
  return null;
}
function brainDocsOf(c, brainSet) {
  if (!c.docs) return [];
  const set = brainSet !== undefined ? brainSet : brainNodeSet();
  return c.docs.filter((d) => {
    const base = docName(d).split('/').pop().toLowerCase();
    // a current graph node OR a known agent-doc name (so an *archived* brain doc,
    // which is no longer a node, still counts as a brain change).
    return (set && set.has(base)) || BRAIN_FALLBACK.has(base);
  });
}

// The current (non-archived) brain-graph node matching a doc, or null (the doc
// was since deleted — only its history holds content).
function currentDocNode(name) {
  const g = state.docGraph;
  if (!g) return null;
  const base = name.split('/').pop();
  return g.nodes.find((n) => !n.archived && (n.name === name || n.base === base)) || null;
}
// Any graph node (incl. archived ghosts) matching a doc — used by time-travel.
function graphNode(name) {
  const g = state.docGraph;
  if (!g) return null;
  const base = name.split('/').pop();
  return g.nodes.find((n) => n.name === name || n.base === base) || null;
}

// Pseudo-"files" for docs that were archived (their newest history version is a
// deletion), so the graph builder lays them out as ghost nodes. Carries the
// lifetime (bornT…deathT) and the last content (for hover-peek / the ghost).
function archivedPseudoFiles() {
  const h = state.docHistory;
  if (!h) return [];
  const out = [];
  for (const [path, versions] of Object.entries(h)) {
    if (!versions.length || versions[0].status !== 'deleted') continue;
    const lastContent = (versions.find((v) => v.content != null) || {}).content || '';
    out.push({
      name: path,
      content: lastContent,
      bytes: lastContent.length,
      mtime: versions[0].t,
      archived: true,
      bornT: versions[versions.length - 1].t,
      deathT: versions[0].t,
    });
  }
  return out;
}

// The brain docs changed in the most recent brain-touching commit, mapped to
// their current graph node + status (added/modified/…). Drives the one-shot
// "just changed" entrance on the graph — the lifecycle birth/flash, from the
// --name-status data we capture (no historical content needed; that's time-travel).
function recentBrainChanges() {
  if (!state.git || !state.git.ok) return new Map();
  const brainSet = brainNodeSet();
  for (const c of state.git.commits || []) { // git log is newest-first
    const bd = brainDocsOf(c, brainSet);
    if (!bd.length) continue;
    const m = new Map();
    for (const d of bd) {
      const node = currentDocNode(docName(d));
      if (node) m.set(node.name, docStatus(d) || 'modified');
    }
    if (m.size) return m;
  }
  return new Map();
}

// ---------- brain time travel ----------

// Version list for a doc path (exact, else by basename), newest-first.
function histFor(path) {
  const h = state.docHistory;
  if (!h) return null;
  if (h[path]) return h[path];
  const base = path.split('/').pop();
  const key = Object.keys(h).find((k) => k.split('/').pop() === base);
  return key ? h[key] : null;
}
// When a doc first appears in history (its birth). -Infinity = predates the
// captured history, so it's treated as always-present.
function docBirthT(name) {
  const v = histFor(name);
  if (!v || !v.length) return -Infinity;
  return v[v.length - 1].t;
}
// The brain-history commits, oldest→newest — the scrubber's stops.
function ttTimeline() {
  if (!state.git || !state.git.ok) return [];
  const brainSet = brainNodeSet();
  return (state.git.commits || []).filter((c) => brainDocsOf(c, brainSet).length).slice().reverse();
}

// Compact LCS line diff (capped so a huge doc can't blow up the DP).
function lineDiff(oldText, newText) {
  const CAP = 800;
  let a = String(oldText || '').split('\n');
  let b = String(newText || '').split('\n');
  const truncated = a.length > CAP || b.length > CAP;
  a = a.slice(0, CAP);
  b = b.slice(0, CAP);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push(['ctx', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push(['del', a[i]]); i++; }
    else { rows.push(['add', b[j]]); j++; }
  }
  while (i < n) rows.push(['del', a[i++]]);
  while (j < m) rows.push(['add', b[j++]]);
  if (truncated) rows.push(['ctx', '… (diff truncated)']);
  return rows;
}
// Diff rows for a doc at a given commit (vs its previous version). Handles
// added (all-add), deleted (all-del from the prior content), and modified.
function ttDiffRows(name, hash) {
  const v = histFor(name);
  if (!v) return null;
  const idx = v.findIndex((x) => x.hash === hash);
  if (idx === -1) return null;
  const cur = v[idx];
  const prev = v[idx + 1]; // older
  if (cur.status === 'deleted') return lineDiff(prev ? prev.content : '', '');
  return lineDiff(prev ? prev.content : '', cur.content || '');
}

// ---------- checklist completion (checkbox ratio → brain node ring) ----------

// Checkbox completion of a doc: ratio of [x] to all [ ]/[x]. null = no checkboxes
// (→ no checklist → no ring).
function completionOf(content) {
  const boxes = String(content || '').match(/^[ \t>*+-]*\[([ xX])\]/gm) || [];
  if (!boxes.length) return null;
  const done = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  return { pct: Math.round((done / boxes.length) * 100), done, total: boxes.length };
}
// Optional `status:` frontmatter marker that overrides the default graveyard
// lifecycle (see graveyardOf). Returns 'keep' (force-live), 'archive' (force-
// retired), or null. The default is auto-retire-at-100% for any checklist, so the
// common case needs NO marker — markers are only for the exceptions.
function statusMarker(content) {
  const fm = String(content || '').match(/^﻿?---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^\s*status\s*:\s*["']?([a-z][a-z-]*)["']?\s*$/im);
  if (!m) return null;
  const v = m[1].toLowerCase();
  if (['active', 'live', 'keep-alive', 'keepalive', 'pinned', 'wip', 'open'].includes(v)) return 'keep';
  if (['archived', 'retired', 'graveyard'].includes(v)) return 'archive';
  return null;
}

// Decide whether a *live, on-disk* doc (not git-deleted) belongs in the graveyard.
// Default, zero-overhead: any finished checklist (every box checked → 100%) auto-
// retires — no marker, no `git rm`, regardless of filename. Completion *is* the
// signal. Opt-out: `status: active` keeps a finished checklist live. Opt-in for a
// doc without a 100% checklist: `status: archived` retires it explicitly. Retiring
// hides the node from the live web (like a git-deleted doc) and ghosts it in time-travel.
function graveyardOf(content, completion) {
  const mark = statusMarker(content);
  if (mark === 'keep') return false; // explicit "keep alive" wins over auto-retire
  if (mark === 'archive') return true; // explicit retire
  return !!completion && completion.pct === 100; // any finished checklist auto-retires
}
// Completion color: warm amber (low) → green (done).
function pctColor(p) {
  const a = [240, 120, 60];
  const b = [63, 185, 80];
  const t = Math.max(0, Math.min(1, p / 100));
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
// Node lifecycle predicates as of a moment — shared by the full render and the
// in-place scrub animation. (Also the foundation for streaming create/remove.)
function ttHiddenOf(n, asof, tt) {
  if (tt) return (n.archived ? n.bornT : docBirthT(n.name)) > asof;
  return !!n.archived; // outside time-travel, archived docs aren't shown
}
function ttGhostOf(n, asof, tt) {
  return tt && n.archived && asof >= n.deathT && !ttHiddenOf(n, asof, tt);
}

// A doc's completion as of a moment (uses the historical version in time-travel).
function completionAt(node, asof) {
  if (asof === Infinity || !state.docHistory) return node.completion;
  const v = histFor(node.name);
  if (!v) return node.completion;
  const ver = v.find((x) => x.t <= asof && x.content != null); // newest ≤ asof
  return ver ? completionOf(ver.content) : null;
}
const STATUS_GLYPH = { added: '＋', modified: '∆', deleted: '−', renamed: '→', copied: '⎘' };

function overviewHeader(sessions) {
  const convos = sessions.length;
  const messages = sessions.reduce((a, s) => a + (s.userCount || 0), 0);
  const wc = windowCommits(sessions);
  const commits = wc.length;
  const brain = wc.filter((c) => brainDocsOf(c).length).length;
  const firstT = Math.min(...sessions.map((s) => s.start));
  const lastT = lastActive(sessions);
  const claude = sessions.filter((s) => s.source === 'claude').length;
  const codex = sessions.filter((s) => s.source === 'codex').length;
  const added = sessions.reduce((a, s) => a + (s.added || 0), 0);
  const removed = sessions.reduce((a, s) => a + (s.removed || 0), 0);
  const lines = added || removed ? ` · <b class="diff-add">+${added}</b>/<b class="diff-del">−${removed}</b> lines` : '';
  const pulse = state._liveDigest; state._liveDigest = null; // one-shot
  return `
    <div class="ov-stats">
      ${pulse ? `<div class="live-pulse">↑ just now · ${pulse}</div>` : ''}
      <div class="ov-line1"><b>${convos}</b> ${plw(convos, 'conversation')} · <b>${messages}</b> ${plw(messages, 'message')}${state.git.ok ? ` · <b>${commits}</b> ${plw(commits, 'commit')}` : ''}${brain ? ` · <span class="jargon" title="commits that changed a brain doc — SOUL / AGENTS / CLAUDE / ROADMAP / etc."><b>${brain}</b> 🧠 ${plw(brain, 'brain edit')}</span>` : ''}${lines}</div>
      <div class="ov-line2">${fmtShort(firstT)} – ${fmtShort(lastT)} · last active <b>${fmtAgo(lastT)}</b>
        <span class="ov-split"><span class="sw2" style="background:var(--claude)"></span>${claude}
        <span class="sw2" style="background:var(--codex)"></span>${codex}</span>
      </div>
    </div>`;
}

// Ribbon — one linear time axis: commit ticks / message heat / convo blocks.
// Click a convo block for an inline detail card; drag the messages strip to
// filter the conversation list on the left.
function renderRibbon(sessions) {
  state._tlSessions = sessions;
  const commits = windowCommits(sessions);
  const tMin = Math.min(...sessions.map((s) => s.start));
  const tMax = Math.max(lastActive(sessions), ...(commits.length ? commits.map((c) => c.t) : [0]));
  const span = Math.max(1, tMax - tMin);
  const pct = (t) => ((t - tMin) / span) * 100;
  state._rib = { tMin, tMax };
  state._winByHash = Object.fromEntries(commits.map((c) => [c.hash, c]));
  const brainSet = brainNodeSet();

  const ctick = commits
    .map(
      (c) =>
        `<span class="rib-c ${c.isRevert ? 'revert' : ''}${state._liveFreshCommits?.has(c.hash) ? ' rib-fresh' : ''}" data-commit="${esc(c.hash)}" style="left:${pct(c.t)}%" title="${esc(fmtShortDT(c.t))} · ${esc(c.hash)} · ${esc(c.subject)}"></span>`,
    )
    .join('');

  const N = 120;
  const bins = new Array(N).fill(0);
  const binSrc = Array.from({ length: N }, () => ({})); // per-bin source tallies → color the heat like the convo blocks
  for (const s of sessions)
    for (const m of s.msgs || []) {
      let bi = Math.floor((pct(m.t) / 100) * N);
      bi = Math.max(0, Math.min(N - 1, bi));
      bins[bi]++;
      binSrc[bi][s.source] = (binSrc[bi][s.source] || 0) + 1;
    }
  const maxBin = Math.max(1, ...bins);
  // A message bar takes the color of the agent that sent the most messages in that
  // bin (claude / codex), matching the convo blocks below — so the two lanes read as
  // the same threads. Mixed bins fall to whichever agent dominates the slice.
  const binColor = (i) => {
    let best = null; let bestN = -1;
    for (const k in binSrc[i]) if (binSrc[i][k] > bestN) { bestN = binSrc[i][k]; best = k; }
    return SRC_COLOR[best] || 'var(--accent)';
  };
  const heat = bins
    .map((n, i) => (n ? `<span class="rib-h" style="left:${(i / N) * 100}%;height:${4 + Math.round((Math.sqrt(n) / Math.sqrt(maxBin)) * 22)}px;background:${binColor(i)}" title="${plural(n, 'msg')}"></span>` : ''))
    .join('');

  const maxCount = Math.max(1, ...sessions.map((s) => s.userCount));
  // Convo blocks span their real start→end so a bar sits *under* the messages it
  // contains. Previously each was a fixed count-width stub pinned at the start, which
  // left message bars floating over empty track with no convo beneath them. Message
  // count now reads as opacity (via --rib-op, so hover/select can still brighten).
  const blocks = sessions
    .map((s) => {
      const sel = state.selectedConvo === s.id ? ' sel' : '';
      const dl = diffLabel(s);
      const w = Math.max(0, pct(s.end) - pct(s.start));
      const op = (0.4 + 0.5 * (s.userCount / maxCount)).toFixed(2);
      return `<span class="rib-b${sel}${state._liveFreshConvos?.has(s.id) ? ' rib-fresh' : ''}" data-convo="${esc(s.id)}" style="left:${pct(s.start)}%;width:${w.toFixed(2)}%;--rib-op:${op};background:${SRC_COLOR[s.source] || 'var(--accent)'}"
           title="${esc(fmtShortDT(s.start))} → ${esc(fmtShortDT(s.end))} · ${s.source} · ${plural(s.userCount, 'msg')}${dl ? ' · ' + dl : ''} · ${esc(s.title)}"></span>`;
    })
    .join('');

  // "code" lane — per-convo line churn, green (added) over red (removed),
  // bar height ∝ √(total churn). Only when we have enriched activity data.
  const maxChurn = Math.max(1, ...sessions.map((s) => (s.added || 0) + (s.removed || 0)));
  const codeBars = sessions
    .map((s) => {
      const add = s.added || 0;
      const del = s.removed || 0;
      const churn = add + del;
      if (!churn) return '';
      const h = 4 + Math.round((Math.sqrt(churn) / Math.sqrt(maxChurn)) * 22);
      const addPct = Math.round((add / churn) * 100);
      return `<span class="rib-code" data-code="${esc(s.id)}" style="left:${pct(s.start)}%;height:${h}px" title="${esc(fmtShortDT(s.start))} · +${add}/−${del} lines · ${esc(s.title)}"><span class="rib-code-add" style="height:${addPct}%"></span><span class="rib-code-del" style="height:${100 - addPct}%"></span></span>`;
    })
    .join('');
  const codeRow = state.activity.ok
    ? `<div class="rib-row"><span class="rib-lab">code</span><div class="rib-track rib-codetrack">${codeBars}</div></div>`
    : '';

  // "brain" lane — commits that changed a brain-graph doc (unified with the
  // graph's doc set). Tooltip lists each doc with its change (added/modified/…).
  const brainMarks = commits
    .map((c) => {
      const bd = brainDocsOf(c, brainSet);
      if (!bd.length) return '';
      const list = bd.map((d) => `${docStatus(d) ? (STATUS_GLYPH[docStatus(d)] || '') + ' ' : ''}${docName(d).split('/').pop()}`).join(', ');
      return `<span class="rib-d${state._liveFreshCommits?.has(c.hash) ? ' rib-fresh' : ''}" data-brain="${esc(c.hash)}" style="left:${pct(c.t)}%" title="${esc(fmtShortDT(c.t))} · 🧠 ${esc(list)} · ${esc(c.subject)}"></span>`;
    })
    .join('');
  const brainRow = state.git.ok
    ? `<div class="rib-row"><span class="rib-lab">brain</span><div class="rib-track rib-brain">${brainMarks}</div></div>`
    : '';

  const brushRect = state.brush
    ? `<div class="rib-brush-rect" style="left:${pct(state.brush[0])}%;width:${Math.max(0.5, pct(state.brush[1]) - pct(state.brush[0]))}%"></div>`
    : '';

  return `
    <div class="ribbon">
      <div class="rib-axis"><span class="rib-lab"></span><div class="rib-track">${mergedTicks(tMin, span)}</div></div>
      <div class="rib-row"><span class="rib-lab">commits</span><div class="rib-track rib-commits">${ctick}</div></div>
      ${brainRow}
      <div class="rib-row"><span class="rib-lab">messages</span><div class="rib-track rib-heat">${heat}<div class="rib-brush" id="ribBrush">${brushRect}</div></div></div>
      <div class="rib-row"><span class="rib-lab">convos</span><div class="rib-track rib-blocks">${blocks}</div></div>
      ${codeRow}
    </div>`;
}

// Wire up the activity widget (interactive convo select + time-range brush).
function wireActivity() {
  el('#conversation')
    .querySelectorAll('[data-convo]')
    .forEach((b) => {
      b.onclick = () => {
        // Clicking a convo block highlights + scrolls to that session in the
        // left list (no inline card) — the sidebar is where you read it.
        state.selectedConvo = b.dataset.convo;
        renderSessionList();
        renderTimeline();
        scrollConvoIntoList(b.dataset.convo);
      };
    });

  // Commit / brain / code ticks open a detail popover (previously inert).
  const lookupCommit = (h) => state._winByHash && state._winByHash[h];
  el('#conversation').querySelectorAll('[data-commit]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const c = lookupCommit(b.dataset.commit);
    if (c) openRibDetail(b, commitDetailHtml(c));
  }));
  el('#conversation').querySelectorAll('[data-brain]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const c = lookupCommit(b.dataset.brain);
    if (c) openRibDetail(b, brainDetailHtml(c));
  }));
  // The code lane is per-session — selecting it behaves like the convos lane:
  // highlight + scroll to that session in the sidebar.
  el('#conversation').querySelectorAll('[data-code]').forEach((b) => (b.onclick = () => {
    state.selectedConvo = b.dataset.code;
    renderSessionList();
    renderTimeline();
    scrollConvoIntoList(b.dataset.code);
  }));

  const brush = document.getElementById('ribBrush');
  if (brush && state._rib) {
    brush.onmousedown = (e) => {
      const track = brush.getBoundingClientRect();
      const x0 = e.clientX;
      const rect = document.createElement('div');
      rect.className = 'rib-brush-rect live';
      brush.appendChild(rect);
      const upd = (x) => {
        rect.style.left = `${Math.max(0, Math.min(x0, x) - track.left)}px`;
        rect.style.width = `${Math.abs(x - x0)}px`;
      };
      upd(e.clientX);
      const mm = (ev) => upd(ev.clientX);
      const mu = (ev) => {
        document.removeEventListener('mousemove', mm);
        document.removeEventListener('mouseup', mu);
        const { tMin, tMax } = state._rib;
        const sp = tMax - tMin;
        const f0 = Math.max(0, Math.min(1, (Math.min(x0, ev.clientX) - track.left) / track.width));
        const f1 = Math.max(0, Math.min(1, (Math.max(x0, ev.clientX) - track.left) / track.width));
        state.brush = f1 - f0 < 0.01 ? null : [tMin + f0 * sp, tMin + f1 * sp];
        renderSessionList();
        renderTimeline();
      };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
      e.preventDefault();
    };
  }
}

// ---------- ribbon detail popover (commit / brain / code) ----------

const ribEsc = (e) => { if (e.key === 'Escape') closeRibDetail(); };
const ribOutside = (e) => {
  if (!e.target.closest('.rib-pop') && !e.target.closest('[data-commit],[data-brain],[data-code]')) closeRibDetail();
};
function closeRibDetail() {
  const p = el('.rib-pop');
  if (p) p.remove();
  document.removeEventListener('keydown', ribEsc, true);
  document.removeEventListener('click', ribOutside, true);
}
function openRibDetail(anchorEl, html) {
  closeRibDetail();
  const card = anchorEl.closest('.dash-card');
  if (!card) return;
  const pop = document.createElement('div');
  pop.className = 'rib-pop';
  pop.innerHTML = `<button class="rib-pop-x" title="Close">✕</button>${html}`;
  card.appendChild(pop);
  const cb = card.getBoundingClientRect();
  const ab = anchorEl.getBoundingClientRect();
  let left = ab.left - cb.left + ab.width / 2 - pop.offsetWidth / 2;
  left = Math.max(8, Math.min(left, cb.width - pop.offsetWidth - 8));
  let top = ab.bottom - cb.top + 8;
  if (top + pop.offsetHeight > cb.height - 4) top = ab.top - cb.top - pop.offsetHeight - 8; // flip above
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.querySelector('.rib-pop-x').onclick = closeRibDetail;
  // Defer the dismiss listeners so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('keydown', ribEsc, true);
    document.addEventListener('click', ribOutside, true);
  }, 0);
}

function statusRow(d) {
  const st = docStatus(d);
  const badge = st ? `<span class="rp-st st-${st}">${esc(st)}</span>` : '';
  return `<div class="rp-doc">${badge}<code>${esc(docName(d))}</code></div>`;
}
function commitDetailHtml(c) {
  const bd = brainDocsOf(c);
  const flags = [c.isMerge ? 'merge' : '', c.isRevert ? 'revert' : ''].filter(Boolean).join(' · ');
  return `<div class="rp-head">commit <code>${esc(c.hash)}</code>${flags ? ` <span class="rp-flag">${esc(flags)}</span>` : ''}</div>
    <div class="rp-sub">${esc(c.subject || '(no subject)')}</div>
    <div class="rp-meta">${esc(fmtShortDT(c.t))}${c.files ? ` · ${c.files} file${c.files === 1 ? '' : 's'} changed` : ''}${bd.length ? ` · ${bd.length} 🧠` : ''}</div>
    ${bd.length ? `<div class="rp-docs">${bd.map(statusRow).join('')}</div>` : ''}`;
}
function brainDetailHtml(c) {
  const bd = brainDocsOf(c);
  return `<div class="rp-head">🧠 brain changed</div>
    <div class="rp-docs">${bd.map(statusRow).join('')}</div>
    <div class="rp-sub">${esc(c.subject || '')}</div>
    <div class="rp-meta">${esc(fmtShortDT(c.t))} · <code>${esc(c.hash)}</code></div>`;
}

// ---------- conversation rendering ----------

// Return from a conversation to the project dashboard (brain + timeline) without
// leaving the project, so live keeps streaming. Previously the only way back was
// out to the workspace, which dropped live and forced re-picking the project.
function backToDashboard() {
  state.session = null;
  renderSessionList(); // drop the active-session highlight in the rail
  renderTimeline();    // re-render the dashboard in place; pollLive now follows it
}

async function selectSession(slug, id, turnIndex = null) {
  // Leaving Drive (if open) for a historical convo: suspend it (keep it resumable)
  // rather than killing it — the session keeps running and stays a "return" handle.
  if (state._driveOpen) suspendDrive();
  // Keep streaming on (if it was) so the reader can *follow* a live conversation.
  state.session = id;
  state._pendingTurn = Number.isFinite(turnIndex) ? turnIndex : null;
  document.querySelectorAll('.sess').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
  document.querySelectorAll('.prompt-row').forEach((n) => n.classList.toggle('active', n.dataset.session === id && Number(n.dataset.turn) === state._pendingTurn));
  const s = await api(`/api/projects/${slug}/sessions/${id}`);
  if (state.session !== id) return; // a newer click won the race
  // Prompt units carry before/prompt/after + the context-fullness gauge — the
  // reader's unit of display. Empty (old server / a session with no typed prompts)
  // just yields an empty reader.
  let units = [];
  try {
    units = await api(`/api/projects/${slug}/sessions/${id}/prompts`);
    if (state.session !== id) return;
  } catch {
    /* old server without /prompts */
  }
  state._session = s;
  state._units = units;
  state._unitsSig = readerUnitsSignature(units);
  renderSessionReader();
}

function renderSessionReader() {
  const s = state._session;
  const units = state._units || [];
  const stats = statsFor(s.messages);
  // Nav follows the prompt cards: one stop per unit, anchored by card ordinal.
  state.turnAnchors = units.map((_, i) => `turn-${i}`);
  const pendingTurn = state._pendingTurn;
  state.currentTurn = Number.isFinite(pendingTurn) && units.length ? Math.max(0, Math.min(units.length - 1, pendingTurn)) : 0;
  const end = endState(s.messages, state.live, s.endedAt ? new Date(s.endedAt).getTime() : 0);
  const dur = fmtDuration(new Date(s.endedAt) - new Date(s.startedAt));
  const filesList = [...stats.files].slice(0, 40);

  const endIcon = endWorking(end.cls) ? '<span class="work-dot" aria-hidden="true"></span>' : '';
  const endMarker = `<div class="end-marker ${end.cls}">${endIcon}${end.text}</div>`;
  const body = units.length
    ? units.map(renderReaderCard).join('') + endMarker
    : '<div class="empty">No prompts in this session.</div>';

  el('#conversation').innerHTML = `
    <div class="conv-toolbar">
      <div class="conv-head">
        <button class="back-dash" data-back-dash title="Back to ${esc(state.projectData.name)} — brain &amp; timeline">← dashboard</button>
        <h2>${esc(s.title)}</h2>
        <div class="meta">
          <span class="badge ${s.source}">${s.source}</span>
          ${fmtDate(s.startedAt)} → ${fmtDate(s.endedAt)} · ${dur} ·
          ${plural(stats.userTurns, 'turn')} · ${plural(stats.toolCalls, 'tool')}
        </div>
        <div class="chips">
          ${statChips(stats)}
          ${stats.files.size ? `<span class="chip files" id="files-toggle">${plural(stats.files.size, 'file')} touched ▾</span>` : ''}
        </div>
        <div class="files-list" id="files-list" hidden>${filesList.map((f) => `<div>${esc(f)}</div>`).join('')}</div>
      </div>
      <div class="nav">
        <button class="live-toggle${state.live ? ' on' : ''}" data-live-toggle title="Follow this conversation — its turns animate in as they land."><span class="live-dot"></span>${state.live ? 'Following' : 'Follow'}<span class="live-ago"></span></button>
        <span class="spacer"></span>
        <button id="nav-prev" title="Previous prompt (k)">◀ prev</button>
        <span id="nav-counter" class="counter"></span>
        <button id="nav-next" title="Next prompt (j)">next ▶</button>
        <button id="nav-final" title="Jump to final reply">⤓ final</button>
        <button id="expand-all">expand all</button>
        <button id="collapse-all">collapse all</button>
      </div>
    </div>
    <div class="conv-body">${body}</div>`;

  el('#conversation').scrollTop = 0;
  wireConversation(units.length);
  if (Number.isFinite(pendingTurn)) {
    requestAnimationFrame(() => {
      const node = document.getElementById(`turn-${state.currentTurn}`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      state._pendingTurn = null;
    });
  }
  const lt = el('#conversation [data-live-toggle]');
  if (lt) lt.onclick = () => { state.live ? stopLive() : startLive(); renderSessionReader(); };
  updateLiveReadout();
}

function readerUnitSignature(u) {
  return JSON.stringify({
    id: u.cardId || u.id || '',
    prompt: u.prompt || '',
    isAck: !!u.isAck,
    context: u.context || null,
    docRefs: u.docRefs || [],
    outcomes: u.outcomes || {},
    evidence: (u.evidence || []).map((e) => [e.label, e.note, e.viewport, e.media, (e.image || '').length]),
    before: u.before || null,
    after: u.after || null,
  });
}

function readerUnitsSignature(units) {
  return (units || []).map(readerUnitSignature).join('|');
}

function readerEndMarker(s) {
  const end = endState(s.messages, state.live, s.endedAt ? new Date(s.endedAt).getTime() : 0);
  const endIcon = endWorking(end.cls) ? '<span class="work-dot" aria-hidden="true"></span>' : '';
  return `<div class="end-marker ${end.cls}">${endIcon}${end.text}</div>`;
}

function refreshSessionToolbar() {
  const toolbar = el('#conversation .conv-toolbar');
  if (!toolbar) return false;
  const s = state._session;
  const stats = statsFor(s.messages);
  const dur = fmtDuration(new Date(s.endedAt) - new Date(s.startedAt));
  const filesList = [...stats.files].slice(0, 40);
  toolbar.innerHTML = `
    <div class="conv-head">
      <button class="back-dash" data-back-dash title="Back to ${esc(state.projectData.name)} — brain &amp; timeline">← dashboard</button>
      <h2>${esc(s.title)}</h2>
      <div class="meta">
        <span class="badge ${s.source}">${s.source}</span>
        ${fmtDate(s.startedAt)} → ${fmtDate(s.endedAt)} · ${dur} ·
        ${plural(stats.userTurns, 'turn')} · ${plural(stats.toolCalls, 'tool')}
      </div>
      <div class="chips">
        ${statChips(stats)}
        ${stats.files.size ? `<span class="chip files" id="files-toggle">${plural(stats.files.size, 'file')} touched ▾</span>` : ''}
      </div>
      <div class="files-list" id="files-list" hidden>${filesList.map((f) => `<div>${esc(f)}</div>`).join('')}</div>
    </div>
    <div class="nav">
      <button class="live-toggle${state.live ? ' on' : ''}" data-live-toggle title="Follow this conversation — its turns animate in as they land."><span class="live-dot"></span>${state.live ? 'Following' : 'Follow'}<span class="live-ago"></span></button>
      <span class="spacer"></span>
      <button id="nav-prev" title="Previous prompt (k)">◀ prev</button>
      <span id="nav-counter" class="counter"></span>
      <button id="nav-next" title="Next prompt (j)">next ▶</button>
      <button id="nav-final" title="Jump to final reply">⤓ final</button>
      <button id="expand-all">expand all</button>
      <button id="collapse-all">collapse all</button>
    </div>`;
  return true;
}

function copyDetailsState(from, to) {
  const oldDetails = from ? [...from.querySelectorAll('details')] : [];
  const newDetails = to ? [...to.querySelectorAll('details')] : [];
  newDetails.forEach((d, i) => { if (oldDetails[i]) d.open = oldDetails[i].open; });
}

function refreshSessionReaderInPlace(oldUnits, newUnits, oldCount, nearBottom, oldScroll) {
  const body = el('#conversation .conv-body');
  if (!body) return false;
  const wasEmpty = body.querySelector('.empty');
  if (wasEmpty && newUnits.length) body.innerHTML = '';
  let marker = body.querySelector('.end-marker');

  for (let i = 0; i < newUnits.length; i++) {
    const existing = document.getElementById(`turn-${i}`);
    const oldSig = oldUnits[i] ? readerUnitSignature(oldUnits[i]) : null;
    const newSig = readerUnitSignature(newUnits[i]);
    if (existing && oldSig === newSig) continue;

    state._readerFresh = i >= oldCount ? new Set([i]) : null;
    const wrap = document.createElement('template');
    wrap.innerHTML = renderReaderCard(newUnits[i], i).trim();
    const next = wrap.content.firstElementChild;
    state._readerFresh = null;
    if (existing) {
      copyDetailsState(existing, next);
      existing.replaceWith(next);
    } else body.insertBefore(next, marker || null);
  }

  for (let i = newUnits.length; ; i++) {
    const stale = document.getElementById(`turn-${i}`);
    if (!stale) break;
    stale.remove();
  }

  const wrap = document.createElement('template');
  wrap.innerHTML = readerEndMarker(state._session).trim();
  const nextMarker = wrap.content.firstElementChild;
  if (marker) marker.replaceWith(nextMarker);
  else body.appendChild(nextMarker);

  if (!newUnits.length) body.innerHTML = '<div class="empty">No prompts in this session.</div>';
  refreshSessionToolbar();
  wireConversation(newUnits.length);
  const lt = el('#conversation [data-live-toggle]');
  if (lt) lt.onclick = () => { state.live ? stopLive() : startLive(); renderSessionReader(); };
  updateLiveReadout();
  const pane = el('#conversation');
  if (pane) pane.scrollTop = nearBottom ? pane.scrollHeight : oldScroll;
  return true;
}

// A live update while reading a session: refetch its prompt units and patch the
// reader in place, so open details and reader scroll state survive follow mode.
async function refreshLiveSession() {
  const slug = state.project;
  const id = state.session;
  let s;
  let units;
  try {
    s = await api(`/api/projects/${slug}/sessions/${id}`);
    units = await api(`/api/projects/${slug}/sessions/${id}/prompts`);
  } catch { return; }
  if (state.session !== id) return;
  const oldCount = (state._units || []).length;
  // Skip a pointless re-render when this session didn't actually change (e.g. the
  // push was a brain-doc edit).
  const sig = readerUnitsSignature(units);
  if (sig === state._unitsSig) return;
  state._unitsSig = sig;
  const oldUnits = state._units || [];
  state._session = s;
  state._units = units;
  const pane = el('#conversation');
  const oldScroll = pane ? pane.scrollTop : 0;
  const nearBottom = pane ? pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 160 : true;
  if (!refreshSessionReaderInPlace(oldUnits, units, oldCount, nearBottom, oldScroll)) {
    renderSessionReader();
    if (pane) pane.scrollTop = nearBottom ? pane.scrollHeight : oldScroll;
  }
}

// A prompt-time context-fullness gauge — how full the model's window was when the
// prompt was sent. ≥75% gets a "dumb zone" warning. Hidden when no usage (Codex).
function contextGauge(ctx) {
  if (!ctx || !ctx.tokens) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  const hot = ctx.pct >= 75;
  const title = `context window ${ctx.pct}% full when this prompt was sent — ${k(ctx.tokens)} / ${k(ctx.window)} tokens${hot ? ' · dumb zone' : ''}`;
  return `<span class="ctx-gauge${hot ? ' hot' : ''}" title="${esc(title)}">
    <span class="ctx-bar"><span class="ctx-fill" style="width:${ctx.pct}%"></span></span>
    <span class="ctx-pct">${ctx.pct}%${hot ? ' ⚠' : ''}</span>
  </span>`;
}

// Intent archetype (classify.js) → a small pill on the card head. Labels mirror
// the 12 PROMPT_GALLERY archetypes; `default` (banal/none) renders nothing.
const ARCH_LABEL = {
  seed: '💡 seed', pickup: '📋 pickup', screenshot: '🎨 redesign', experiment: '🧪 experiment',
  handoff: '🔀 handoff', 'critique-tool': '🔧 critique→tool', positioning: '🧭 positioning',
  options: '🗳 options', spec: '📐 spec', 'console-debug': '🐛 debug', feasibility: '🤔 feasibility',
  'tool-genesis': '✨ tool-genesis',
};
function renderArchetype(a) {
  if (!a || !a.archetype || a.archetype === 'default') return '';
  const label = ARCH_LABEL[a.archetype] || a.archetype;
  const title = `${a.confidence || ''} confidence${a.rationale ? ' — ' + a.rationale : ''}`;
  return `<span class="pc-arch arch-${esc(a.archetype)} conf-${esc(a.confidence || '')}" title="${esc(title)}">${esc(label)}</span>`;
}

function outcomeChips(u, { compact = false } = {}) {
  const o = (u && u.outcomes) || {};
  const chips = [];
  if (o.filesChanged) chips.push(['files', `${o.filesChanged} ${plw(o.filesChanged, 'file')}`, 'files changed by edit tools']);
  if (o.commitsProduced) chips.push(['commit', `${o.commitsProduced} ${plw(o.commitsProduced, 'commit')}`, 'commits produced near this prompt']);
  const brain = Math.max(o.brainDocsChanged || 0, o.brainCommits || 0);
  if (brain) chips.push(['brain', `🧠 ${brain}`, 'brain docs referenced or changed']);
  if (o.commandsRun) chips.push(['cmd', `${o.commandsRun} ${plw(o.commandsRun, 'cmd')}`, 'commands the agent ran']);
  if (o.screenshots) chips.push(['shot', `${o.screenshots} ${plw(o.screenshots, 'shot')}`, 'screenshot evidence attached']);
  if (u && u.attachments && u.attachments.length) {
    const n = u.attachments.length;
    const anyPaste = u.attachments.some((a) => a.kind === 'pasted');
    chips.push(['attach', `${anyPaste ? '📎' : '🖼'} ${n}`, 'images bound to this prompt — pasted in, or screenshots the agent captured during the turn']);
  }
  if (o.contextPct != null) chips.push([o.contextPct >= 75 ? 'hot' : 'ctx', `${o.contextPct}% ctx`, 'context window fullness when the prompt was sent']);
  const max = compact ? 4 : chips.length;
  return chips.length
    ? `<div class="outcome-chips${compact ? ' compact' : ''}">${chips.slice(0, max).map(([cls, label, title]) => `<span class="out-chip ${cls}" title="${esc(title)}">${esc(label)}</span>`).join('')}${chips.length > max ? `<span class="out-chip more">+${chips.length - max}</span>` : ''}</div>`
    : '';
}

// ---------- polymorphic outcome rail (PROJECT_VIEW_PLAN §C) ----------
// The archetype (classify.js) routes a prompt to an *artifact family* and a
// *placement*, the resolved "per-archetype hybrid": rich families get a
// full-width footer panel (wide artifacts want width); the banal majority stays
// a flat chip row. Stage 1 wires the families whose proof is already in the
// bundle — `shot` (captured before/after) and `diff` (the files the turn
// produced). `link`/`record`/`test` route to the flat chips for now: link's real
// proof is the Stage-3 provenance layer (commit→prompt, cross-project), the
// console is already shown verbatim in the prompt body, and record/test artifacts
// (checklist, status timeline) are Stage 2. So nothing regresses — unrouted
// prompts render exactly as before.
const ARCH_FAMILY = {
  screenshot: 'shot', 'critique-tool': 'shot',
  spec: 'diff', pickup: 'diff',
  seed: 'link', handoff: 'link', positioning: 'link', 'tool-genesis': 'link',
  options: 'record', feasibility: 'record',
  experiment: 'test', 'console-debug': 'test',
};
const FAMILY_PLACEMENT = { shot: 'footer', diff: 'footer', link: 'inline', record: 'inline', test: 'chips' };

function railFooter(label, body) {
  return `<div class="outcome-rail rail-footer"><div class="rail-label">${esc(label)}</div>${body}</div>`;
}

// `diff` family: the files the turn actually produced. Real per-edit diffs are a
// separate (deferred) item; here the proof is the deliverable file list, pulled
// from the edit-tool actions in the after-narrative (deduped), with the counts.
function railDiff(u) {
  const paths = [];
  const seen = new Set();
  for (const s of (u.after && u.after.steps) || []) {
    if (s.kind !== 'action') continue;
    const [name, ...rest] = String(s.text).split(': ');
    const path = rest.join(': ').trim();
    if (path && classifyTool(name) === 'edit' && !seen.has(path)) { seen.add(path); paths.push(path); }
  }
  if (!paths.length) return '';
  const o = u.outcomes || {};
  const tail = [
    o.filesChanged ? `${o.filesChanged} ${plw(o.filesChanged, 'file')}` : '',
    o.commitsProduced ? `${o.commitsProduced} ${plw(o.commitsProduced, 'commit')}` : '',
  ].filter(Boolean).join(' · ');
  return `<div class="rail-diff">${paths.slice(0, 6).map((p) => `<span class="rail-file">📄 ${esc(p)}</span>`).join('')}${
    paths.length > 6 ? `<span class="rail-file more">+${paths.length - 6}</span>` : ''
  }${tail ? `<div class="rail-dr">${esc(tail)}</div>` : ''}</div>`;
}

// Stage 2 bespoke renderers, keyed off `u.outcomeArtifact` (prompts.js). These
// are the `test`/`record` families whose proof needs a little extraction.

// Experiment-as-prompt (#4): the author's expected→actual + a verdict pill.
function railExperiment(a) {
  const rows = [
    a.expected ? `<div class="rail-xrow"><span class="rail-xk">expected</span> ${esc(a.expected)}</div>` : '',
    a.actual ? `<div class="rail-xrow"><span class="rail-xk">actual</span> ${esc(a.actual)}</div>` : '',
  ].filter(Boolean).join('');
  const pill = a.verdict
    ? `<span class="rail-pill ${a.verdict === 'FAIL' ? 'fail' : a.verdict === 'PARTIAL' ? 'partial' : 'pass'}">${esc(a.verdict)}</span>`
    : '';
  const result = a.result ? `<span class="rail-xresult">${esc(a.result)}</span>` : '';
  return `${rows}${pill || result ? `<div class="rail-xrow">${pill}${result}</div>` : ''}`;
}

// Test-status timeline (#10/#4): green→red→green dots + a final verdict pill.
function railTest(a) {
  const tl = a.segments.map((s, i) =>
    `${i ? '<span class="rail-seg"></span>' : ''}<span class="rail-dot ${s}"></span>`).join('');
  const pillCls = a.verdict === 'FAIL' ? 'fail' : a.verdict === 'FLAKY' ? 'flaky' : 'pass';
  return `<div class="rail-tl">${tl}</div><div class="rail-tl-meta"><span class="rail-pill ${pillCls}">${esc(a.verdict)}</span>${
    a.label ? `<span class="rail-tl-label">${esc(a.label)}</span>` : ''
  }</div>`;
}

// Options menu (#8): the choices the prompt put on the table, lifted verbatim.
// No ✓/▢ — per-item execution state is deferred (provenance layer), not faked.
function railOptions(a) {
  return `<ul class="rail-opts">${a.items.map((it) =>
    `<li><span class="rail-opt-n">${it.n}</span> ${esc(it.text)}</li>`).join('')}</ul>`;
}

// Route a prompt-unit to its outcome rail. The Stage 2 artifact (when present)
// drives a bespoke marquee; otherwise the Stage 1 family router picks shot/diff;
// otherwise the flat chips + screenshots (today's behavior, no regression).
function renderOutcomeRail(u) {
  const arch = (u.archetype && u.archetype.archetype) || null;
  const family = ARCH_FAMILY[arch] || null;
  const chips = outcomeChips(u);
  const shots = renderArtifacts(u.evidence); // evidence shows whenever captured, any archetype
  const art = u.outcomeArtifact;
  if (art && art.kind === 'experiment') return railFooter('expected → actual', railExperiment(art) + shots + chips);
  if (art && art.kind === 'options') return railFooter('options on the table', railOptions(art) + shots + chips);
  if (family === 'shot' && shots) return railFooter('before / after', shots + chips);
  if (family === 'diff') {
    const body = railDiff(u);
    if (body) return railFooter('deliverable', body + shots + chips);
  }
  if (art && art.kind === 'test') return railFooter('test status', railTest(art) + shots + chips);
  return chips + shots; // link / default / unclassified → flat
}

// One prompt unit as an internal reader card. Acks ("go ahead") collapse to a slim
// connector so the chain stays legible without giving filler a full card.
function renderReaderCard(u, i) {
  const anchor = `turn-${i}`;
  const fresh = state._readerFresh && state._readerFresh.has(i) ? ' card-fresh' : '';
  if (u.isAck) {
    return `<div class="turn rcard-ack${fresh}" id="${anchor}"><span class="ack-arrow">↳ you:</span> <span class="ack-text">${esc(u.prompt)}</span>${contextGauge(u.context)}</div>`;
  }
  const b = u.before;
  const before = b && (b.agent || b.prompt)
    ? `<details class="pc-before"><summary>▸ earlier in this session</summary>
         ${b.prompt ? `<div class="pc-bu">you: ${esc(b.prompt)}</div>` : ''}
         ${b.agent ? `<div class="pc-ba">agent: ${esc(b.agent)}</div>` : ''}
       </details>`
    : '';
  const docs = (u.docRefs || []).map((d) => `<span class="pc-doc">📄 ${esc(d)}</span>`).join('');
  const steps = ((u.after && u.after.steps) || [])
    .map((s) => (s.kind === 'action' ? `<div class="pc-act">$ ${esc(s.text)}</div>` : `<div class="pc-rz">💭 ${esc(s.text)}</div>`))
    .join('');
  const shown = u.after && u.after.steps ? u.after.steps.length : 0;
  const more = u.after && u.after.stepCount > shown ? `<div class="pc-more">+${u.after.stepCount - shown} more</div>` : '';
  const verdict = u.after && u.after.verdict ? `<div class="pc-verdict">${esc(u.after.verdict)}</div>` : '';
  const played = steps || verdict
    ? `<details class="pc-after"><summary>▸ how it played out${u.after.stepCount ? ` · ${u.after.stepCount} steps` : ''}</summary>${steps}${more}${verdict}</details>`
    : '';
  const when = u.ts ? `<span class="pc-when">${fmtTime(u.ts)}</span>` : '';
  const link = u.cardId ? `<a class="pc-link" href="/c/${esc(u.cardId)}" title="permalink" target="_blank" rel="noopener">🔗</a>` : '';
  return `<article class="turn pcard rcard${fresh}" id="${anchor}">
    <div class="pc-head">${renderArchetype(u.archetype)}${docs}${contextGauge(u.context)}${when}</div>
    ${before}
    <div class="pc-prompt">${formatText(u.prompt)}</div>
    ${renderAttachments(u.attachments)}
    ${renderOutcomeRail(u)}
    ${played}
    ${link ? `<div class="pc-bar">${link}</div>` : ''}
  </article>`;
}

// Evidence artifacts (vbrt shot) on a prompt: before/after screenshots the agent
// captured. before/after pairs sit side by side; lone shots stand alone.
function renderArtifacts(evs) {
  if (!evs || !evs.length) return '';
  const isVideo = (e) => e.media === 'video' || /^data:video\//i.test(e.image || '');
  const fig = (e) => {
    const cap = [e.label, e.note, e.viewport].filter(Boolean).join(' · ');
    const media = isVideo(e)
      ? `<video class="art-img" src="${e.image}" autoplay loop muted playsinline data-lightbox="${e.image}" data-media="video" data-cap="${esc(cap)}"></video>`
      : `<img loading="lazy" class="art-img" src="${e.image}" data-lightbox="${e.image}" data-cap="${esc(cap)}" alt="${esc(e.note || e.label || 'screenshot')}">`;
    return `<figure class="art-shot art-${esc(e.label || 'shot')}">
      ${media}
      <figcaption>${e.label ? `<span class="art-tag">${esc(e.label)}</span>` : ''}${e.note ? esc(e.note) : ''}${e.viewport ? `<span class="art-vp">${esc(e.viewport)}</span>` : ''}</figcaption>
    </figure>`;
  };
  return `<div class="pc-artifacts">${evs.map(fig).join('')}</div>`;
}

// Images bound to a prompt: ones the user pasted *in* (kind 'pasted' — input the
// user supplied) and ones the agent's tools returned during the turn (kind 'tool'
// — working screenshots). Distinct from `vbrt shot` evidence (deliberate after-shots);
// these are incidental, the images that actually populate real logs.
function renderAttachments(atts) {
  if (!atts || !atts.length) return '';
  const meta = (k) => (k === 'tool'
    ? { tag: '🖼 agent shot', cap: 'screenshot the agent\'s tools returned during this turn' }
    : { tag: '📎 attached', cap: 'image the user pasted into this prompt' });
  const fig = (a, i) => {
    const m = meta(a.kind);
    return `<figure class="art-shot att-shot att-${esc(a.kind)}">
      <img loading="lazy" class="art-img" src="${a.src}" data-lightbox="${a.src}" data-cap="${esc(m.cap)}" alt="${esc(m.tag)} ${i + 1}">
      <figcaption><span class="art-tag att-tag">${m.tag}</span></figcaption>
    </figure>`;
  };
  return `<div class="pc-artifacts pc-attach">${atts.map(fig).join('')}</div>`;
}

// ---------- media lightbox ----------
// Click any evidence artifact to view it in-page (instead of a raw new tab).
// Images (incl. animated gif) show in <img>; webm clips show in a looping <video>.
function openLightbox(src, caption, media = 'image') {
  let box = el('#lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.innerHTML = `<button class="lb-close" title="Close (Esc)" aria-label="Close">✕</button><figure class="lb-fig"><img alt=""><video style="display:none" controls autoplay loop muted playsinline></video><figcaption></figcaption></figure>`;
    box.addEventListener('click', (ev) => {
      if (ev.target === box || ev.target.classList.contains('lb-close')) closeLightbox();
    });
    document.body.appendChild(box);
  }
  const img = box.querySelector('img');
  const vid = box.querySelector('video');
  if (media === 'video') {
    img.style.display = 'none'; img.removeAttribute('src');
    vid.style.display = ''; vid.src = src;
  } else {
    vid.style.display = 'none'; vid.removeAttribute('src');
    img.style.display = ''; img.src = src;
  }
  const cap = box.querySelector('figcaption');
  cap.textContent = caption || '';
  cap.style.display = caption ? '' : 'none';
  box.classList.add('open');
}
function closeLightbox() {
  const b = el('#lightbox');
  if (!b) return;
  const vid = b.querySelector('video');
  if (vid) { vid.pause(); }
  b.classList.remove('open');
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
document.addEventListener('click', (e) => {
  const node = e.target.closest && e.target.closest('[data-lightbox]');
  if (node) {
    e.preventDefault();
    const media = node.getAttribute('data-media') === 'video' || /^data:video\//i.test(node.getAttribute('data-lightbox') || '') ? 'video' : 'image';
    openLightbox(node.getAttribute('data-lightbox'), node.getAttribute('data-cap') || '', media);
  }
});

// ---------- brain-doc lightbox ----------
// Clicking a brain node opens its doc in a full-screen overlay (modeled on the
// media lightbox above) instead of a cramped in-panel side panel — a doc deserves
// the whole viewport to read. Plan/checklist docs (the ones that carry a completion
// ring) get a bespoke view: the completion broken out cleanly into done vs.
// remaining, with an "expand to full markdown" toggle for the raw doc.

// Parse a checklist doc into sections of checkbox items grouped by the nearest
// heading above them (box regex mirrors completionOf, so the ring and this view
// always agree on what counts).
function parseChecklist(content) {
  const sections = [];
  let cur = { title: null, items: [] };
  const flush = () => { if (cur.items.length) sections.push(cur); };
  for (const raw of String(content || '').split('\n')) {
    const h = raw.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (h) { flush(); cur = { title: h[2].trim(), items: [] }; continue; }
    const box = raw.match(/^[ \t>*+-]*\[([ xX])\]\s*(.*)$/);
    if (box) cur.items.push({ done: /[xX]/.test(box[1]), text: box[2].trim() || '(untitled)' });
  }
  flush();
  return sections.filter((s) => s.items.length);
}

// A small completion ring that echoes the node's own ring, for the plan header.
function ringSvg(pct, size = 56) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const col = pctColor(pct);
  return `<svg class="dl-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#2a2f3c" stroke-width="5"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="${(pct / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="${size / 2}" y="${size / 2}" class="dl-ring-pct" text-anchor="middle" dominant-baseline="central" fill="${col}">${pct}%</text>
  </svg>`;
}

// The lightbox body: a parsed plan view for checklist docs, else the full markdown.
function docLightboxHtml(node) {
  const comp = completionOf(node.content);
  if (!comp) return `<div class="dl-md docview markdown">${renderMarkdown(node.content || '')}</div>`;
  const remaining = comp.total - comp.done;
  const secs = parseChecklist(node.content).map((s) => {
    const done = s.items.filter((i) => i.done).length;
    return `<div class="dl-sec">
      ${s.title ? `<div class="dl-sec-h"><span>${esc(s.title)}</span><span class="dl-sec-n">${done}/${s.items.length}</span></div>` : ''}
      <ul class="dl-checks">${s.items.map((i) =>
        `<li class="dl-check${i.done ? ' done' : ''}"><span class="dl-box">${i.done ? '✓' : '▢'}</span><span class="dl-txt">${esc(i.text)}</span></li>`).join('')}</ul>
    </div>`;
  }).join('');
  return `<div class="dl-plan">
    <div class="dl-summary">${ringSvg(comp.pct)}
      <div class="dl-sum-meta">
        <div class="dl-sum-counts"><b>${comp.done}</b> of ${comp.total} done · ${
          remaining ? `<span class="dl-remaining">${remaining} remaining</span>` : '<span class="dl-alldone">complete</span>'
        }</div>
        <div class="dl-bar"><span style="width:${comp.pct}%;background:${pctColor(comp.pct)}"></span></div>
      </div>
    </div>
    <div class="dl-secs">${secs}</div>
    <button class="dl-expand" data-dl-expand>▸ Expand to full markdown</button>
    <div class="dl-md docview markdown" hidden>${renderMarkdown(node.content || '')}</div>
  </div>`;
}

function openDocLightbox(node) {
  if (!node) return;
  state.docTab = node.name;
  state.docOpen = true; // suppresses hover-peek; the overlay sits above the graph
  let box = el('#doclightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'doclightbox';
    box.innerHTML = '<div class="dl-shell"><div class="dl-head"><span class="dl-title"></span><button class="dl-close" title="Close (Esc)" aria-label="Close">✕</button></div><div class="dl-body"></div></div>';
    box.addEventListener('click', (ev) => {
      if (ev.target === box || ev.target.closest('.dl-close')) { closeDocLightbox(); return; }
      const ex = ev.target.closest('[data-dl-expand]');
      if (ex) {
        const md = box.querySelector('.dl-md');
        if (md.hasAttribute('hidden')) { md.removeAttribute('hidden'); ex.textContent = '▾ Collapse markdown'; }
        else { md.setAttribute('hidden', ''); ex.textContent = '▸ Expand to full markdown'; }
      }
    });
    document.body.appendChild(box);
  }
  box.querySelector('.dl-title').textContent = node.base || node.name;
  box.querySelector('.dl-body').innerHTML = docLightboxHtml(node);
  box.querySelector('.dl-body').scrollTop = 0;
  box.classList.add('open');
}

function closeDocLightbox() {
  const b = el('#doclightbox');
  if (!b) return;
  b.classList.remove('open');
  state.docOpen = false;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDocLightbox(); });

function wireConversation(turnCount) {
  const pane = el('#conversation');
  const updateCounter = () => {
    const c = el('#nav-counter');
    if (c) c.textContent = `turn ${Math.min(state.currentTurn + 1, turnCount)} / ${turnCount}`;
  };
  const goto = (i) => {
    state.currentTurn = Math.max(0, Math.min(turnCount - 1, i));
    const node = document.getElementById(`turn-${state.currentTurn}`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updateCounter();
  };
  updateCounter();

  const backDash = pane.querySelector('[data-back-dash]');
  if (backDash) backDash.onclick = backToDashboard;
  el('#nav-prev').onclick = () => goto(state.currentTurn - 1);
  el('#nav-next').onclick = () => goto(state.currentTurn + 1);
  el('#nav-final').onclick = () => {
    const finals = pane.querySelectorAll('.msg.assistant.final');
    if (finals.length) finals[finals.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  el('#expand-all').onclick = () => pane.querySelectorAll('details').forEach((d) => (d.open = true));
  el('#collapse-all').onclick = () => pane.querySelectorAll('details').forEach((d) => (d.open = false));

  const ft = el('#files-toggle');
  if (ft) ft.onclick = () => {
    const list = el('#files-list');
    list.hidden = !list.hidden;
  };
}

// Keyboard: j/k (or arrows) to move between turns when a session is open.
document.addEventListener('keydown', (e) => {
  if (!state.session) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'j' || e.key === 'ArrowDown') {
    el('#nav-next')?.click();
    e.preventDefault();
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    el('#nav-prev')?.click();
    e.preventDefault();
  }
});

// The signed-in account (session cookie), or null. Doesn't throw.
async function getMe() {
  try {
    const r = await fetch('/api/me');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// Sign-in screen: social providers (from /api/auth/providers) + a machine-token
// fallback (paste the token from `vbrt push`).
async function renderSignIn(msg) {
  showHome();
  let providers = [];
  try {
    providers = ((await (await fetch('/api/auth/providers')).json()).providers) || [];
  } catch {
    /* providers endpoint missing (local/old server) */
  }
  const label = { github: 'Continue with GitHub', google: 'Continue with Google' };
  const btns = providers
    .map((p) => `<a class="signin-btn ${esc(p)}" href="/auth/${esc(p)}/start">${esc(label[p] || 'Continue with ' + p)}</a>`)
    .join('');
  el('#home').innerHTML = `
    <div class="home-wrap">
      <header class="home-head"><h1>Sign in to VibeRate</h1>
        <p class="dim-note">Your private dashboard and the projects you've published.</p></header>
      ${msg ? `<div class="empty">${esc(msg)}</div>` : ''}
      <div class="signin">${btns || '<div class="dim-note">No sign-in providers configured yet.</div>'}</div>
      <details class="signin-token">
        <summary>Use an access token instead</summary>
        <p class="dim-note">Paste the token from <code>vbrt push</code> (in <code>~/.viberate/credentials.json</code>).</p>
        <div class="token-form">
          <input id="token-input" type="password" placeholder="vbrt access token" autocomplete="off" />
          <button id="token-go">View my projects</button>
        </div>
      </details>`;
  const go = () => {
    const v = el('#token-input').value.trim();
    if (!v) return;
    localStorage.setItem('vbrt_token', v);
    location.href = '/app';
  };
  const gb = el('#token-go');
  if (gb) gb.onclick = go;
  const ti = el('#token-input');
  if (ti) ti.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}

// ============================================================================
// Drive — the live agent runtime, folded into the dashboard (was public/drive.html).
// Same server control plane (/api/agent/*, src/agent.js): we spawn the user's real
// `claude` binary, stream its turns over SSE, and let them chat back. This view
// owns #conversation while open; the runtime is the RCE surface, so the entry
// point only appears when ensureDriveProbe() succeeded for this caller.
// ============================================================================

// The durable handle to a driven session. A session keeps running server-side
// while you're away (the child process is spawned per-turn — between turns it's
// just a cheap entry in the agent Map), so we persist enough to reconnect: the
// local session id, its project, the learned claude session id, and the cwd.
// Mirrored to localStorage so it outlives a page reload within the server's life.
const DRIVE_ACTIVE_KEY = 'vbrt_drive_active';
function setDriveActive(d) {
  state.driveActive = d || null;
  try {
    if (state.driveActive) localStorage.setItem(DRIVE_ACTIVE_KEY, JSON.stringify(state.driveActive));
    else localStorage.removeItem(DRIVE_ACTIVE_KEY);
  } catch { /* private mode / quota — the in-memory handle still works this session */ }
  // Mirror into the per-project session log so this session stays resumable even
  // after a newer one supersedes the single active handle above. No-op until the
  // claude session id is learned (the durable, adoptable transcript id).
  if (state.driveActive) recordDriveSession(state.driveActive, state._driveStartPrompt);
}
function driveActivePatch(patch) {
  if (state.driveActive) setDriveActive({ ...state.driveActive, ...patch });
}

// ---- per-project Drive session log -----------------------------------------
// The single active handle above only ever points at the most-recent session, so
// older sessions used to become unreachable (the resume gap Mike hit). This log
// keeps every session you've driven per project, keyed by the durable
// claudeSessionId, so any of them can be re-adopted off its on-disk transcript.
// Scope is this browser (localStorage); a cross-device, server-side index is the
// next slice (ROADMAP "fleet / multi-agent session management").
const DRIVE_SESSIONS_KEY = 'vbrt_drive_sessions';
const DRIVE_SESSIONS_MAX = 40;
function readDriveSessions() {
  try { return JSON.parse(localStorage.getItem(DRIVE_SESSIONS_KEY) || '[]') || []; }
  catch { return []; }
}
function writeDriveSessions(list) {
  try { localStorage.setItem(DRIVE_SESSIONS_KEY, JSON.stringify(list.slice(0, DRIVE_SESSIONS_MAX))); }
  catch { /* private mode / quota — active-handle resume still works */ }
}
// Upsert by claudeSessionId; title is set once (first known prompt) and preserved
// across later touches (status / lastAt bumps).
function recordDriveSession(h, title) {
  if (!h || !h.claudeSessionId) return;
  const list = readDriveSessions();
  const i = list.findIndex((s) => s.claudeSessionId === h.claudeSessionId);
  const prev = i >= 0 ? list[i] : null;
  const rec = {
    claudeSessionId: h.claudeSessionId,
    project: h.project || (prev && prev.project) || null,
    cwd: h.cwd || (prev && prev.cwd) || null,
    permissionMode: h.permissionMode || (prev && prev.permissionMode) || null,
    title: (prev && prev.title) || (title ? String(title).slice(0, 200) : null),
    startedAt: (prev && prev.startedAt) || Date.now(),
    lastAt: Date.now(),
  };
  if (i >= 0) list.splice(i, 1);
  list.unshift(rec);
  writeDriveSessions(list);
}
function listDriveSessions(project) {
  return readDriveSessions()
    .filter((s) => s.claudeSessionId && (s.project || null) === (project || null))
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
function forgetDriveSession(cid) {
  writeDriveSessions(readDriveSessions().filter((s) => s.claudeSessionId !== cid));
}

// Cross-device session index (server-side). The localStorage log above only knows
// sessions this browser drove; the server reads the durable on-disk transcripts in
// the project's workspace, so a session started on a phone is listed here too.
// Cached per-slug so resume/forget can resolve a row that isn't in localStorage.
async function fetchWorkspaceSessions(slug) {
  if (!slug) return [];
  try {
    const j = await driveApi('/workspace/' + encodeURIComponent(slug) + '/sessions');
    return Array.isArray(j.sessions) ? j.sessions : [];
  } catch { return []; } // not set up / not driveable — fall back to the local log only
}
// Merge the per-browser log with the server index, keyed by claudeSessionId. Local
// carries the typed title + chosen permissionMode; the server carries liveId/status
// and catches sessions this device never saw. Newest-active wins on overlap.
function mergeDriveSessions(local, remote, slug) {
  const by = new Map();
  for (const r of remote || []) {
    by.set(r.claudeSessionId, {
      claudeSessionId: r.claudeSessionId,
      project: slug || null,
      cwd: r.cwd || null,
      permissionMode: null,
      title: r.title || null,
      startedAt: r.startedAt || null,
      lastAt: r.lastAt || r.startedAt || 0,
      liveId: r.liveId || null,
      status: r.status || null,
      inLocal: false,
    });
  }
  for (const l of local || []) {
    const ex = by.get(l.claudeSessionId);
    if (ex) {
      ex.inLocal = true;
      if (l.title) ex.title = l.title;
      if (l.permissionMode) ex.permissionMode = l.permissionMode;
      if (l.cwd && !ex.cwd) ex.cwd = l.cwd;
      ex.lastAt = Math.max(ex.lastAt || 0, l.lastAt || 0);
    } else {
      by.set(l.claudeSessionId, { ...l, liveId: null, status: null, inLocal: true });
    }
  }
  return [...by.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}
// Resolve a session row for resume/forget from the merged cache, falling back to
// the localStorage log (covers a resume before the server list has loaded).
function driveSessionRecord(cid) {
  const cached = (state._driveHistory && state._driveHistory.list) || [];
  return cached.find((s) => s.claudeSessionId === cid)
    || readDriveSessions().find((s) => s.claudeSessionId === cid)
    || null;
}
// True for the rail row whose convo is the session we're driving — or have
// suspended but can still resume — in the current project. Such a row badges
// "live" and routes a click back into Drive instead of the read-only reader.
function isActiveDrive(id) {
  const da = state.driveActive;
  return !!(da && id && da.claudeSessionId === id && da.project === state.project);
}
// A rail row is "live" if it's the session open in Drive right now, or the durable
// active handle for this project (suspended, resumable).
function railIsLive(id) {
  return isDrivingSession(id) || isActiveDrive(id);
}

const DRIVE_PERMS = [
  ['bypassPermissions', 'bypassPermissions — run anything, no approvals (DANGER, local only)'],
  ['default', 'default — read/chat only (edits & shell need approval)'],
  ['plan', 'plan — research & propose, no writes'],
  ['acceptEdits', 'acceptEdits — auto-accept file edits'],
];
const DRIVE_PERM_KEY = 'vbrt.drivePerm';

// Compact badge for the live header so the mode is always in view while driving.
function driveModeLabel(mode) {
  return ({
    bypassPermissions: '⚡ bypass',
    acceptEdits: 'auto-edit',
    plan: 'plan',
    default: 'default',
  })[mode] || mode;
}

function driveBanner(msg, kind) {
  const b = el('#dv-banner');
  if (!b) return;
  b.textContent = msg || '';
  b.className = 'dv-banner ' + (kind || '');
  b.classList.toggle('hidden', !msg);
}

// Shared Drive shell — toolbar (title + meta) over a body. Takes over #conversation.
function driveShell(title, metaHtml, bodyHtml) {
  return `
    <div class="dv-wrap">
      <div class="conv-toolbar dv-toolbar">
        <div class="conv-head">
          <button class="back-dash" data-back-dash title="Back to dashboard">← dashboard</button>
          <h2>${title}</h2>
          <div class="meta">${metaHtml}</div>
        </div>
      </div>
      ${bodyHtml}
    </div>`;
}

// Enter Drive for a project: take over #conversation, then gate on the project's
// workspace (the checkout on the host). Ready → prompt form; otherwise → a one-time
// "set up workspace" (clone) step. Stops the bundle live-poll so it can't repaint
// over us (the SSE gives liveness once a session is live).
function openDriveForProject(slug) {
  stopLive();
  if (state._drivePoll) { clearTimeout(state._drivePoll); state._drivePoll = null; }
  if (state._driveCoolPoll) { clearTimeout(state._driveCoolPoll); state._driveCoolPoll = null; }
  state.session = null;
  state._driveOpen = true;
  if (state.drive && state.drive.es) state.drive.es.close();
  state.drive = null;
  state.driveProvisional = null;
  state.driveProject = slug || null;
  el('#conversation').innerHTML = driveShell('✦ Drive', 'checking workspace…', '<div class="dv-body"><div class="empty">Checking workspace…</div></div>');
  el('#conversation').scrollTop = 0;
  wireDriveBackDash();
  if (!slug) return renderDrivePrompt(null, null); // ad-hoc session in the host default cwd
  refreshDriveWorkspace(slug);
}

async function refreshDriveWorkspace(slug) {
  let st;
  try { st = await driveApi('/workspace/' + encodeURIComponent(slug)); }
  catch (e) {
    if (state.driveProject === slug) el('#conversation').innerHTML = driveShell('✦ Drive', 'workspace', `<div class="dv-body"><div class="dv-banner bad">${esc(e.message)}</div></div>`), wireDriveBackDash();
    return;
  }
  if (state.driveProject !== slug || !state._driveOpen) return;
  const ws = st.workspace;
  if (ws && ws.status === 'ready') return renderDrivePrompt(slug, st);
  if (ws && ws.status === 'cloning') return renderDriveCloning(slug, st);
  return renderDriveSetup(slug, st); // none | error
}

// One-time setup: clone the project's repo onto the host volume.
function renderDriveSetup(slug, st) {
  const ws = (st && st.workspace) || {};
  const repo = (ws.repo || (st && st.suggestedRepo) || '');
  const errored = ws.status === 'error';
  el('#conversation').innerHTML = driveShell(
    '✦ Set up workspace',
    `${esc((st && st.name) || slug)} · clone the repo onto the host so the agent can work on it`,
    `<div class="dv-body dv-start">
       <div id="dv-banner" class="dv-banner ${errored ? '' : 'hidden'} ${errored ? 'bad' : ''}">${errored ? esc('Last clone failed: ' + (ws.error || 'unknown error')) : ''}</div>
       <p class="dim-note">This happens once. The checkout lives on the volume and every Drive
         session for this project runs there — no re-cloning per conversation.</p>
       <label for="dv-repo">Git repository</label>
       <input id="dv-repo" value="${esc(repo)}" placeholder="https://github.com/owner/repo.git" />
       <label for="dv-branch">Branch <span class="dim-note">(optional — default branch if blank)</span></label>
       <input id="dv-branch" value="${esc(ws.branch || '')}" placeholder="main" />
       <div class="dv-warn">Private repos need a <code>GITHUB_TOKEN</code> secret on the instance.</div>
       <div class="dv-actions"><button id="dv-clone">Clone &amp; continue</button></div>
     </div>`,
  );
  el('#conversation').scrollTop = 0;
  wireDriveBackDash();
  el('#dv-clone').addEventListener('click', async () => {
    const repoVal = el('#dv-repo').value.trim();
    if (!repoVal) return driveBanner('a repo URL is required', 'bad');
    el('#dv-clone').disabled = true;
    try {
      await drivePost('/workspace/' + encodeURIComponent(slug) + '/setup', { repo: repoVal, branch: el('#dv-branch').value.trim() || undefined });
      renderDriveCloning(slug, { name: st && st.name, workspace: { status: 'cloning', repo: repoVal } });
    } catch (e) { driveBanner(e.message, 'bad'); el('#dv-clone').disabled = false; }
  });
}

// Cloning in progress — poll until the workspace flips to ready/error.
function renderDriveCloning(slug, st) {
  const ws = (st && st.workspace) || {};
  el('#conversation').innerHTML = driveShell(
    '✦ Cloning…',
    `${esc((st && st.name) || slug)} · <code>${esc(ws.repo || '')}</code>`,
    `<div class="dv-body"><div class="dv-cloning"><span class="dv-spin"></span> Cloning the repository onto the host… this can take a moment.</div></div>`,
  );
  wireDriveBackDash();
  if (state._drivePoll) clearTimeout(state._drivePoll);
  state._drivePoll = setTimeout(() => { if (state.driveProject === slug && state._driveOpen) refreshDriveWorkspace(slug); }, 1500);
}

// Ready (or ad-hoc): the first-message form. `st` null → ad-hoc session in the host
// default cwd; otherwise the session runs in the project's bound workspace.
function renderDrivePrompt(slug, st) {
  const ws = (st && st.workspace) || null;
  // Default to the last mode used, falling back to bypassPermissions — Drive is local
  // and unattended, so approvals-required modes just stall the agent waiting on a tap.
  let lastPerm; try { lastPerm = localStorage.getItem(DRIVE_PERM_KEY); } catch { lastPerm = null; }
  if (!DRIVE_PERMS.some(([v]) => v === lastPerm)) lastPerm = 'bypassPermissions';
  const opts = DRIVE_PERMS.map(([v, label]) => `<option value="${v}"${v === lastPerm ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const where = ws
    ? `workspace <code>${esc(ws.dir || '')}</code>${ws.head ? ' · ' + esc(ws.head) : ''}`
    : `host default <code>${esc(state.driveDefaultCwd || '')}</code>`;
  const syncBtn = ws ? '<button id="dv-sync" class="ghost" title="git fetch + reset to the remote tip">Sync</button>' : '';
  el('#conversation').innerHTML = driveShell(
    '✦ New agent session',
    `browser → <code>${esc(state.driveBin || 'claude')}</code> · ${where}`,
    `<div class="dv-body dv-start">
       <div id="dv-banner" class="dv-banner hidden"></div>
       <label for="dv-perm">Permission mode</label>
       <select id="dv-perm">${opts}</select>
       <div class="dv-warn" id="dv-permwarn"></div>
       <label for="dv-prompt">First message</label>
       <textarea id="dv-prompt" placeholder="What should the agent do?"></textarea>
       <div class="dv-actions"><button id="dv-start">Start session</button>${syncBtn}</div>
       ${driveHistoryHtml(slug)}
     </div>`,
  );
  el('#conversation').scrollTop = 0;
  wireDriveBackDash();
  state._driveHistory = null;
  wireDriveHistory(slug);
  if (slug) hydrateDriveHistory(slug); // fold in the cross-device server index
  el('#dv-perm').addEventListener('change', (e) => {
    try { localStorage.setItem(DRIVE_PERM_KEY, e.target.value); } catch { /* private mode / quota */ }
    el('#dv-permwarn').textContent = e.target.value === 'bypassPermissions'
      ? '⚠ The agent can run any shell command and edit any file with no confirmation.' : '';
  });
  el('#dv-perm').dispatchEvent(new Event('change')); // surface the warning for the pre-selected mode
  const start = async () => {
    const prompt = el('#dv-prompt').value.trim();
    if (!prompt) return;
    el('#dv-start').disabled = true;
    state._driveStartPrompt = prompt; // titles the session in the per-project log
    try {
      const body = { prompt, permissionMode: el('#dv-perm').value };
      if (slug) body.projectSlug = slug; else body.cwd = state.driveDefaultCwd || undefined;
      enterDrive(await drivePost('/sessions', body));
    } catch (e) { driveBanner(e.message, 'bad'); el('#dv-start').disabled = false; }
  };
  el('#dv-start').addEventListener('click', start);
  el('#dv-prompt').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') start(); });
  const sync = el('#dv-sync');
  if (sync) sync.addEventListener('click', async () => {
    sync.disabled = true; driveBanner('Syncing…', 'ok');
    try { await drivePost('/workspace/' + encodeURIComponent(slug) + '/sync'); refreshDriveWorkspace(slug); }
    catch (e) { driveBanner(e.message, 'bad'); sync.disabled = false; }
  });
}

// Enter a live driven session: render the transcript shell + composer, open the stream.
function enterDrive(s) {
  state._driveOpen = true;
  state.drive = { id: s.id, status: s.status, claudeSessionId: s.claudeSessionId || null, cwd: s.cwd, permissionMode: s.permissionMode || null, es: null };
  // Record the durable handle so this session is resumable after navigating away.
  // Starting a new session here supersedes any prior active handle for this project.
  setDriveActive({ id: s.id, project: state.driveProject || null, claudeSessionId: s.claudeSessionId || null, cwd: s.cwd, status: s.status, permissionMode: s.permissionMode || null });
  state._driveLive = { text: null, thinking: null };
  renderDriveView();
  driveOpenStream(s.id, 0);
}

function renderDriveView() {
  const d = state.drive;
  driveEndTurn();            // clear any leaked working-timer from a prior session
  state._drivePending = [];  // fresh transcript → no tool calls awaiting a result
  state._driveTurnBlock = null; // fresh transcript → no current turn block yet
  state._driveQueue = [];    // fresh view → no messages waiting on the current turn
  // Flipped flow: the toolbar + composer form a sticky stack at the TOP; the
  // transcript scrolls beneath it with the newest turn first (driveStartTurnBlock
  // prepends). So you type at the top and the latest reply appears right below the box.
  el('#conversation').innerHTML = `
    <div class="dv-wrap">
      <div class="dv-head-stack">
        <div class="conv-toolbar dv-toolbar">
          <div class="conv-head">
            <button class="back-dash" data-back-dash title="Back to dashboard">← dashboard</button>
            <h2>✦ Driving</h2>
            <div class="meta">
              <span class="dv-pill" id="dv-pill">—</span>
              ${(() => { const m = d.permissionMode || (state.driveActive && state.driveActive.permissionMode) || null; return m ? `<span class="dv-mode${m === 'bypassPermissions' ? ' danger' : ''}" title="Permission mode — ${esc(m)}">${esc(driveModeLabel(m))}</span>` : ''; })()}
              <span class="dv-ctx hidden" id="dv-ctx" title="context window used"></span>
              ${(() => { const p = d.cwd || ''; const base = p.split('/').filter(Boolean).pop() || p; return `<code class="dv-cwd" title="${esc(p)}">${esc(base)}</code>`; })()}
              <span class="dim-note">claude: <code id="dv-cid">${esc(d.claudeSessionId || '…')}</code></span>
            </div>
          </div>
        </div>
        <div id="dv-banner" class="dv-banner hidden"></div>
        <div class="dv-composer">
          <div id="dv-status" class="dv-status hidden">
            <span class="dv-spin"></span>
            <span class="dv-status-label" id="dv-status-label">Working…</span>
            <span class="dv-status-meta" id="dv-status-meta"></span>
          </div>
          <div id="dv-queued" class="dv-queued hidden"></div>
          <textarea id="dv-followup" placeholder="Reply to the agent…  (⌘/Ctrl+Enter to send)"></textarea>
          <div class="dv-actions">
            <button id="dv-send">Send</button>
            <button id="dv-stop" class="ghost">Stop turn</button>
            <button id="dv-new" class="ghost">New session</button>
          </div>
        </div>
        <button id="dv-jump" class="dv-jump hidden" title="Jump to the latest activity">↑ new activity</button>
      </div>
      <div class="dv-body"><div id="dv-transcript" class="dv-transcript"></div></div>
    </div>`;
  el('#conversation').scrollTop = 0;
  wireDriveBackDash();
  driveSetStatus(d.status || 'starting');
  el('#dv-send').addEventListener('click', driveSend);
  el('#dv-stop').addEventListener('click', () => state.drive && drivePost('/sessions/' + state.drive.id + '/stop').catch((e) => driveBanner(e.message, 'bad')));
  el('#dv-new').addEventListener('click', () => openDriveForProject(state.driveProject || state.project));
  el('#dv-followup').addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') driveSend(); });
  el('#dv-jump').addEventListener('click', () => driveScroll(true));
  // Sticky-TOP intent (flipped flow): the newest turn is at the top, so we stay glued
  // to the top only while the reader is parked there. Once they scroll down to read
  // history, new activity no longer yanks them up — it surfaces the "new activity" pill
  // instead. The pane (#conversation) is the scroll container; its children get
  // replaced, so the listener (wired once) survives.
  const pane = el('#conversation');
  state._drivePinned = true;
  if (!pane._driveScrollWired) {
    pane._driveScrollWired = true;
    pane.addEventListener('scroll', () => {
      state._drivePinned = pane.scrollTop <= 80;
      if (state._drivePinned) { const j = el('#dv-jump'); if (j) j.classList.add('hidden'); }
    }, { passive: true });
  }
}

async function driveSend() {
  const ta = el('#dv-followup');
  const prompt = ta && ta.value.trim();
  if (!prompt || !state.drive) return;
  // Mid-turn the server rejects a new message ("session is busy"). Rather than
  // block the composer, hold the message and deliver it the moment the turn
  // settles (driveFlushQueue, called from driveSetStatus on idle).
  const busy = driveBusy();
  if (busy) {
    (state._driveQueue = state._driveQueue || []).push(prompt);
    ta.value = '';
    renderDriveQueue();
    return;
  }
  try {
    await drivePost('/sessions/' + state.drive.id + '/message', { prompt });
    ta.value = '';
  } catch (e) { driveBanner(e.message, 'bad'); }
}

function driveBusy() {
  const s = state.drive && state.drive.status;
  return s === 'working' || s === 'starting';
}

// Deliver the next queued message once the agent is idle. Each delivery kicks off
// a new turn (status → working), so the next idle flushes the one after it — the
// queue drains one message per turn, in order. A guard prevents a double-send if
// driveSetStatus fires 'idle' twice before the post's working-status echoes back.
async function driveFlushQueue() {
  if (state._driveFlushing || driveBusy() || !state.drive) return;
  const q = state._driveQueue;
  if (!q || !q.length) return;
  state._driveFlushing = true;
  const prompt = q.shift();
  renderDriveQueue();
  try {
    await drivePost('/sessions/' + state.drive.id + '/message', { prompt });
  } catch (e) {
    driveBanner(e.message, 'bad');
    q.unshift(prompt);      // delivery failed → keep it queued, try again next idle
    renderDriveQueue();
  } finally {
    state._driveFlushing = false;
  }
}

// Paint the pending-message chips above the composer. Each row can be cancelled
// before it's delivered.
function renderDriveQueue() {
  const box = el('#dv-queued');
  if (!box) return;
  const q = state._driveQueue || [];
  if (!q.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="dv-queued-h">Queued · sends when the turn finishes</div>`
    + q.map((m, i) => `<div class="dv-queued-row"><span class="dv-queued-text">${esc(m)}</span><button class="dv-queued-x" data-unqueue="${i}" title="Remove from queue">×</button></div>`).join('');
  box.querySelectorAll('[data-unqueue]').forEach((b) => b.addEventListener('click', () => {
    state._driveQueue.splice(+b.dataset.unqueue, 1);
    renderDriveQueue();
  }));
}

function wireDriveBackDash() {
  const b = el('#conversation [data-back-dash]');
  if (b) b.addEventListener('click', exitDrive);
}

// Suspend Drive: close the live view binding (SSE/poll) and hand #conversation
// back, but KEEP the durable handle (state.driveActive) and the provisional rail
// card. The session keeps running server-side, so the rail + project bar can offer
// "return to Drive". This is what every navigation away from Drive runs.
function suspendDrive() {
  if (state.drive && state.drive.es) state.drive.es.close();
  if (state._drivePoll) { clearTimeout(state._drivePoll); state._drivePoll = null; }
  if (state._driveCoolPoll) { clearTimeout(state._driveCoolPoll); state._driveCoolPoll = null; }
  driveEndTurn(); // stop the working-indicator interval so it can't tick after we leave
  state.drive = null;
  state._driveOpen = false;
}

// Leave Drive for this project's dashboard. The session stays alive + resumable.
function exitDrive() {
  suspendDrive();
  renderSessionList(); // repaint the rail: the live convo is now a "return to Drive" handle
  renderTimeline();
}

// The "Past sessions" list under the new-session form: every Drive session for this
// project, resumable. The single active handle is just the most-recent of these.
// `sessions` is the merged local+server list when available (state._driveHistory),
// else the localStorage-only list for the instant first paint.
function driveHistoryHtml(project, sessions) {
  if (!sessions) sessions = listDriveSessions(project);
  if (!sessions.length) return '';
  const active = state.driveActive && state.driveActive.claudeSessionId;
  const rowHtml = sessions.map((s) => {
    const title = s.title
      ? esc(s.title.length > 90 ? s.title.slice(0, 89) + '…' : s.title)
      : '<span class="dim-note">(no first message captured)</span>';
    const isActive = active && s.claudeSessionId === active;
    const running = s.status === 'running' || s.status === 'thinking';
    // Server-known but not in this browser's log → it ran on another device.
    const elsewhere = s.inLocal === false;
    const tags = [
      isActive ? 'current' : null,
      running ? '<span class="dv-hist-run">● running</span>' : null,
      elsewhere ? '<span class="dim-note" title="Started on another device">⤳ other device</span>' : null,
    ].filter(Boolean);
    // × only forgets the per-browser log entry; a row that's only on the server has
    // nothing here to forget, so we hide it rather than offer a no-op.
    const forget = s.inLocal === false ? ''
      : `<button class="dv-hist-forget" data-forget-cid="${esc(s.claudeSessionId)}" title="Remove from this list (doesn't delete the session)">×</button>`;
    return `<div class="dv-hist-row${isActive ? ' active' : ''}">
       <button class="dv-hist-resume" data-resume-cid="${esc(s.claudeSessionId)}" title="Reconnect to this session and continue it">↻</button>
       <div class="dv-hist-main">
         <div class="dv-hist-title">${title}</div>
         <div class="dv-hist-meta">${esc(fmtAgo(s.lastAt || s.startedAt || Date.now()))}${s.permissionMode ? ' · ' + esc(s.permissionMode) : ''} · <code>${esc((s.claudeSessionId || '').slice(0, 8))}</code>${tags.length ? ' · ' + tags.join(' · ') : ''}</div>
       </div>
       ${forget}
     </div>`;
  });
  // The list grows without bound, so show only the most recent few and tuck the
  // rest behind a native <details> toggle. Hidden rows stay in the DOM, so the
  // resume/forget wiring (which queries all of #conversation) still finds them.
  const SHOWN = 5;
  const head = rowHtml.slice(0, SHOWN).join('');
  const rest = rowHtml.slice(SHOWN);
  const more = rest.length
    ? `<details class="dv-history-more"><summary>${rest.length} older session${rest.length === 1 ? '' : 's'}</summary>${rest.join('')}</details>`
    : '';
  return `<div class="dv-history"><div class="dv-history-h">Past sessions <span class="dim-note">· resume any of them</span></div>${head}${more}</div>`;
}

// After the prompt form paints (from the instant localStorage list), pull the
// server's cross-device index, merge, cache it for resume/forget, and repaint just
// the history block in place. Bails if the user navigated away mid-fetch.
async function hydrateDriveHistory(slug) {
  const remote = await fetchWorkspaceSessions(slug);
  if (state.driveProject !== slug || !state._driveOpen) return;
  const merged = mergeDriveSessions(listDriveSessions(slug), remote, slug);
  state._driveHistory = { slug, list: merged, remote };
  const start = el('#conversation .dv-start');
  if (!start) return;
  const old = start.querySelector('.dv-history');
  const html = driveHistoryHtml(slug, merged);
  if (!html) { if (old) old.remove(); return; }
  if (old) old.outerHTML = html;
  else start.insertAdjacentHTML('beforeend', html);
  wireDriveHistory(slug);
}

// Wire ↻ resume / × forget on the current history rows. Shared by the first paint
// and the post-hydrate repaint so both lists are interactive.
function wireDriveHistory(slug) {
  el('#conversation').querySelectorAll('[data-resume-cid]').forEach((b) =>
    b.addEventListener('click', () => resumeDriveSession(slug, b.dataset.resumeCid)));
  el('#conversation').querySelectorAll('[data-forget-cid]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      forgetDriveSession(b.dataset.forgetCid);
      // Re-merge against the cached server list: a forgotten session that still
      // exists server-side becomes an "other device" row; one that doesn't, drops.
      const remote = (state._driveHistory && state._driveHistory.slug === slug && state._driveHistory.remote) || [];
      const list = mergeDriveSessions(listDriveSessions(slug), remote, slug);
      state._driveHistory = { slug, list, remote };
      const start = el('#conversation .dv-start');
      const old = start && start.querySelector('.dv-history');
      const html = driveHistoryHtml(slug, list);
      if (old) { if (html) old.outerHTML = html; else old.remove(); }
      else if (html && start) start.insertAdjacentHTML('beforeend', html);
      wireDriveHistory(slug);
    }));
}

// Resume an arbitrary past session from the per-project log (not just the active
// handle). Promote its record to the active handle, then run the normal resume path
// — which adopts it by claudeSessionId off the durable transcript when there's no
// live in-memory record.
function resumeDriveSession(slug, cid) {
  const rec = driveSessionRecord(cid);
  if (!rec) return;
  // `liveId` (from the server index) means the in-memory session is still alive in
  // this process — pass it so resumeDrive's fast path reconnects to the live handle
  // instead of re-adopting off the transcript.
  setDriveActive({ id: rec.liveId || null, project: rec.project || slug || null, claudeSessionId: rec.claudeSessionId, cwd: rec.cwd || null, status: 'idle', permissionMode: rec.permissionMode || null });
  resumeDrive(rec.project || slug);
}

// Re-enter a session we drove earlier (or are still driving): rebuild the transcript
// by replaying the server's buffered events from the start, then continue live. The
// session kept running while we were away, so this reconnects rather than restarts.
// If the server no longer knows the id (a redeploy wiped the in-memory Map, or we're
// resuming from the log with no live id), re-adopt by the durable claudeSessionId;
// only a genuinely missing transcript drops back to the read-only reader.
async function resumeDrive(slug) {
  const da = state.driveActive;
  if (!da) return;
  stopLive(); // the SSE gives liveness once we're connected; don't let the poll repaint over us
  if (state._drivePoll) { clearTimeout(state._drivePoll); state._drivePoll = null; }
  if (state._driveCoolPoll) { clearTimeout(state._driveCoolPoll); state._driveCoolPoll = null; }
  state.session = null;
  state._driveOpen = true;
  state.driveProject = da.project || slug || null;
  el('#conversation').innerHTML = driveShell('✦ Drive', 'reconnecting…', '<div class="dv-body"><div class="empty">Reconnecting to your session…</div></div>');
  wireDriveBackDash();
  let s = null;
  // Fast path: a live in-memory record (same-process reload). Skipped when resuming
  // from the log, where there's no local id — go straight to adopt below.
  if (da.id) {
    try { s = await driveApi('/sessions/' + encodeURIComponent(da.id)); }
    catch { s = null; }
  }
  if (!s) {
    // No live record. The claude session itself is durable on disk, so re-adopt it
    // by id — the `/resume` analogue: the server replays the saved transcript and
    // rebinds a fresh local handle so the conversation is revived and can continue.
    if (da.claudeSessionId) {
      try {
        s = await drivePost('/sessions/adopt', {
          claudeSessionId: da.claudeSessionId,
          cwd: da.cwd,
          projectSlug: da.project,
          permissionMode: da.permissionMode,
        });
      } catch {
        // Truly unrecoverable (no transcript on disk). Drop the handle and show the
        // read-only ingested convo instead of an empty Drive.
        setDriveActive(null);
        state._driveOpen = false;
        state.driveProvisional = null;
        return selectSession(slug, da.claudeSessionId);
      }
    } else {
      setDriveActive(null);
      state._driveOpen = false;
      state.driveProvisional = null;
      return exitDrive();
    }
  }
  if (!state._driveOpen) return; // navigated away mid-fetch
  setDriveActive({ id: s.id, project: state.driveProject, claudeSessionId: s.claudeSessionId || da.claudeSessionId || null, cwd: s.cwd || da.cwd, status: s.status, permissionMode: s.permissionMode || da.permissionMode || null });
  state.drive = { id: s.id, status: s.status, claudeSessionId: s.claudeSessionId || da.claudeSessionId || null, cwd: s.cwd || da.cwd, permissionMode: s.permissionMode || da.permissionMode || null, es: null };
  state._driveLive = { text: null, thinking: null };
  renderDriveView();
  driveOpenStream(s.id, 0); // after=0 → replay the buffered transcript, then live
}

function driveSetStatus(status) {
  if (state.drive) state.drive.status = status;
  driveActivePatch({ status });
  const pill = el('#dv-pill');
  if (pill) { pill.textContent = status; pill.className = 'dv-pill ' + status; }
  const send = el('#dv-send'); const stop = el('#dv-stop');
  const busy = status === 'working' || status === 'starting';
  // Keep Send enabled while busy so a follow-up can be queued mid-turn; it just
  // relabels to "Queue" to signal the message will land after the current turn.
  if (send) { send.disabled = false; send.textContent = busy ? 'Queue' : 'Send'; }
  if (stop) stop.disabled = !busy;
  // The composer footer carries the "Claude is working…" indicator (spinner +
  // live activity label + elapsed + token estimate). Show it while a turn is in
  // flight; hide it the moment the turn settles.
  if (busy) { driveStartTurn(); driveStatusLabel(status === 'starting' ? 'Starting…' : 'Working…'); }
  else driveEndTurn();
  // Turn settled → deliver the next queued message (no-op if the queue is empty).
  if (status === 'idle') driveFlushQueue();
}

// ---- working indicator (elapsed + live token estimate) ----
function driveStartTurn() {
  const f = el('#dv-status'); if (f) f.classList.remove('hidden');
  if (state._driveTurn) return; // already counting this turn
  state._driveTurn = { start: Date.now(), outChars: 0, timer: setInterval(driveTickStatus, 1000) };
  driveTickStatus();
}
function driveEndTurn() {
  const tn = state._driveTurn;
  if (tn && tn.timer) clearInterval(tn.timer);
  state._driveTurn = null;
  const f = el('#dv-status'); if (f) f.classList.add('hidden');
}
function driveTickStatus() {
  const tn = state._driveTurn; const meta = el('#dv-status-meta');
  if (!tn || !meta) return;
  const secs = Math.round((Date.now() - tn.start) / 1000);
  const tok = tn.outChars ? ' · ≈' + driveFmtTok(Math.round(tn.outChars / 4)) + ' tok' : '';
  meta.textContent = driveFmtElapsed(secs) + tok;
}
function driveStatusLabel(text) { const l = el('#dv-status-label'); if (l) l.textContent = text; }
function driveBumpOut(n) { if (state._driveTurn) state._driveTurn.outChars += n; }

function driveFmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
function driveFmtElapsed(s) { return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'; }

// Context-window meter: the input side of the turn's usage (fresh + cache) is the
// context the model saw; show it as tokens + % of the window (mirrors the convos
// live pill / src/parsers.js). The window is 200k, or 1M for a [1m] model.
function driveCtxWindow(model) {
  const m = String(model || '').toLowerCase();
  return (m.includes('[1m]') || m.includes('-1m')) ? 1_000_000 : 200_000;
}
function driveUpdateCtx(ev) {
  const u = ev.usage || {};
  const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const c = el('#dv-ctx');
  if (!c || !ctx) return;
  const model = (state.drive && state.drive.model) || null;
  const win = driveCtxWindow(model);
  const pct = Math.min(100, Math.round((ctx / win) * 100));
  c.textContent = `◔ ${driveFmtTok(ctx)} · ${pct}%`;
  c.title = `context window used — ${ctx.toLocaleString()} / ${win.toLocaleString()} tokens${model ? ' · ' + model : ''}${pct >= 75 ? ' · getting full' : ''}`;
  c.classList.toggle('hot', pct >= 75);
  c.classList.remove('hidden');
}

// Turn-complete summary line: duration + token usage (exact, from the result event)
// + step count + cost (when billed). Cache reads fold into the input total.
function driveResultMeta(ev) {
  const u = ev.usage || {};
  const out = u.output_tokens;
  const inp = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return [
    ev.isError ? 'error' : 'ok',
    ev.durationMs != null ? (ev.durationMs / 1000).toFixed(1) + 's' : null,
    out != null ? driveFmtTok(out) + ' tok out' : null,
    inp ? driveFmtTok(inp) + ' tok in' : null,
    ev.numTurns != null ? ev.numTurns + ' steps' : null,
    ev.costUsd != null ? '$' + ev.costUsd.toFixed(4) : null,
  ].filter(Boolean).join(' · ');
}

// Flipped flow: the newest turn is at the TOP, so "keep up with activity" means
// staying at scrollTop 0. `force` (the jump pill / explicit sends) always snaps to
// the top. Otherwise, if they've scrolled down to read history, surface the "new
// activity" pill instead of yanking them around.
function driveScroll(force) {
  const c = el('#conversation'); if (!c) return;
  if (force || state._drivePinned) {
    c.scrollTop = 0;
    // Mobile scrolls the document (not the pane), so an explicit snap also pulls the
    // window up so the just-sent message + forming reply sit under the sticky composer.
    if (force && document.body.classList.contains('is-mobile')) window.scrollTo({ top: 0 });
    state._drivePinned = true;
    const j = el('#dv-jump'); if (j) j.classList.add('hidden');
  } else {
    const j = el('#dv-jump'); if (j) j.classList.remove('hidden');
  }
}

// Append a transcript bubble (user / assistant / thinking-fallback / sys / result).
// `bodyText` is plain text (set via textContent so streamed deltas can append
// safely); returns the element for live filling.
// Flipped flow: each user turn is its own block, prepended so the newest turn sits
// at the TOP (just under the composer). Events are prepended *within* a block too
// (drivePlace), so the live activity — the forming assistant reply, tool chips,
// thinking — always lands right under the composer instead of streaming downward
// off-screen. Both axes reversed ⇒ the whole transcript reads newest-first with the
// oldest at the bottom. Streaming deltas and tool results fill their bubble in place
// (only the moment of insertion is reversed), so any single bubble still reads
// normally. Pre-turn events (system banner on connect) fall back to the transcript
// root and, being oldest, settle at the bottom.
function driveContainer() {
  return state._driveTurnBlock || el('#dv-transcript');
}
function drivePlace(t, node) {
  t.insertBefore(node, t.firstChild); // prepend → newest event on top
}
function driveStartTurnBlock() {
  const t = el('#dv-transcript'); if (!t) return;
  const block = document.createElement('div');
  block.className = 'dv-turn';
  t.insertBefore(block, t.firstChild); // prepend → newest turn on top
  state._driveTurnBlock = block;
}
function driveAddEv(cls, who, bodyText) {
  const t = driveContainer();
  if (!t) return null;
  const div = document.createElement('div');
  div.className = 'dv-ev ' + cls;
  if (who) { const h = document.createElement('div'); h.className = 'dv-who'; h.textContent = who; div.appendChild(h); }
  if (bodyText != null) {
    const b = document.createElement('div'); b.className = 'dv-body-t';
    // Assistant prose is rendered as markdown (tables / code / lists / bold);
    // everything else stays plain text. `_md` flags a bubble for re-render on
    // streamed deltas; the raw markdown accumulates in `_raw`.
    if (cls.indexOf('assistant') !== -1) { b._md = true; b._raw = bodyText; driveRenderMd(b); }
    else b.textContent = bodyText;
    div.appendChild(b);
  }
  drivePlace(t, div);
  driveScroll();
  return div;
}
function driveAppend(elm, text) {
  if (!elm) return;
  const b = elm.querySelector('.dv-body-t');
  if (b && b._md) { b._raw = (b._raw || '') + text; driveScheduleMd(b); }
  else if (b) b.textContent += text;
  driveScroll();
}
// Render a bubble's accumulated markdown to HTML + wire copy buttons on code.
function driveRenderMd(b) {
  b.innerHTML = renderMarkdown(b._raw || '');
  b.querySelectorAll('pre.md-code').forEach((pre) => {
    const code = pre.textContent;
    const btn = document.createElement('button');
    btn.className = 'dv-copy'; btn.type = 'button'; btn.textContent = 'copy';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200);
      }).catch(() => {});
    });
    pre.appendChild(btn);
  });
}
// Coalesce re-renders during streaming to one per frame (a delta arrives per token).
function driveScheduleMd(b) {
  if (b._mdPending) return;
  b._mdPending = true;
  requestAnimationFrame(() => { b._mdPending = false; driveRenderMd(b); });
}

// ---- compact tool chips (Claude-code style) ----
// A tool call collapses to a single line: a verb + target + status dot, with the
// full input/result tucked behind a tap. This is the main cure for the "waterfall
// of tool output" — the high-level "Claude is doing X" stays visible; the detail
// is one tap away.
const DRIVE_VERB = { read: 'Read', edit: 'Edit', cmd: 'Run', search: 'Search', web: 'Fetch', other: '' };
function driveToolDisplay(name, input, cat) {
  const inp = (input && typeof input === 'object') ? input : {};
  const tail = (p) => String(p).split('/').slice(-2).join('/');
  const clip = (s, n = 90) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  let verb = DRIVE_VERB[cat] || name.replace(/^mcp__/, '').replace(/__/g, '·');
  let target = '';
  if (cat === 'read' || cat === 'edit') { verb = /write|create/.test((name || '').toLowerCase()) ? 'Write' : verb; target = inp.file_path || inp.path || inp.notebook_path ? tail(inp.file_path || inp.path || inp.notebook_path) : ''; }
  else if (cat === 'cmd') target = clip(inp.command || inp.cmd || '');
  else if (cat === 'search') target = clip(inp.pattern || inp.query || inp.glob || inp.path || '');
  else if (cat === 'web') target = clip(inp.url || inp.query || '');
  else target = clip(inp.description || inp.path || inp.file_path || '');
  return { verb, target };
}
function drivePrettyInput(input) {
  try { return typeof input === 'string' ? input : JSON.stringify(input, null, 2); }
  catch { return String(input); }
}
function driveResultSummary(text, isError) {
  const s = String(text == null ? '' : text);
  if (isError) { const f = s.split('\n').find((l) => l.trim()) || 'error'; return f.length > 60 ? f.slice(0, 60) + '…' : f; }
  if (!s.trim()) return 'done';
  const lines = s.split('\n');
  const nonEmpty = lines.filter((l) => l.trim()).length;
  if (nonEmpty > 1) return nonEmpty + ' lines';
  const first = (lines.find((l) => l.trim()) || '').trim();
  return first.length > 60 ? first.slice(0, 60) + '…' : first;
}
function driveAddTool(ev) {
  const t = driveContainer(); if (!t) return null;
  const cat = classifyTool(ev.name);
  const { verb, target } = driveToolDisplay(ev.name, ev.input, cat);
  driveStatusLabel((verb + ' ' + target).trim() || ev.name);
  const row = document.createElement('div');
  row.className = 'dv-tool ' + cat + ' pending';
  const line = document.createElement('div'); line.className = 'dv-tool-line';
  line.innerHTML = `<span class="dv-tool-dot"></span><span class="dv-tool-verb"></span><span class="dv-tool-target"></span><span class="dv-tool-sum"></span><span class="dv-tool-exp">▸</span>`;
  line.querySelector('.dv-tool-verb').textContent = verb;
  line.querySelector('.dv-tool-target').textContent = target;
  row.appendChild(line);
  const detail = document.createElement('div'); detail.className = 'dv-tool-detail hidden';
  const pre = document.createElement('pre'); pre.className = 'dv-tool-in'; pre.textContent = drivePrettyInput(ev.input);
  detail.appendChild(pre);
  row.appendChild(detail);
  line.addEventListener('click', () => { detail.classList.toggle('hidden'); row.classList.toggle('open'); });
  drivePlace(t, row);
  (state._drivePending || (state._drivePending = [])).push({ id: ev.id || null, row });
  driveScroll();
  return row;
}
function driveAttachToolResult(ev) {
  const q = state._drivePending || [];
  let idx = ev.toolUseId ? q.findIndex((p) => p.id === ev.toolUseId) : -1;
  if (idx < 0) idx = 0; // no id (older buffer) or unmatched → oldest pending
  const pending = q.splice(idx, 1)[0];
  if (!pending) { // orphan result — show it as a standalone compact chip
    driveAddEv('toolresult' + (ev.isError ? ' err' : ''), ev.isError ? 'tool error' : 'tool result', driveResultSummary(ev.text, ev.isError));
    return;
  }
  const row = pending.row;
  row.classList.remove('pending');
  row.classList.add(ev.isError ? 'err' : 'ok');
  const sum = row.querySelector('.dv-tool-sum');
  if (sum) sum.textContent = driveResultSummary(ev.text, ev.isError);
  const out = document.createElement('pre'); out.className = 'dv-tool-out' + (ev.isError ? ' err' : '');
  out.textContent = ev.text || '(no output)';
  row.querySelector('.dv-tool-detail').appendChild(out);
  driveScroll();
}

// ---- collapsible thinking (live while streaming, tucked to a preview after) ----
function driveAddThink(text) {
  const t = driveContainer(); if (!t) return null;
  const row = document.createElement('div');
  row.className = 'dv-think open';
  const line = document.createElement('div'); line.className = 'dv-think-line';
  line.innerHTML = `<span class="dv-think-ico">✦</span><span class="dv-think-tag">thinking</span><span class="dv-tool-exp">▾</span>`;
  const body = document.createElement('div'); body.className = 'dv-think-body';
  if (text != null) body.textContent = text;
  row.appendChild(line); row.appendChild(body);
  line.addEventListener('click', () => row.classList.toggle('open'));
  drivePlace(t, row);
  driveScroll();
  return row;
}
function driveAppendThink(row, text) {
  if (!row) return;
  row.querySelector('.dv-think-body').textContent += text;
  driveScroll();
}

// The inline picker (the agent called mcp__viberate__ask). Build a choice card;
// on submit, POST the selections so the parked tool call returns and the turn continues.
function driveRenderAsk(ev) {
  const t = driveContainer();
  if (!t) return;
  const qs = ev.questions || [];
  const card = document.createElement('div');
  card.className = 'dv-ev dv-ask';
  card.dataset.askId = ev.askId;
  const who = document.createElement('div'); who.className = 'dv-who'; who.textContent = '❓ agent asks'; card.appendChild(who);
  qs.forEach((q, qi) => {
    const block = document.createElement('div'); block.className = 'dv-askq';
    const title = document.createElement('div'); title.className = 'dv-askq-title';
    title.textContent = (q.header ? '[' + q.header + '] ' : '') + (q.question || '');
    block.appendChild(title);
    const type = q.multiSelect ? 'checkbox' : 'radio';
    (q.options || []).forEach((opt) => {
      const lab = document.createElement('label'); lab.className = 'dv-askopt';
      const inp = document.createElement('input');
      inp.type = type; inp.name = 'ask-' + ev.askId + '-' + qi; inp.value = opt.label;
      const span = document.createElement('span'); span.textContent = opt.label;
      if (opt.description) { const dd = document.createElement('span'); dd.className = 'dv-desc'; dd.textContent = ' — ' + opt.description; span.appendChild(dd); }
      lab.appendChild(inp); lab.appendChild(span); block.appendChild(lab);
    });
    const otherWrap = document.createElement('div'); otherWrap.className = 'dv-askother';
    const other = document.createElement('input');
    other.type = 'text'; other.placeholder = 'Other…'; other.dataset.qi = String(qi);
    otherWrap.appendChild(other); block.appendChild(otherWrap);
    card.appendChild(block);
  });
  const btn = document.createElement('button'); btn.textContent = 'Answer';
  const actions = document.createElement('div'); actions.className = 'dv-actions'; actions.appendChild(btn);
  card.appendChild(actions);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const selections = qs.map((q, qi) => {
      const picked = [...card.querySelectorAll('input[name="ask-' + ev.askId + '-' + qi + '"]:checked')].map((i) => i.value);
      const other = card.querySelector('.dv-askother input[data-qi="' + qi + '"]');
      const customText = other && other.value.trim() ? other.value.trim() : undefined;
      return { header: q.header, question: q.question, selectedLabels: picked, customText };
    });
    try {
      await drivePost('/sessions/' + state.drive.id + '/answer', { askId: ev.askId, selections });
    } catch (e) { driveBanner(e.message, 'bad'); btn.disabled = false; }
  });
  drivePlace(t, card);
  driveScroll();
}

function driveMarkAskResolved(ev) {
  const card = el('#dv-transcript .dv-ask[data-ask-id="' + ev.askId + '"]');
  if (!card || card.classList.contains('answered')) return;
  card.classList.add('answered');
  card.querySelectorAll('input, button').forEach((e) => { e.disabled = true; });
  const status = document.createElement('div'); status.className = 'dv-askstatus';
  status.textContent = ev.timedOut ? '⏱ no answer in time — agent proceeding' : '✓ answered';
  card.appendChild(status);
}

// Reset the streaming block handles. Thinking is ephemeral: we stream it live so you
// can watch the agent reason, but we don't leave a collapsed block littering the flow
// between every reply and tool call — the status spinner ("Thinking…") already marks
// that a turn is mid-thought. So `block_stop` (and every turn boundary) removes the
// live thinking element outright rather than tucking it to a persistent preview.
function driveResetLive() {
  const L = state._driveLive;
  if (L && L.thinking) L.thinking.remove();
  state._driveLive = { text: null, thinking: null };
}

// One normalized agent event → the transcript. Tool calls collapse to compact
// chips; thinking streams live then clears at the turn boundary; the working footer
// tracks live activity.
function driveRender(ev) {
  const L = state._driveLive;
  switch (ev.kind) {
    case 'user_prompt': driveResetLive(); driveStartTurnBlock(); driveAddEv('user', 'you', ev.text); driveScroll(true); driveBumpOut(0); setDriveProvisional({ prompt: ev.text, status: 'working' }); break;
    case 'assistant_text': driveBumpOut((ev.text || '').length); driveAddEv('assistant', 'claude', ev.text); break;
    case 'thinking': { if (L.thinking) L.thinking.remove(); L.thinking = driveAddThink(ev.text); break; } // ephemeral: cleared at the next turn boundary
    case 'assistant_text_start': driveStatusLabel('Writing…'); L.text = driveAddEv('assistant', 'claude', ''); break;
    case 'assistant_text_delta':
      if (!L.text) L.text = driveAddEv('assistant', 'claude', '');
      driveBumpOut((ev.text || '').length); driveAppend(L.text, ev.text); break;
    case 'thinking_start': driveStatusLabel('Thinking…'); L.thinking = driveAddThink(''); break;
    case 'thinking_delta':
      if (!L.thinking) L.thinking = driveAddThink('');
      driveBumpOut((ev.text || '').length); driveAppendThink(L.thinking, ev.text); break;
    case 'block_stop': driveResetLive(); break;
    case 'tool_use':
      driveResetLive();
      // Brain↔chat live link (PLAN_MOBILE.md Slice 3): a Write/Edit/Read of a brain
      // doc glows its node + header chip. Reads the tool_use the runtime already
      // emits — no extra capture. No-op when no matching brain node is on screen.
      { const f = toolFile(ev); if (f && window.mobileBrainTouch) window.mobileBrainTouch(f, classifyTool(ev.name)); liveBrain.feed(ev.name, f); }
      if (ev.name === 'mcp__viberate__ask') break; // renders as the picker via the 'ask' event
      driveAddTool(ev); break;
    case 'tool_result': driveAttachToolResult(ev); break;
    case 'ask': driveResetLive(); driveRenderAsk(ev); break;
    case 'ask_resolved': driveMarkAskResolved(ev); break;
    case 'result':
      driveResetLive();
      driveEndTurn();
      liveBrain.idle();
      driveAddEv('result', ev.isError ? 'turn failed' : 'turn complete', driveResultMeta(ev));
      driveUpdateCtx(ev);
      driveCoolProvisional(); break;
    case 'system':
      if (state.drive && ev.model) state.drive.model = ev.model;
      driveAddEv('sys', 'session', 'model ' + (ev.model || '?') + (ev.tools != null ? ' · ' + ev.tools + ' tools' : ''));
      if (ev.sessionId) { if (state.drive) state.drive.claudeSessionId = ev.sessionId; driveActivePatch({ claudeSessionId: ev.sessionId }); const c = el('#dv-cid'); if (c) c.textContent = ev.sessionId; setDriveProvisional({ sessionId: ev.sessionId }); } break;
    case 'error': driveAddEv('error', 'error', ev.message); break;
    case 'note': driveResetLive(); driveAddEv('sys', 'session', ev.text); break;
    case 'stopped': driveAddEv('sys', 'session', 'stopped by user'); break;
    case 'status': driveSetStatus(ev.status); break;
    // 'raw', 'turn_end' intentionally not rendered.
  }
}

// Open the live SSE transcript stream. `after` is the seq high-water mark to
// backfill past (0 = from the start, into a freshly-cleared transcript).
//
// The transcript MUST be idempotent: a dropped EventSource auto-reconnects, and
// mobile Safari freezes/kills the socket whenever the tab is backgrounded. The
// server now tags frames with `id: <seq>` so the native reconnect resumes via
// `Last-Event-ID`, but we also track `state.drive.lastSeq` and drop any event at
// or below it — so even a proxy that strips the header (or a manual resync) can't
// double-append the log. See DRIVE_LIVE_STREAM_DUP.md.
function driveOpenStream(id, after) {
  if (state.drive && state.drive.es) state.drive.es.close();
  if (state.drive) state.drive.lastSeq = after || 0;
  const es = new EventSource('/api/agent/sessions/' + id + '/stream?after=' + (after || 0));
  es.onmessage = (m) => {
    if (!state.drive || state.drive.id !== id) return;
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    // Drop anything we've already rendered. Guards against reconnect-replay
    // (the bug) without depending on Last-Event-ID surviving the proxy hop.
    if (ev.seq != null) {
      if (ev.seq <= (state.drive.lastSeq || 0)) return;
      state.drive.lastSeq = ev.seq;
    }
    driveRender(ev);
  };
  es.addEventListener('error', () => {/* EventSource auto-reconnects with Last-Event-ID */});
  if (state.drive) state.drive.es = es;
  wireDriveVisibilityResync();
}

// iOS Safari does not reliably fire `error` on a socket it froze while the tab was
// backgrounded, so the native auto-reconnect may never fire on return. On
// foreground, proactively tear down and reopen the stream from our high-water seq:
// the backfill fills only the gap, and the seq dedup makes a redundant resync a
// no-op. Wired once for the page lifetime.
function wireDriveVisibilityResync() {
  if (window._driveVisWired) return;
  window._driveVisWired = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state._driveOpen || !state.drive || !state.drive.id) return;
    driveOpenStream(state.drive.id, state.drive.lastSeq || 0);
  });
}

// ---------- live brain (Drive view centerpiece) ----------
// A force-simulated graph driven straight off the Drive SSE stream. Brain docs
// (SOUL/CLAUDE/plans/memory) are seeded as persistent core/orbit nodes; every
// code file the agent touches flares into an *ephemeral* node that swells when
// edited (pulled to the core) and cools + drifts to the rim + fades out once the
// agent moves on — recency-as-physics, mobile-first, no 3D. Fed by driveRender's
// tool_use branch via liveBrain.feed(toolName, filePath); plan ticks pulse the
// plan nodes; the hero ring reflects aggregate plan completion from the docGraph.
const liveBrain = (() => {
  const SVGNS = 'http://www.w3.org/2000/svg';
  const W = 380, H = 300, CX = W / 2, CY = H / 2;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLOR = { doc: '#a978ff', mem: '#2ecf8f', plan: '#2ecf8f', code: '#5aa9e6', hot: '#ff9d5c', read: '#3fc6e0', run: '#2ecf8f' };

  let svg = null, layers = null, raf = null;
  let refs = {};                  // hero/ticker DOM refs grabbed on attach
  const nodes = new Map();        // key (basename, lowercased) -> node
  const els = new Map();          // key -> { g, dot, glow, ring, prog, label }
  let edges = [];
  let plans = {};                 // node id -> { done, total }

  const baseKey = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  const baseLabel = (p) => String(p).split(/[\\/]/).pop();
  const baseColor = (n) => COLOR[n.kind] || COLOR.code;

  // tool name -> visual verb. Reads (read/grep/glob/search/web/other) are a light
  // pulse; writes/edits run hot; bash ripples; plan tools tick the plan rings.
  function verbFor(name) {
    const n = (name || '').toLowerCase();
    if (/update_plan|todowrite|exit_plan|plan_mode/.test(n)) return 'plan';
    if (/write|create/.test(n)) return 'write';
    if (/edit|apply_patch|patch|notebook|multiedit/.test(n)) return 'edit';
    if (/bash|exec|shell|\brun\b|command|terminal/.test(n)) return 'run';
    return 'read';
  }

  function addNode(spec) {
    if (nodes.has(spec.id)) return nodes.get(spec.id);
    const ang = Math.random() * Math.PI * 2;
    const spawnR = spec.core ? 28 : (spec.kind === 'code' ? 130 : 88);
    const n = { x: CX + Math.cos(ang) * spawnR, y: CY + Math.sin(ang) * spawnR, vx: 0, vy: 0, heat: 0, flash: 0, flashKind: 'read', fade: 0, ...spec };
    nodes.set(n.id, n);
    return n;
  }

  // Seed persistent brain-doc nodes from the live doc graph (skip archived ghosts).
  function seed() {
    nodes.clear(); els.clear(); edges = []; plans = {};
    const g = ((state.docGraph && state.docGraph.nodes) || []).filter((n) => !n.archived);
    for (const d of g) {
      const isMem = d.role === 'memory' || /(^|\/)memory\//i.test(d.name || '');
      const hasPlan = !!(d.completion && d.completion.total);
      const kind = hasPlan ? 'plan' : isMem ? 'mem' : 'doc';
      const core = d.role === 'constitution';
      const spec = { id: baseKey(d.name), label: d.base || baseLabel(d.name), kind, core, r: core ? 12 : hasPlan ? 11 : 9, path: d.name };
      if (hasPlan) { spec.plan = spec.id; plans[spec.id] = { done: d.completion.done, total: d.completion.total }; }
      addNode(spec);
    }
    // A light backbone so the force layout has structure: hang every orbit node off
    // the first constitution core, and chain the cores together.
    const cores = [...nodes.values()].filter((n) => n.core);
    if (cores.length) {
      for (let i = 1; i < cores.length; i++) edges.push({ a: cores[i - 1].id, b: cores[i].id });
      for (const n of nodes.values()) if (!n.core) edges.push({ a: n.id, b: cores[0].id });
    }
    renderHero();
  }

  let activePlan = null;
  function touch(verb, file) {
    if (!file) return;
    const k = baseKey(file);
    let n = nodes.get(k);
    if (!n) n = addNode({ id: k, label: baseLabel(file), kind: 'code', core: false, r: 9, path: file, ephemeral: true });
    n.fade = 0;
    if (verb === 'read') { n.heat = Math.min(1, n.heat + 0.45); n.flash = 1; n.flashKind = 'read'; }
    else if (verb === 'run') { n.heat = Math.min(1, n.heat + 0.55); n.flash = 1; n.flashKind = 'run'; ripple(n, COLOR.run); }
    else { n.heat = 1; n.flash = 1; n.flashKind = 'edit'; }            // edit / write run hot
    if (verb === 'write' && n.kind === 'code') n.kind = 'doc';          // a freshly written file graduates
    if (n.kind === 'code' && activePlan && !edges.some((e) => e.a === n.id && e.b === activePlan && e.transient))
      edges.push({ a: n.id, b: activePlan, transient: true });
    setTicker(verb, n.label);
  }

  // A plan tool ticked — pulse the plan nodes (we don't fabricate completion; the
  // ring values stay honest, sourced from the docGraph re-seed on refresh()).
  function planPulse() {
    let any = false;
    for (const n of nodes.values()) if (n.kind === 'plan') { n.heat = 1; n.flash = 1; n.flashKind = 'edit'; any = true; activePlan = n.id; }
    setTicker('plan', any ? 'plan updated' : 'plan');
    if (refs.hero) { refs.hero.classList.remove('pulse'); void refs.hero.offsetWidth; refs.hero.classList.add('pulse'); }
  }

  function ripple(n, stroke) {
    if (reduce || !layers) return;
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('class', 'dvb-ripple'); c.setAttribute('stroke', stroke);
    c.setAttribute('cx', n.x); c.setAttribute('cy', n.y); c.setAttribute('r', n.r);
    layers.fx.append(c);
    const t0 = performance.now();
    (function grow() {
      const k = (performance.now() - t0) / 700;
      if (k >= 1 || !c.isConnected) { c.remove(); return; }
      c.setAttribute('r', n.r + k * 46); c.setAttribute('opacity', (1 - k) * 0.7);
      requestAnimationFrame(grow);
    })();
  }

  function setTicker(verb, label) {
    if (!refs.verb) return;
    const txt = { read: 'Read', edit: 'Edit', write: 'Write', run: 'Bash', plan: 'Plan' }[verb] || verb;
    refs.verb.className = 'dvb-verb ' + (verb === 'write' ? 'write' : verb === 'run' ? 'run' : verb === 'edit' || verb === 'plan' ? 'edit' : 'read');
    refs.verb.textContent = txt;
    refs.file.textContent = label;
    if (refs.spin) refs.spin.style.visibility = 'visible';
  }
  function idle() {
    if (!refs.verb) return;
    if (refs.spin) refs.spin.style.visibility = 'hidden';
    refs.verb.className = 'dvb-verb read'; refs.verb.textContent = 'done';
    refs.file.textContent = 'turn complete';
  }

  function pctColor(p) {
    const t = Math.max(0, Math.min(1, p / 100)), a = [240, 120, 60], b = [63, 185, 80];
    return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
  }
  function renderHero() {
    if (!refs.prog) return;
    let done = 0, total = 0;
    for (const k in plans) { done += plans[k].done; total += plans[k].total; }
    const pct = total ? Math.round(done / total * 100) : 0;
    const C = 2 * Math.PI * 22;
    refs.prog.setAttribute('stroke-dasharray', `${(pct / 100 * C).toFixed(1)} 999`);
    refs.prog.setAttribute('stroke', pctColor(pct));
    refs.pct.textContent = pct + '%';
    const nPlans = Object.keys(plans).length;
    refs.sub.textContent = total ? `${done} of ${total} tasks · ${total - done} left across ${nPlans} plan${nPlans === 1 ? '' : 's'}` : 'no plan checklists';
  }

  function ensureEl(n) {
    if (els.has(n.id)) return els.get(n.id);
    const g = document.createElementNS(SVGNS, 'g');
    // Non-ephemeral nodes are the brain docs seeded from the docGraph, so they resolve
    // to a doc we can open in the lightbox (like the old static brain) — mark them
    // openable; data-id maps the tapped group back to its node for the lookup.
    g.setAttribute('class', 'dvb-node' + (n.core ? ' core' : '') + (n.ephemeral ? '' : ' openable'));
    g.dataset.id = n.id;
    const glow = document.createElementNS(SVGNS, 'circle'); glow.setAttribute('class', 'dvb-glow');
    const dot = document.createElementNS(SVGNS, 'circle'); dot.setAttribute('class', 'dvb-dot');
    const ring = document.createElementNS(SVGNS, 'circle');
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#2b3340'); ring.setAttribute('stroke-width', '2.5');
    const prog = document.createElementNS(SVGNS, 'circle');
    prog.setAttribute('fill', 'none'); prog.setAttribute('stroke-width', '2.5'); prog.setAttribute('stroke-linecap', 'round');
    const label = document.createElementNS(SVGNS, 'text'); label.setAttribute('class', 'dvb-label'); label.textContent = n.label;
    g.append(glow, dot, ring, prog, label);
    layers.nodes.append(g);
    const rec = { g, dot, glow, ring, prog, label };
    els.set(n.id, rec);
    return rec;
  }
  function removeNode(id) { nodes.delete(id); const r = els.get(id); if (r) { r.g.remove(); els.delete(id); } }

  function hex(c) { c = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(c.substr(i, 2), 16)); }
  function mix(a, b, t) { const A = hex(a), B = hex(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`; }

  let last = 0;
  function step(now) {
    if (!svg || !svg.isConnected) { raf = null; return; }   // view torn down → stop the loop
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
    // decay heat; ephemeral code nodes that have gone cold fade out and die
    for (const n of nodes.values()) {
      const hl = n.kind === 'code' ? 7 : 16;
      n.heat *= Math.pow(0.5, dt / hl);
      n.flash *= Math.pow(0.5, dt / 0.45);
      if (n.ephemeral && n.heat < 0.04) { n.fade += dt / 2.2; if (n.fade >= 1) { removeNode(n.id); continue; } }
    }
    // hard cap: if ephemeral nodes pile up, retire the coldest
    const code = [...nodes.values()].filter((n) => n.ephemeral);
    if (code.length > 40) code.sort((a, b) => a.heat - b.heat).slice(0, code.length - 40).forEach((n) => removeNode(n.id));
    const arr = [...nodes.values()];
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        let dx = a.x - b.x, dy = a.y - b.y; const d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2);
        const f = 1400 / d2; a.vx += f * dx / d; a.vy += f * dy / d; b.vx -= f * dx / d; b.vy -= f * dy / d;
      }
      const ang = Math.atan2(a.y - CY, a.x - CX);
      let targetR;
      if (a.core) targetR = 32;
      else if (a.kind === 'code') targetR = 56 + (1 - a.heat) * 120;     // hot = near core, cold = rim
      else targetR = 64 + (1 - a.heat) * 48;
      const tx = CX + Math.cos(ang) * targetR, ty = CY + Math.sin(ang) * targetR;
      const pull = a.core ? 0.06 : 0.035;
      a.vx += (tx - a.x) * pull; a.vy += (ty - a.y) * pull;
      if (!reduce) { a.vx += -Math.sin(ang) * (0.08 + a.heat * 0.22); a.vy += Math.cos(ang) * (0.08 + a.heat * 0.22); }
    }
    for (const e of edges) {
      const a = nodes.get(e.a), b = nodes.get(e.b); if (!a || !b) continue;
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy) + 0.01;
      const rest = e.transient ? 64 : 90, f = (d - rest) * 0.012;
      a.vx += f * dx / d; a.vy += f * dy / d; b.vx -= f * dx / d; b.vy -= f * dy / d;
    }
    for (const n of nodes.values()) {
      n.x += n.vx * 0.6; n.y += n.vy * 0.6; n.vx *= 0.86; n.vy *= 0.86;
      const m = 18; n.x = Math.max(m, Math.min(W - m, n.x)); n.y = Math.max(m, Math.min(H - 24, n.y));
    }
    for (let i = edges.length - 1; i >= 0; i--) { const e = edges[i]; if (!e.transient) continue; const a = nodes.get(e.a); if (!a || a.heat < 0.05) edges.splice(i, 1); }
    draw();
    raf = requestAnimationFrame(step);
  }

  function draw() {
    let eh = '';
    for (const e of edges) {
      const a = nodes.get(e.a), b = nodes.get(e.b); if (!a || !b) continue;
      const op = e.transient ? (0.15 + a.heat * 0.5) : 0.42;
      eh += `<line class="dvb-edge${e.transient ? ' transient' : ''}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" opacity="${op.toFixed(2)}"/>`;
    }
    layers.edges.innerHTML = eh;
    for (const n of nodes.values()) {
      const rec = ensureEl(n);
      const r = n.r + n.heat * 5;
      const baseOp = 0.32 + 0.68 * Math.min(1, n.heat * 1.4 + (n.core ? 0.5 : 0.15));
      rec.g.setAttribute('opacity', (baseOp * (1 - n.fade)).toFixed(2));
      let fill = baseColor(n);
      if (n.flash > 0.05) {
        const fc = n.flashKind === 'read' ? COLOR.read : n.flashKind === 'run' ? COLOR.run : COLOR.hot;
        fill = mix(baseColor(n), fc, Math.min(1, n.flash));
      }
      rec.dot.setAttribute('cx', n.x.toFixed(1)); rec.dot.setAttribute('cy', n.y.toFixed(1));
      rec.dot.setAttribute('r', r.toFixed(1)); rec.dot.setAttribute('fill', fill);
      const gr = r + 6 + n.heat * 8;
      rec.glow.setAttribute('cx', n.x.toFixed(1)); rec.glow.setAttribute('cy', n.y.toFixed(1));
      rec.glow.setAttribute('r', gr.toFixed(1)); rec.glow.setAttribute('fill', fill);
      rec.glow.setAttribute('opacity', (n.heat * 0.22).toFixed(2));
      const plan = n.plan && plans[n.plan];
      if (plan) {
        const cr = r + 5, C = 2 * Math.PI * cr, pct = plan.total ? plan.done / plan.total * 100 : 0;
        rec.ring.style.display = ''; rec.prog.style.display = '';
        for (const c of [rec.ring, rec.prog]) { c.setAttribute('cx', n.x.toFixed(1)); c.setAttribute('cy', n.y.toFixed(1)); c.setAttribute('r', cr.toFixed(1)); }
        rec.prog.setAttribute('stroke', pctColor(pct));
        rec.prog.setAttribute('stroke-dasharray', `${(pct / 100 * C).toFixed(1)} ${C.toFixed(1)}`);
        rec.prog.setAttribute('transform', `rotate(-90 ${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
      } else { rec.ring.style.display = 'none'; rec.prog.style.display = 'none'; }
      rec.label.setAttribute('x', n.x.toFixed(1));
      rec.label.setAttribute('y', (n.y + r + 11).toFixed(1));
      rec.label.setAttribute('opacity', (0.35 + 0.65 * Math.min(1, n.heat * 1.5 + (n.core ? 0.6 : 0.1))).toFixed(2));
    }
  }

  // The panel markup. Class-based (NOT ids) so the brain can live in several places
  // at once — the dashboard centerpiece and the mobile expand overlay can both be in
  // the DOM — without selector collisions. attach(host) binds to one specific copy.
  function panel(opts = {}) {
    return `
    <section class="dash-card centerpiece live-brain">
      <div class="dvb-bar">
        <div class="dvb-hero">
          <svg viewBox="0 0 54 54" width="44" height="44" aria-hidden="true">
            <circle cx="27" cy="27" r="22" fill="none" stroke="#2b3340" stroke-width="5"/>
            <circle class="dvb-prog" cx="27" cy="27" r="22" fill="none" stroke="#3fb950" stroke-width="5"
                    stroke-linecap="round" transform="rotate(-90 27 27)" stroke-dasharray="0 999"
                    style="transition:stroke-dasharray .5s ease, stroke .5s ease"/>
          </svg>
          <span class="dvb-pct">0%</span>
        </div>
        <div class="dvb-meta">
          <div class="dvb-title">🧠 live brain</div>
          <div class="dvb-subline">no plan checklists</div>
        </div>
        <span class="dvb-livedot"><i></i>live</span>
      </div>
      <div class="dvb-stage"><svg class="dvb-svg" preserveAspectRatio="xMidYMid meet"></svg></div>
      <div class="dvb-foot">
        <span class="dvb-spin"></span>
        <span class="dvb-verb read">idle</span>
        <span class="dvb-file">waiting for the agent…</span>
        <span class="dvb-legend">
          <span><i style="background:#a978ff"></i>doc</span>
          <span><i style="background:#2ecf8f"></i>plan/mem</span>
          <span><i style="background:#5aa9e6"></i>code</span>
          <span><i style="background:#ff9d5c"></i>edited</span>
        </span>
      </div>
    </section>`;
  }

  // Tap a node → open its doc in the lightbox viewer (the old static brain's behavior).
  // Only brain-doc nodes resolve (ephemeral code nodes aren't captured docs); the moving
  // dot, glow, ring and label all live inside the <g>, so a tap anywhere on it counts.
  function onPick(ev) {
    const g = ev.target.closest('.dvb-node');
    if (!g) return;
    const n = nodes.get(g.dataset.id);
    if (!n || !n.path) return;
    const doc = currentDocNode(n.path);
    if (doc) openDocLightbox(doc);
  }

  // (Re)bind to one rendered brain panel (scoped to `host`) and (re)seed from the
  // docGraph. The rAF loop drives whichever copy was attached last; others freeze on
  // their final frame (only one brain is ever on-screen at a time on a given device).
  function attach(host) {
    const root = host || document;
    svg = root.querySelector('.dvb-svg');
    if (!svg) { if (raf) cancelAnimationFrame(raf); raf = null; return; }
    const q = (sel) => root.querySelector(sel);
    refs = { prog: q('.dvb-prog'), pct: q('.dvb-pct'), sub: q('.dvb-subline'), verb: q('.dvb-verb'), file: q('.dvb-file'), spin: q('.dvb-spin'), hero: q('.dvb-hero') };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';
    layers = { edges: document.createElementNS(SVGNS, 'g'), fx: document.createElementNS(SVGNS, 'g'), nodes: document.createElementNS(SVGNS, 'g') };
    svg.append(layers.edges, layers.fx, layers.nodes);
    svg.removeEventListener('click', onPick);
    svg.addEventListener('click', onPick);
    seed();
    last = 0;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(step);
  }

  return {
    panel,
    attach,
    feed(name, file) { const v = verbFor(name); if (v === 'plan') planPulse(); else touch(v, file); },
    idle,
    refresh() { if (svg && svg.isConnected) seed(); },   // re-pull plan completion when the docGraph changes
  };
})();
window.liveBrain = liveBrain;

// ---------- Drive → rail live-merge (Option B) ----------
// The Drive transcript owns #conversation, but the Convos rail (#sessions) stays
// visible beside it. These keep the rail honest *while you drive*: the live turn
// shows as a provisional card that cools into the real parsed unit once the
// turn-end ingest (DRIVE_CONVO_INGEST_GAP.md) lands it in the bundle.

// True while a row's session is the one being driven right now — used to badge the
// real cooled card as still-live (continuity across the provisional→cooled→follow-up
// lifecycle, so a follow-up turn keeps a "working" pulse without a second provisional).
function isDrivingSession(id) {
  return !!(state._driveOpen && state.drive && state.drive.claudeSessionId
    && state.drive.claudeSessionId === id);
}

// Merge a patch into the provisional descriptor and repaint *only* the rail (Drive
// owns #conversation). No-op once we've navigated off the driven project.
function setDriveProvisional(patch) {
  // Seed the session id from the live session so a *follow-up* turn (whose id is
  // already known) dedupes against its existing rail card instead of drawing a
  // second provisional next to it. On turn 1 the id is still null here and arrives
  // with the `system` event — by which point no real card exists yet anyway.
  const base = state.driveProvisional || {
    project: state.driveProject,
    sessionId: (state.drive && state.drive.claudeSessionId) || null,
    prompt: '', status: 'working',
  };
  state.driveProvisional = { ...base, ...patch };
  if (state.project && state.project === state.driveProvisional.project) renderSessionList();
}

// The provisional rail card for the in-flight turn. Suppressed once its session id
// surfaces among the real units/sessions — at that point the cooled card has won
// and renders in its place ("cools in place"). Returns '' when there's nothing live
// to show, or the live convo is already a real rail entry.
function driveProvisionalRow() {
  const pv = state.driveProvisional;
  if (!pv || pv.project !== state.project) return '';
  const known = pv.sessionId && (
    (state.promptUnits || []).some((u) => u.sessionId === pv.sessionId)
    || (state.projectData.sessions || []).some((s) => s.id === pv.sessionId));
  if (known) return ''; // the real (cooled) card is in the list now
  const word = pv.status === 'cooling' ? 'cooling…' : 'working…';
  return `<div class="prompt-row provisional" title="Live driven turn — click to return to Drive; cools into a saved card when it finishes">
      <div class="row">
        <span class="sw live-sw"></span>
        <span class="badge claude">claude</span>
        <span class="meta drive-live"><span class="live-dot"></span>${word}</span>
      </div>
      <div class="sess-preview">${esc(pv.prompt || 'starting…')}</div>
    </div>`;
}

// Re-fetch just the bundle data the rail renders from (manifest + activity + units)
// without touching #conversation, then repaint the rail. The cooled Drive card
// surfaces here once ingest has folded the turn in.
async function driveRefreshRail(slug) {
  if (!slug) return;
  const [proj, act, units] = await Promise.all([
    api(`/api/projects/${slug}`).catch(() => null),
    api(`/api/projects/${slug}/activity`).catch(() => null),
    api(`/api/projects/${slug}/prompts`).catch(() => null),
  ]);
  if (slug !== state.project) return;
  if (proj) state.projectData = proj;
  if (act) state.activity = { ok: true, byId: Object.fromEntries(act.map((a) => [a.id, a])) };
  if (units) state.promptUnits = units;
  // A brand-new session needs a thread swatch — recompute the color map (cheap).
  state.colorById = {};
  [...state.projectData.sessions].filter((s) => s.startedAt)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .forEach((s, i) => { state.colorById[s.id] = colorForIndex(i); });
  renderSessionList();
}

// A turn finished (`result`): flip the provisional to "cooling" and poll the bundle
// until the ingest fires and the real unit appears, then drop the provisional so the
// cooled card stands alone. Ingest is detached server-side (fires on turn_end after
// `result`), so we can't assume it's done the instant we hear `result` — poll, bounded.
function driveCoolProvisional() {
  if (!state.driveProvisional) return;
  setDriveProvisional({ status: 'cooling' });
  if (state._driveCoolPoll) { clearTimeout(state._driveCoolPoll); state._driveCoolPoll = null; }
  let tries = 0;
  const tick = async () => {
    state._driveCoolPoll = null;
    const pv = state.driveProvisional;
    if (!pv || pv.project !== state.project) return; // navigated away / superseded
    await driveRefreshRail(pv.project);
    const cooled = pv.sessionId && (state.promptUnits || []).filter((u) => u.sessionId === pv.sessionId);
    const landed = (cooled && cooled.length)
      || (pv.sessionId && (state.projectData.sessions || []).some((s) => s.id === pv.sessionId));
    if (landed) {
      state.driveProvisional = null;
      // Flash the parsed unit(s) as they take the provisional's place ("cool in place").
      if (cooled && cooled.length) state._liveFreshPrompts = new Set(cooled.map((u) => u.cardId || u.id));
      renderSessionList();
      return;
    }
    if (++tries < 15) state._driveCoolPoll = setTimeout(tick, 1000);
    // else: give up waiting (ingest may have no-op'd); the provisional stays until
    // the next turn or exit — better a lingering "cooling…" than a vanished convo.
  };
  state._driveCoolPoll = setTimeout(tick, 600);
}

async function bootDashboard() {
  document.body.classList.add('workspace'); // flag for publish controls (not a style hook)
  // Accept a machine token handed off via /app#<token>, then scrub the address bar.
  const hash = location.hash.replace(/^#/, '').trim();
  if (hash) {
    localStorage.setItem('vbrt_token', hash);
    history.replaceState(null, '', '/app');
  }
  state.token = localStorage.getItem('vbrt_token') || null;
  // Rehydrate a still-running driven session handle so "return to Drive" survives a
  // reload. Validity is checked lazily on resume (a 404 drops a stale handle).
  try { const raw = localStorage.getItem(DRIVE_ACTIVE_KEY); if (raw) state.driveActive = JSON.parse(raw); } catch { /* ignore */ }

  const me = await getMe();
  // If signed in and a claim is pending from /link, bind that machine token now.
  if (me) {
    const pending = localStorage.getItem('vbrt_pending_link');
    if (pending) {
      try {
        await apiPost('/api/link', { token: pending });
      } catch {
        /* ignore; user can retry the link */
      }
      localStorage.removeItem('vbrt_pending_link');
    }
  }

  if (!me && !state.token) return renderSignIn();

  showHome();
  const who = me ? esc(me.name || me.email || 'your account') : 'token access';
  const connect = me ? ` · <button class="linkbtn" id="connect-cli">＋ Connect CLI</button>` : '';
  el('#home').innerHTML = `
    <div class="home-wrap">
      <header class="home-head"><h1>Your workspace</h1>
        <p class="dim-note">Signed in as ${who}. <button class="linkbtn" id="signout">sign out</button>${connect}</p></header>
      <div id="cli-connect"></div>
      <div id="ws-overview"></div>
    </div>`;
  el('#signout').onclick = async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    localStorage.removeItem('vbrt_token');
    state.token = null;
    location.href = me ? '/' : '/app';
  };
  const cc = el('#connect-cli');
  if (cc)
    cc.onclick = async () => {
      cc.disabled = true;
      try {
        const { token } = await apiPost('/api/tokens', {});
        el('#cli-connect').innerHTML = `
          <div class="cli-box">
            <div class="dim-note">Run this once in your terminal — the token is shown only now:</div>
            <pre class="code">vbrt login ${esc(token)} --api ${esc(location.origin)}</pre>
            <div class="dim-note">Then <code>vbrt push</code> in any repo lands under your account.</div>
          </div>`;
      } catch {
        cc.disabled = false;
      }
    };
  try {
    await loadProjects(); // sidebar; throws '401' if not authorized
    const ws = await api('/api/workspace');
    const node = el('#ws-overview');
    if (node) node.innerHTML = renderWorkspaceSection(ws);
  } catch (e) {
    if (String(e.message) === '401') {
      localStorage.removeItem('vbrt_token');
      state.token = null;
      renderSignIn(me ? undefined : 'That access token wasn’t recognized.');
    } else {
      throw e;
    }
  }
}

// The "overarching" view: activity stats + agent memory aggregated across all of
// the owner's projects, each note tagged with the projects it came from.
function renderWorkspaceSection(ws) {
  const s = (ws && ws.stats) || {};
  const lines = s.added || s.removed ? ` · <b class="diff-add">+${s.added}</b>/<b class="diff-del">−${s.removed}</b> lines` : '';
  const statLine = `<div class="ov-line1"><b>${s.projects || 0}</b> projects · <b>${s.sessions || 0}</b> sessions · <b>${s.messages || 0}</b> messages${s.commits ? ` · <b>${s.commits}</b> commits` : ''}${lines}</div>`;

  // Note: we deliberately do NOT aggregate per-project agent memory here. Saved
  // memory is project-scoped — repo B's notes aren't relevant in repo A's workspace,
  // and the genuinely-global "about you" facts live in a different store (global
  // ~/.claude/CLAUDE.md) we don't capture yet. A faithful "what your agent knows
  // about you" section would read THAT; until then each repo's memory lives on its
  // own project page (the 🧠 Agent memory card), where it's in the right context.
  // See ARCHITECTURE.md → "Memory model" for the decision (2026-06-19).
  return `
    <section class="home-section">
      <h2>📊 Across your projects <span class="dim-note">activity from everything you've pushed</span></h2>
      <div class="ov-stats">${statLine}</div>
    </section>`;
}

// A prompt card: the before-context (collapsed), the prompt (the atom), and a
// capped "how it played out". The unit people rate, discuss, and learn from.
function renderPromptCard(c) {
  const b = c.before;
  const before = b && (b.agent || b.prompt)
    ? `<details class="pc-before"><summary>▸ earlier in this session</summary>
         ${b.prompt ? `<div class="pc-bu">you: ${esc(b.prompt)}</div>` : ''}
         ${b.agent ? `<div class="pc-ba">agent: ${esc(b.agent)}</div>` : ''}
       </details>`
    : '';
  const docs = (c.docRefs || []).map((d) => `<span class="pc-doc">📄 ${esc(d)}</span>`).join('');
  const steps = ((c.after && c.after.steps) || [])
    .map((s) => (s.kind === 'action' ? `<div class="pc-act">$ ${esc(s.text)}</div>` : `<div class="pc-rz">💭 ${esc(s.text)}</div>`))
    .join('');
  const shown = (c.after && c.after.steps ? c.after.steps.length : 0);
  const more = c.after && c.after.stepCount > shown ? `<div class="pc-more">+${c.after.stepCount - shown} more</div>` : '';
  const verdict = c.after && c.after.verdict ? `<div class="pc-verdict">${esc(c.after.verdict)}</div>` : '';
  const played = steps || verdict
    ? `<details class="pc-after"><summary>▸ how it played out${c.after.stepCount ? ` · ${c.after.stepCount} steps` : ''}</summary>${steps}${more}${verdict}</details>`
    : '';
  const proj = c.project
    ? `<span class="badge ${esc(c.source || '')}">${esc(c.source || '')}</span><a class="pc-proj" href="/p/${esc(c.project.slug)}">${esc(c.project.name)}</a>`
    : '';
  const when = c.ts ? `<span class="pc-when">${fmtAgo(Date.parse(c.ts))}</span>` : '';
  const open = c.project ? `<a class="pc-open" href="/p/${esc(c.project.slug)}">open session →</a>` : '';
  const cid = c.cardId;
  const score = c.rating ? c.rating.score : 0;
  const mv = c.myVote || 0;
  const vote = cid
    ? `<span class="pc-vote" data-card="${esc(cid)}"><button class="v-up${mv > 0 ? ' on' : ''}" data-v="1" aria-label="upvote">▲</button><span class="v-score">${score}</span><button class="v-dn${mv < 0 ? ' on' : ''}" data-v="-1" aria-label="downvote">▼</button></span>`
    : '';
  const link = cid ? `<a class="pc-link" href="/c/${esc(cid)}" title="permalink">🔗</a>` : '';
  return `<article class="pcard">
    <div class="pc-head">${proj}${renderArchetype(c.archetype)}${docs}${when}</div>
    ${before}
    <div class="pc-prompt">${formatText(c.prompt)}</div>
    ${renderAttachments(c.attachments)}
    ${renderOutcomeRail(c)}
    ${played}
    <div class="pc-bar">${vote}${link}${open}</div>
  </article>`;
}

// One delegated handler for every vote button (cards re-render constantly).
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pc-vote button');
  if (!btn) return;
  const wrap = btn.closest('.pc-vote');
  const card = wrap.dataset.card;
  const already = btn.classList.contains('on');
  const value = already ? 0 : Number(btn.dataset.v);
  try {
    const res = await fetch(`/api/cards/${encodeURIComponent(card)}/vote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(state.token ? { authorization: `Bearer ${state.token}` } : {}) },
      body: JSON.stringify({ value }),
    });
    if (res.status === 401) {
      location.href = '/app'; // sign in to rate
      return;
    }
    if (!res.ok) return;
    const d = await res.json();
    wrap.querySelector('.v-score').textContent = d.score;
    wrap.querySelector('.v-up').classList.toggle('on', d.myVote > 0);
    wrap.querySelector('.v-dn').classList.toggle('on', d.myVote < 0);
  } catch {
    /* ignore */
  }
});

// /c/<id> — a single prompt card's permalink page.
async function bootCard(id) {
  document.body.classList.add('public');
  showHome();
  el('#home').innerHTML = `
    ${publicNav()}
    <div class="home-wrap">
      <header class="home-head"><h1>Prompt</h1><p class="dim-note"><a href="/explore">← explore</a></p></header>
      <div id="cardwrap"><div class="empty">Loading…</div></div>
    </div>`;
  try {
    const c = await api(`/api/cards/${encodeURIComponent(id)}`);
    el('#cardwrap').innerHTML = renderPromptCard(c);
  } catch {
    el('#cardwrap').innerHTML = '<div class="empty">This prompt is private, or the link is invalid.</div>';
  }
}

// Top nav for the public surfaces (no workspace sidebar).
function publicNav() {
  return `<nav class="pubnav">
    <a class="pn-brand" href="/"><span class="pn-logo">★</span> VibeRate</a>
    <span class="pn-links"><a href="/explore">Explore</a><a href="/app">Your workspace →</a></span>
  </nav>`;
}

// /explore — the public discover feed of prompt cards.
async function bootFeed() {
  document.body.classList.add('public');
  showHome();
  el('#home').innerHTML = `
    ${publicNav()}
    <div class="home-wrap">
      <header class="home-head"><h1>Explore prompts</h1>
        <p class="dim-note">How people express their will — substantive prompts from published sessions.</p></header>
      <div id="feed"><div class="empty">Loading…</div></div>
    </div>`;
  try {
    const cards = await api('/api/feed');
    el('#feed').innerHTML = cards.length
      ? cards.map(renderPromptCard).join('')
      : '<div class="empty">No published prompts yet — publish a project and its prompts show up here.</div>';
  } catch {
    el('#feed').innerHTML = '<div class="empty">Couldn’t load the feed.</div>';
  }
}

// Routing: /p/<id> = public single project; /app = token-scoped dashboard
// (hosted); /explore = public feed; / = local workspace home.
async function boot() {
  const m = location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)/);
  if (m) {
    document.body.classList.add('hosted');
    showProject();
    // Self-view handoff: a push hands back /p/<id>#v=<token>. Redeem it into a
    // view cookie so the owner can read their own private project without signing
    // in, then strip the token from the URL before anyone can copy it out.
    const vm = location.hash.match(/[#&]v=([^&]+)/);
    if (vm) {
      try { await apiPost('/api/view', { token: decodeURIComponent(vm[1]) }); } catch { /* fall through to the private notice */ }
      history.replaceState(null, '', location.pathname);
    }
    try {
      await selectProject(m[1]);
    } catch (e) {
      el('#conversation').innerHTML =
        '<div class="empty">This project is private or the link is invalid.<br>If it’s yours, open your <a href="/app">dashboard</a> to view or publish it.</div>';
    }
    return;
  }

  // Claim handoff: /link#<token> stashes the machine token, then sends you to
  // /app to sign in (if needed) and bind it to your account.
  if (location.pathname.startsWith('/link')) {
    const t = location.hash.replace(/^#/, '').trim();
    if (t) localStorage.setItem('vbrt_pending_link', t);
    location.replace('/app');
    return;
  }

  if (location.pathname.startsWith('/explore')) {
    const brandEl = el('#brand');
    if (brandEl) brandEl.onclick = () => (location.href = '/explore');
    await bootFeed();
    return;
  }

  const cm = location.pathname.match(/^\/c\/(.+)$/);
  if (cm) {
    const brandEl = el('#brand');
    if (brandEl) brandEl.onclick = () => (location.href = '/explore');
    await bootCard(decodeURIComponent(cm[1]));
    return;
  }

  const brand = el('#brand');

  if (location.pathname.startsWith('/app')) {
    if (brand) brand.onclick = () => (location.href = '/app');
    await bootDashboard();
    return;
  }

  // Local: land on the workspace dashboard.
  if (brand) brand.onclick = showHome;
  showHome();
  await Promise.all([loadProjects(), loadContext()]);
}

// ══════════════════════════════════════════════════════════════════════════
// MOBILE — responsive shell + nav + brain header strip + brain↔chat live link
// (PLAN_MOBILE.md, Variant A). Dormant on desktop: the single entry point is the
// `is-mobile` body class, set from matchMedia below. Above the 760px breakpoint
// none of this applies, so the desktop layout is byte-for-byte unchanged.
//
// Rather than scatter calls through the desktop render paths, we wrap a handful
// of existing render functions so every surface transition (project → reader →
// drive → home) re-syncs the mobile chrome from one place.
// ══════════════════════════════════════════════════════════════════════════
(function mobileInit() {
  const mq = window.matchMedia('(max-width: 760px)');
  const body = document.body;
  const byId = (id) => document.getElementById(id);
  const isMobile = () => body.classList.contains('is-mobile');
  const brainOpen = () => body.classList.contains('m-brain-open');

  // --- drawer / sheet / brain overlay (one backdrop, mutually exclusive) ---
  const closeDrawer = () => body.classList.remove('m-drawer-open');
  const closeSheet = () => body.classList.remove('m-sheet-open');
  const closeBrain = () => body.classList.remove('m-brain-open');
  const closeAll = () => { closeDrawer(); closeSheet(); closeBrain(); };
  function toggleDrawer() { const o = !body.classList.contains('m-drawer-open'); closeSheet(); body.classList.toggle('m-drawer-open', o); }
  function toggleSheet() { const o = !body.classList.contains('m-sheet-open'); closeDrawer(); body.classList.toggle('m-sheet-open', o); }
  function toggleBrain() { const o = !brainOpen(); body.classList.toggle('m-brain-open', o); if (o) mountBrain(); syncGrip(); }
  function syncGrip() { const g = byId('m-grip'); if (g) g.textContent = brainOpen() ? 'brain ▴' : 'brain ▾'; }

  // --- brain expand overlay: mount the live brain (same renderer as the dashboard
  // centerpiece, scoped to this overlay so the two copies don't collide). ---
  function mountBrain() {
    const host = byId('m-bo-inner');
    if (!host) return;
    if (!state.docGraph) { host.innerHTML = '<div class="empty">No brain captured yet.</div>'; return; }
    host.innerHTML = liveBrain.panel({ noTimeTravel: true });
    liveBrain.attach(host);
  }

  // --- brain header strip: a chip per brain doc, lit by the live link ---
  function renderStrip() {
    const chips = byId('m-chips');
    if (!chips) return;
    const nodes = (state.docGraph?.nodes || []).filter((n) => !n.archived);
    if (!nodes.length) { chips.innerHTML = '<span class="m-sub">no brain docs</span>'; return; }
    chips.innerHTML = nodes.map((n) => {
      const kind = /(^|\/)memory\//i.test(n.name) || n.role === 'memory' ? 'memory' : 'doc';
      return `<div class="chip" data-name="${esc(n.name)}" data-base="${esc((n.base || '').toLowerCase())}" data-kind="${kind}"><i></i>${esc(n.base)}</div>`;
    }).join('');
  }

  // --- app bar: title / sub / follow state, recomputed on every sync ---
  function mobileSync() {
    if (!isMobile()) return;
    const title = byId('m-title');
    const sub = byId('m-sub');
    body.classList.toggle('is-live', !!state.live);
    // The brain header strip + expand overlay are a Drive-view affordance: there the
    // chat owns #conversation so the inline centerpiece brain isn't on screen, and the
    // strip is the only way to reach the brain (collapsed to give the chat real estate).
    // On the plain dashboard the centerpiece brain renders inline, so the strip would be
    // a redundant second brain — gate it on Drive only.
    const driving = !!state._driveOpen;
    body.classList.toggle('m-driving', driving);
    if (!driving) closeBrain(); // no grip off the Drive view → don't strand the overlay open
    if (body.classList.contains('view-project') && state.projectData) {
      if (title) title.textContent = state.projectData.name || state.project || 'Project';
      let s;
      if (state._driveOpen) s = 'driving · ' + ((state.drive && state.drive.status) || 'live');
      else if (state.session) s = 'reading a conversation';
      else if (state.live) s = 'following';
      else s = `${plural((state.promptUnits || []).length, 'prompt')} · ${plural((state.projectData.sessions || []).length, 'session')}`;
      if (sub) sub.textContent = s;
      renderStrip();
      if (brainOpen()) mountBrain();
    } else {
      if (title) title.textContent = 'VibeRate';
      if (sub) sub.textContent = body.classList.contains('workspace') ? 'workspace' : '';
    }
    syncGrip();
  }
  window.mobileSync = mobileSync;

  // --- brain↔chat live link: a touched brain doc glows its chip + node(s) ---
  function brainTouch(path, mode) {
    if (!path) return;
    const base = String(path).split(/[\\/]/).pop().toLowerCase();
    const cls = mode === 'read' ? 'touch-read' : 'touch-edit';
    document.querySelectorAll('#m-chips .chip').forEach((c) => {
      if (c.dataset.base !== base) return;
      c.classList.remove('newchip'); void c.offsetWidth; c.classList.add('lit', 'newchip');
      if (mode === 'read') setTimeout(() => c.classList.remove('lit'), 2600);
    });
    // Light the node in any rendered brain (dashboard inline + expand overlay).
    document.querySelectorAll('.gnode[data-doc]').forEach((g) => {
      const nb = (g.dataset.doc.split(/[\\/]/).pop() || '').toLowerCase();
      if (nb !== base) return;
      g.classList.remove('touch-read', 'touch-edit'); void g.offsetWidth;
      g.classList.add(cls);
      setTimeout(() => g.classList.remove(cls), mode === 'read' ? 2600 : 3600);
    });
  }
  window.mobileBrainTouch = brainTouch;

  // --- wiring ---
  if (byId('m-menu')) byId('m-menu').onclick = toggleDrawer;
  if (byId('m-rail')) byId('m-rail').onclick = toggleSheet;
  if (byId('m-backdrop')) byId('m-backdrop').onclick = closeAll;
  if (byId('m-brainbar')) byId('m-brainbar').onclick = (e) => {
    // The leading "← dashboard" pill leaves Drive for the project dashboard (the
    // strip is fixed chrome, so this back affordance never scrolls out of reach).
    if (e.target.closest('#m-bb-dash')) { exitDrive(); return; }
    // A chip taps straight into the doc lightbox for that file; the grip / bare
    // strip toggles the network. One handler, so a chip tap doesn't also fire a
    // strip tap (no double-toggle).
    const chip = e.target.closest('.chip');
    if (chip) {
      const node = (state.docGraph?.nodes || []).find((n) => n.name === chip.dataset.name);
      if (node) openDocLightbox(node);
      return;
    }
    toggleBrain();
  };
  if (byId('m-follow')) byId('m-follow').onclick = () => {
    if (state._driveOpen) return; // Drive is inherently live — follow doesn't apply
    state.live ? stopLive() : startLive();
    if (state.session) renderSessionReader();
    else renderTimeline();
    mobileSync();
  };
  // Picking a project (drawer) or a conversation (rail sheet) dismisses the surface.
  const sb = byId('sidebar'); if (sb) sb.addEventListener('click', (e) => { if (e.target.closest('.proj')) closeDrawer(); });
  // A row, a Drive start/resume, or the back-to-workspace arrow all navigate away
  // from the sheet — dismiss it so the destination isn't hidden behind it.
  const ss = byId('sessions'); if (ss) ss.addEventListener('click', (e) => { if (e.target.closest('.sess, .prompt-row, .pb-drive, [data-back-projects]')) closeSheet(); });

  // Wrap the desktop render fns so each surface transition re-syncs the chrome.
  ['renderTimeline', 'renderSessionReader', 'renderSessionList', 'renderDriveView', 'showHome', 'showProject'].forEach((name) => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (...a) { const r = orig.apply(this, a); try { mobileSync(); } catch { /* chrome sync is best-effort */ } return r; };
  });

  // Leaving a project / going home should never strand an open sheet or overlay.
  const origShowHome = window.showHome;
  window.showHome = function (...a) { closeAll(); return origShowHome.apply(this, a); };

  function applyMode() {
    body.classList.toggle('is-mobile', mq.matches);
    if (!mq.matches) closeAll(); // crossing back to desktop: drop mobile-only surfaces
    mobileSync();
  }
  if (mq.addEventListener) mq.addEventListener('change', applyMode);
  else if (mq.addListener) mq.addListener(applyMode); // older Safari
  applyMode();
})();

boot().catch((e) => {
  el('#home').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
});
