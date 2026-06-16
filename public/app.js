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
  docLayout: 'web', // 'web' | 'tree' | 'recent'
  sourceFilter: 'all',
  colorById: {},
  selectedConvo: null,
  brush: null,
  turnAnchors: [],
  currentTurn: 0,
  token: null, // hosted dashboard: owner token, sent as Bearer on API calls
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

function endState(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'user') {
      return { cls: 'warn', text: '⚠ Ended on your message — the agent never replied (likely interrupted / Ctrl-C)' };
    }
    if (m.kind === 'tool_use' || m.kind === 'tool_result') {
      return { cls: 'warn', text: '⚠ Ended mid-action — cut off during a tool call (likely interrupted)' };
    }
    if (m.kind === 'text' && m.role === 'assistant') {
      return { cls: 'ok', text: '■ End of conversation' };
    }
  }
  return { cls: 'ok', text: '■ End of conversation' };
}

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
  state.project = null;
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
  state.project = slug;
  state.session = null;
  document.querySelectorAll('.proj').forEach((n) =>
    n.classList.toggle('active', n.dataset.slug === slug),
  );
  state.projectData = await api(`/api/projects/${slug}`);

  // Fetch per-session user-message activity once; shared by list + timeline.
  // Degrades gracefully if the running server lacks the endpoint.
  state.activity = { ok: false, byId: {} };
  try {
    const act = await api(`/api/projects/${slug}/activity`);
    if (slug !== state.project) return;
    state.activity = { ok: true, byId: Object.fromEntries(act.map((a) => [a.id, a])) };
  } catch {
    /* old server: fall back to manifest counts */
  }

  state.git = { ok: false, commits: [] };
  try {
    const g = await api(`/api/projects/${slug}/git`);
    if (slug !== state.project) return;
    if (g && Array.isArray(g.commits)) state.git = { ok: true, commits: g.commits };
  } catch {
    /* no git captured for this project */
  }

  state.docs = { ok: false, files: [] };
  state.docTab = null;
  state.docGraph = null;
  try {
    const d = await api(`/api/projects/${slug}/docs`);
    if (slug !== state.project) return;
    if (d && Array.isArray(d.docs) && d.docs.length) {
      state.docs = { ok: true, files: d.docs };
      state.docTab = d.docs[0].name;
      state.docGraph = buildDocGraph(d.docs);
    }
  } catch {
    /* no agent docs captured for this project */
  }

  // Agent memory scoped to this project (Tier-2). Recall-only; index always loads.
  state.projectMemory = null;
  try {
    const m = await api(`/api/projects/${slug}/memory`);
    if (slug !== state.project) return;
    state.projectMemory = m;
  } catch {
    /* no project memory */
  }

  // Stable color per thread (golden-angle hues stay distinct across hundreds
  // of threads). Shared by the timeline and the session-list swatches.
  state.colorById = {};
  [...state.projectData.sessions]
    .filter((s) => s.startedAt)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .forEach((s, i) => {
      state.colorById[s.id] = colorForIndex(i);
    });

  renderSessionList();
  renderTimeline();
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

  const card = (s) => {
    const dur = s.startedAt && s.endedAt ? fmtDuration(new Date(s.endedAt) - new Date(s.startedAt)) : '';
    const act = state.activity.byId[s.id];
    const label = act ? plural(act.userCount, 'msg') : `${s.messageCount} total`;
    const color = (state.colorById || {})[s.id] || 'var(--muted)';
    const dl = act ? diffLabel(act) : '';
    return `
        <div class="sess ${state.session === s.id ? 'active' : ''}${state.selectedConvo === s.id ? ' hl' : ''}" data-id="${esc(s.id)}">
          <div class="row">
            <span class="badge ${s.source}">${s.source}</span>
            <span class="meta">${fmtDate(s.startedAt)}</span>
          </div>
          <div class="title"><span class="sw" style="background:${color}"></span>${esc(s.title)}</div>
          <div class="meta">${label}${dur ? ` · ${dur}` : ''}</div>
          ${dl ? `<div class="meta files">${dl}</div>` : ''}
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

  el('#sessions').innerHTML = `
    <div class="pane-title">${esc(p.name || p.slug)} · ${plural(p.sessions.length, 'session')}</div>
    <div class="filters">
      ${chip('all', `all ${p.sessions.length}`)}
      ${counts.claude ? chip('claude', `claude ${counts.claude}`) : ''}
      ${counts.codex ? chip('codex', `codex ${counts.codex}`) : ''}
    </div>
    <div class="list-legend"><span class="sw legend-rainbow"></span> a colour per session · <span class="badge claude">claude</span> / <span class="badge codex">codex</span> = agent</div>
    ${brushBanner}
    ${list || (empties.length ? '' : '<div class="empty">No sessions in this range.</div>')}
    ${emptyBlock}`;

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
    .querySelectorAll('.sess')
    .forEach((node) => node.addEventListener('click', () => selectSession(state.project, node.dataset.id)));
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
  const sessions = timelineSessions();
  if (sessions.length === 0) {
    el('#conversation').innerHTML = '<div class="empty">No timestamped sessions.</div>';
    return;
  }
  const enriched = state.activity.ok;
  const tMin = Math.min(...sessions.map((s) => s.start));
  const tMax = Math.max(...sessions.map((s) => s.end));

  el('#conversation').innerHTML = `
    <div class="conv-toolbar">
      <div class="conv-head">
        <h2>${esc(state.projectData.name)}</h2>
        <div class="meta">${plural(sessions.length, 'conversation')} · ${fmtShort(tMin)} → ${fmtShort(tMax)}${
          enriched ? '' : ' · <span class="warn-inline">restart <code>vbrt serve</code> for message data</span>'
        }</div>
      </div>
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
      if (!node) return;
      state.docTab = node.name;
      state.docOpen = true;
      rerenderCenterpiece();
      el('#conversation .centerpiece')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  wireDocTabs();
  wireActivity();
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
      <div class="dash-head"><span>🧠 Brain history</span><span class="dim-note">${entries.length} change${entries.length === 1 ? '' : 's'} · newest first</span></div>
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
  }));
  const seen = new Set();
  const edges = [];
  for (let i = 0; i < nodes.length; i++)
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const re = new RegExp(nodes[j].base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      if (re.test(nodes[i].content)) {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ i, j });
        }
      }
    }
  const maxB = Math.max(...nodes.map((n) => n.bytes), 1);
  nodes.forEach((n) => {
    n.r = 9 + Math.round(Math.sqrt(n.bytes / maxB) * 14);
    n.color = docColor(n.base);
    n.role = docRole(n.base);
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
  const base = Math.min((W - 2 * padX) / bw, (H - 2 * padY) / bh); // uniform fit
  const sx = Math.min((W - 2 * padX) / bw, base * 1.6); // mild anisotropy to fill the wider axis
  const sy = Math.min((H - 2 * padY) / bh, base * 1.6);
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

function renderCenterpiece() {
  if (!state.docs.ok || !state.docGraph) {
    return `
      <section class="dash-card centerpiece">
        <div class="dash-head"><span>🧠 AI architecture</span></div>
        <div class="empty">No agent docs captured (SOUL.md / AGENTS.md / CLAUDE.md / SEED.md…).
          Re-run <code>vbrt</code> in the repo to capture them.</div>
      </section>`;
  }
  const g = state.docGraph;
  const files = state.docs.files;
  const active = files.find((f) => f.name === state.docTab) || files[0];

  const edgesSvg = g.edges
    .map(
      (e) =>
        `<line x1="${g.nodes[e.i].x.toFixed(1)}" y1="${g.nodes[e.i].y.toFixed(1)}" x2="${g.nodes[e.j].x.toFixed(1)}" y2="${g.nodes[e.j].y.toFixed(1)}" class="gedge"/>`,
    )
    .join('');
  const recent = state.docLayout === 'recent';
  // Gentle "breathing" pulse, recency-modulated: each node carries a soft halo
  // that fades in and out. Recently-touched docs breathe a touch faster and
  // brighter, so the graph reads as alive and the fresh docs draw the eye.
  const mtimes = g.nodes.map((n) => n.mtime || 0).filter(Boolean);
  const tMax = mtimes.length ? Math.max(...mtimes) : 0;
  const tMin = mtimes.length ? Math.min(...mtimes) : 0;
  const tSpan = tMax - tMin || 1;
  const nodesSvg = g.nodes
    .map((n, i) => {
      const on = state.docOpen && n.name === active.name ? ' on' : '';
      const sub = recent && n.mtime
        ? `<text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 23).toFixed(1)}" text-anchor="middle" class="gsub">${esc(fmtAgo(n.mtime))}</text>`
        : '';
      const f = n.mtime ? (n.mtime - tMin) / tSpan : 0.4; // 0 oldest … 1 newest
      const dur = (4.4 - f * 1.7).toFixed(2); // newer → faster breath
      const pmax = (0.16 + f * 0.26).toFixed(2); // newer → brighter halo
      const delay = ((i * 0.37) % 2.3).toFixed(2); // stagger so they don't pulse in unison
      const haloStyle = `animation-duration:${dur}s;animation-delay:${delay}s;--pmax:${pmax}`;
      return `<g class="gnode${on}" data-doc="${esc(n.name)}">
        <circle class="ghalo" cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.r + 7).toFixed(1)}" fill="${n.color}" style="${haloStyle}"/>
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="${n.color}"/>
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
      <div class="dash-head"><span>🧠 AI architecture</span>
        <span class="lay-toggle">${toggle}</span>
        <span class="brain-key" title="Each node breathes; brighter/faster = more recently edited."><span class="bk-dot"></span>glow = recency</span>
        <span class="dim-note">${files.length} docs · ${g.edges.length} links</span></div>
      <div class="brain-wrap">
        <svg class="brain" viewBox="0 0 ${g.W} ${g.H}" preserveAspectRatio="xMidYMid meet">${timeAxis}${edgesSvg}${nodesSvg}</svg>
        <div class="brain-peek" id="brainPeek" hidden></div>
        ${state.docOpen ? `
        <div class="doc-backdrop" data-doc-close></div>
        <div class="doc-overlay">
          <div class="doc-reader-head"><span>${esc(active.name)}</span><button class="doc-close" data-doc-close title="Close">✕</button></div>
          <div class="docview markdown">${renderMarkdown(active.content)}</div>
        </div>` : ''}
      </div>
    </section>`;
}

function rerenderCenterpiece() {
  const cp = el('#conversation').querySelector('.centerpiece');
  if (cp) {
    cp.outerHTML = renderCenterpiece();
    wireDocTabs();
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
  return `<div class="bp-head"><span class="bp-name">${esc(n.base)}</span><span class="bp-meta">${esc(kb)} · ${all.length} section${all.length === 1 ? '' : 's'}</span></div>
    ${first ? `<div class="bp-first">${esc(first)}</div>` : ''}
    <div class="bp-sections">${list}</div>`;
}

// Hover-peek: hovering a node surfaces its outline + first line in a floating card
// anchored beside it, so you read what's inside without opening the full doc.
// Click still opens the full reader overlay (progressive disclosure).
function wireBrainPeek(root) {
  const peek = root.querySelector('#brainPeek');
  const wrap = root.querySelector('.brain-wrap');
  if (!peek || !wrap || !state.docGraph) return;
  const byName = new Map(state.docGraph.nodes.map((n) => [n.name, n]));
  root.querySelectorAll('.gnode').forEach((g) => {
    g.addEventListener('mouseenter', () => {
      if (state.docOpen) return; // full reader is open — don't peek over it
      const n = byName.get(g.dataset.doc);
      if (!n) return;
      peek.innerHTML = brainPeekHtml(n);
      peek.hidden = false;
      const wb = wrap.getBoundingClientRect();
      const cb = g.querySelector('circle').getBoundingClientRect();
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
      state.docTab = b.dataset.doc;
      state.docOpen = true; // open the reader overlay for this node
      rerenderCenterpiece();
    };
  });
  root.querySelectorAll('[data-doc-close]').forEach((b) => {
    b.onclick = () => {
      state.docOpen = false;
      rerenderCenterpiece();
    };
  });
  root.querySelectorAll('[data-layout]').forEach((b) => {
    b.onclick = () => setLayout(b.dataset.layout);
  });
  wireBrainPeek(root);
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
      grp.querySelectorAll('circle').forEach((c) => { // halo + node both follow
        c.setAttribute('cx', n.x.toFixed(1));
        c.setAttribute('cy', n.y.toFixed(1));
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

// The current brain-graph node whose name/basename matches a doc, or null (e.g.
// the doc was since deleted — we only hold the current snapshot's content).
function currentDocNode(name) {
  const g = state.docGraph;
  if (!g) return null;
  const base = name.split('/').pop();
  return g.nodes.find((n) => n.name === name || n.base === base) || null;
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
  return `
    <div class="ov-stats">
      <div class="ov-line1"><b>${convos}</b> ${plw(convos, 'conversation')} · <b>${messages}</b> ${plw(messages, 'message')}${state.git.ok ? ` · <b>${commits}</b> ${plw(commits, 'commit')}` : ''}${brain ? ` · <b>${brain}</b> 🧠 ${plw(brain, 'brain edit')}` : ''}${lines}</div>
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
        `<span class="rib-c ${c.isRevert ? 'revert' : ''}" data-commit="${esc(c.hash)}" style="left:${pct(c.t)}%" title="${esc(fmtShortDT(c.t))} · ${esc(c.hash)} · ${esc(c.subject)}"></span>`,
    )
    .join('');

  const N = 120;
  const bins = new Array(N).fill(0);
  for (const s of sessions)
    for (const m of s.msgs || []) {
      let bi = Math.floor((pct(m.t) / 100) * N);
      bi = Math.max(0, Math.min(N - 1, bi));
      bins[bi]++;
    }
  const maxBin = Math.max(1, ...bins);
  const heat = bins
    .map((n, i) => (n ? `<span class="rib-h" style="left:${(i / N) * 100}%;height:${4 + Math.round((Math.sqrt(n) / Math.sqrt(maxBin)) * 22)}px" title="${plural(n, 'msg')}"></span>` : ''))
    .join('');

  const maxCount = Math.max(1, ...sessions.map((s) => s.userCount));
  const wpx = (c) => Math.max(5, Math.round(4 + (c / maxCount) * 60));
  const blocks = sessions
    .map((s) => {
      const sel = state.selectedConvo === s.id ? ' sel' : '';
      const dl = diffLabel(s);
      return `<span class="rib-b${sel}" data-convo="${esc(s.id)}" style="left:${pct(s.start)}%;width:${wpx(s.userCount)}px;background:${SRC_COLOR[s.source] || 'var(--accent)'}"
           title="${esc(fmtShortDT(s.start))} · ${s.source} · ${plural(s.userCount, 'msg')}${dl ? ' · ' + dl : ''} · ${esc(s.title)}"></span>`;
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
      return `<span class="rib-d" data-brain="${esc(c.hash)}" style="left:${pct(c.t)}%" title="${esc(fmtShortDT(c.t))} · 🧠 ${esc(list)} · ${esc(c.subject)}"></span>`;
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

async function selectSession(slug, id) {
  state.session = id;
  document.querySelectorAll('.sess').forEach((n) => n.classList.toggle('active', n.dataset.id === id));
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
  renderSessionReader();
}

function renderSessionReader() {
  const s = state._session;
  const units = state._units || [];
  const stats = statsFor(s.messages);
  // Nav follows the prompt cards: one stop per unit, anchored by card ordinal.
  state.turnAnchors = units.map((_, i) => `turn-${i}`);
  state.currentTurn = 0;
  const end = endState(s.messages);
  const dur = fmtDuration(new Date(s.endedAt) - new Date(s.startedAt));
  const filesList = [...stats.files].slice(0, 40);

  const endMarker = `<div class="end-marker ${end.cls}">${end.text}</div>`;
  const body = units.length
    ? units.map(renderReaderCard).join('') + endMarker
    : '<div class="empty">No prompts in this session.</div>';

  el('#conversation').innerHTML = `
    <div class="conv-toolbar">
      <div class="conv-head">
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

// One prompt unit as an internal reader card. Acks ("go ahead") collapse to a slim
// connector so the chain stays legible without giving filler a full card.
function renderReaderCard(u, i) {
  const anchor = `turn-${i}`;
  if (u.isAck) {
    return `<div class="turn rcard-ack" id="${anchor}"><span class="ack-arrow">↳ you:</span> <span class="ack-text">${esc(u.prompt)}</span>${contextGauge(u.context)}</div>`;
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
  return `<article class="turn pcard rcard" id="${anchor}">
    <div class="pc-head">${docs}${contextGauge(u.context)}${when}</div>
    ${before}
    <div class="pc-prompt">${formatText(u.prompt)}</div>
    ${played}
    ${link ? `<div class="pc-bar">${link}</div>` : ''}
  </article>`;
}

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

async function bootDashboard() {
  document.body.classList.add('workspace'); // flag for publish controls (not a style hook)
  // Accept a machine token handed off via /app#<token>, then scrub the address bar.
  const hash = location.hash.replace(/^#/, '').trim();
  if (hash) {
    localStorage.setItem('vbrt_token', hash);
    history.replaceState(null, '', '/app');
  }
  state.token = localStorage.getItem('vbrt_token') || null;

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
  const notes = (ws && ws.memory) || [];
  const lines = s.added || s.removed ? ` · <b class="diff-add">+${s.added}</b>/<b class="diff-del">−${s.removed}</b> lines` : '';
  const statLine = `<div class="ov-line1"><b>${s.projects || 0}</b> projects · <b>${s.sessions || 0}</b> sessions · <b>${s.messages || 0}</b> messages${s.commits ? ` · <b>${s.commits}</b> commits` : ''}${lines}</div>`;

  const order = ['user', 'feedback', 'project', 'reference', 'note'];
  const byType = new Map();
  for (const n of notes) {
    const t = n.type || 'note';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(n);
  }
  const groups = order.filter((t) => byType.has(t)).concat([...byType.keys()].filter((t) => !order.includes(t)));
  const memHtml = notes.length
    ? groups
        .map(
          (t) => `<div class="atom-group">
            <div class="atom-section">${esc(t)}</div>
            ${byType
              .get(t)
              .map(
                (n) => `<div class="atom-row">
                  <span class="atom-text">${esc(n.title)}${n.description ? ` <span class="recall-desc">— ${esc(n.description)}</span>` : ''}</span>
                  <span class="atom-badges">${(n.projects || [])
                    .map((p) => `<a class="proj-badge" href="/p/${esc(p.id)}" title="${esc(p.name)}">${esc(p.name)}</a>`)
                    .join('')}</span>
                </div>`,
              )
              .join('')}
          </div>`,
        )
        .join('')
    : '<div class="empty">No memory captured yet — push a repo whose agent memory is included (the default) to see it aggregated here.</div>';

  return `
    <section class="home-section">
      <h2>🧠 Across your projects <span class="dim-note">memory &amp; activity from everything you've pushed</span></h2>
      <div class="ov-stats">${statLine}</div>
      <div class="ctx-bucket">
        <div class="ctx-bucket-head"><span class="dim-note">agent memory — ${notes.length} note${notes.length === 1 ? '' : 's'} across your projects</span></div>
        ${memHtml}
      </div>
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
    <div class="pc-head">${proj}${docs}${when}</div>
    ${before}
    <div class="pc-prompt">${formatText(c.prompt)}</div>
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

boot().catch((e) => {
  el('#home').innerHTML = `<div class="empty">Error: ${esc(e.message)}</div>`;
});
