# PLAN_COCKPIT.md — migrating the project home from the dense Activity dashboard to the calm "cockpit"

**Status: SHIPPED (2026-06-23).** The cockpit is now the default project home; the
dense Activity+ribbon+brain stack is demoted behind "Full timeline →" (`state.fullTimeline`
toggles within the same route). This doc began as the research / change-map; it's kept as
the design rationale. What landed against the sequencing in §7:
- **§7.1 runtime telemetry — done.** `publicView()`/`listSessions()` (`src/agent.js:802`)
  now carry `type`, `model`, `promptStartedAt`, `lastAction:{verb,label,file}`, `ctxTokens`,
  `ctxPct`; `setStatus` gained the **`waiting`** lifecycle state, set from the MCP-ask
  round-trip (`registerAsk`/`resolveAsk`) and cleared back to `working` on answer/timeout.
- **§7.2 transport — MVP poll, not a new aggregate SSE.** The roster polls
  `/api/agent/sessions` every 2.5 s (`refreshRoster`), with a 1 s client tick advancing the
  elapsed timers off the cached roster (`cockpitTick`). The dedicated project-scoped SSE
  (§3.1c) remains the future optimization.
- **§7.3–6 Now / Latest / Next / sparkline / route cutover — done** in `public/app.js`
  (`renderCockpit` and friends, ~`:1294`) + cockpit CSS in `public/style.css`.
- **§3.2 commit→agent attribution — done (2026-06-23, client-side).** "Latest" rows now
  carry an agent badge: `commitSource()` (`app.js`) correlates each commit's `t` to the
  session whose turn-window contains it (short pre-roll, longer post-roll; on overlap the
  closest window then the innermost/latest-starting session wins), and `rollupSources()`
  reduces a burst to its dominant source — labelled **`mixed`** when more than one agent
  contributed. Brain, commit, and commit-burst rows render a colored `agentBadge()`
  (claude/codex/`mixed`); unattributable commits (no session window) show **no** badge
  rather than a guess. No server/data-model change — pure reduction over `git.json` +
  `timelineSessions()`.
- **§3.1 session↔plan — tier 1 done (2026-06-23, inferred, no self-report).** The runtime
  now stamps `session.currentPlan` from the files an agent touches: `planDocOf()`
  (`agent.js`) names any PLAN-ish markdown (`PLAN_*.md`, `*_PLAN.md`) the agent reads/edits,
  sticky on the session so it survives the agent moving on to code; surfaced on `publicView`
  and rendered as a `◆ PLAN_X.md` chip on the roster row (`agentRowHtml`). This is the *free*
  half — derived, no agent cooperation.
- **§3.1 session↔plan — tier 2 done (2026-06-23, self-report / ground truth).** The driven
  agent now *declares* what it's advancing via a new MCP **`report`** tool, alongside `ask`
  in the same stdio sidecar (`mcpAsk.js`): fire-and-forget (no human wait), it POSTs to
  loopback `POST /api/agent/internal/report` → `recordReport()` (`agent.js`), which stamps
  `session.declaredPlan` + `declaredNote` and surfaces them on `publicView`. The tool is
  allowlisted next to `ask` and the per-turn `--append-system-prompt` steers the agent to
  call it when it starts/switches a plan (the "skill" half — instruction, no separate file).
  The roster chip **prefers `declaredPlan` over the inferred `currentPlan`** and renders it
  brighter (a filled pill) to mark ground truth; the declared note rides in the tooltip.
  Belt-and-suspenders: declared when the agent reports, inferred otherwise. *Still open:*
  per-plan progress **attribution** (which checkbox an agent ticked).
- **Still open (as flagged in §3 / §6):** live **agent type** is hardcoded `claude` (Drive
  only spawns claude); the two-worlds clock skew (live runtime vs 2 s ingest poll) is
  unresolved.

The target design was the mockup `viberate-cockpit.jsx`. Every current-state claim below
cites a real file/symbol; inferences are marked **[assume]**.

## TL;DR — two findings that reframe the whole migration

1. **Production is not React.** `viberate-cockpit.jsx` is a React mockup, but the shipped
   dashboard (`public/app.js`, ~5500 lines) is a **vanilla-JS string-template SPA** — HTML
   built with template literals and an `el()`/`byId()` helper layer, no components, no
   virtual DOM. So the mockup is a **visual + data spec to re-implement**, not code to drop
   in. Every `NowCard`/`AgentRow`/`Ring`/`Sparkline` in the mockup maps to a *new render
   function* in the existing idiom, not a React component.

2. **The "Now" roster crosses a data boundary that does not exist today.** Everything the
   project view renders now comes from the **ingested history bundle** — `sessions/`,
   `git.json`, `docs.json`, `dochistory.json` — produced at `push` time or at Drive
   turn-end and read back through `/api/projects/:slug/*` (`src/storage.js`). The live
   per-agent roster (the heart of the cockpit) needs the **agent runtime's in-memory
   sessions** (`src/agent.js`, the `sessions` Map, surfaced via `/api/agent/sessions`) — a
   *different world* the project view never reads. **Bridging ingested-history and
   live-runtime is the single largest piece of new work**, and it's an architectural seam,
   not a styling change.

---

## 1. Current-state inventory

### 1.1 Stack & render path
- **Front end:** vanilla SPA, `public/app.js` + `public/style.css` + `public/index.html`.
  No framework. Views are strings assigned into `#conversation` (`public/index.html`).
- **Server:** Express, `src/server.js:134` (`startServer`). File-backed storage in
  `src/storage.js`; per-project dir under `$PROJECTS_DIR/{slug}/` (`project.json`,
  `sessions/`, `git.json`, `docs.json`, `dochistory.json`, `stream.json`, …).
- **Routes (client dispatch):** `boot()` `public/app.js:5543`. Public project view `/p/:slug`
  (`:5544`); token-scoped workspace dashboard `/app` (`:5591`); card view `/c/:id`. Both
  project routes funnel through `selectProject(slug)` (`:586`) → `renderTimeline()` (`:1281`).
- **Main render:** `renderTimeline()` `public/app.js:1281` builds the header
  (`:1292–1301`), the **Activity card**, the **centerpiece** (live brain), and brain
  history, then calls `liveBrain.attach(...)` (`:1337`).

### 1.2 The Activity block (headline stats)
- Rendered by **`overviewHeader(sessions)` `public/app.js:2424`** (verified). All counts are
  **computed client-side** from already-loaded state — there is no "stats" endpoint:
  - `convos = sessions.length` (`:2425`)
  - `messages = Σ s.userCount` (`:2426`)
  - `commits = windowCommits(sessions).length` (`:2427–2428`)
  - `brain = commits touching a brain doc` via `brainDocsOf(c)` (`:2429`)
  - `added/removed = Σ s.added / Σ s.removed` (`:2434–2435`)
  - agent split `claude = sessions.filter(s.source==='claude')`, `codex = …` (`:2432–2433`)
- **Data feeders:**
  - `state.projectData.sessions` ← `GET /api/projects/:slug` (`src/server.js:331`).
  - `state.activity.byId` ← `GET /api/projects/:slug/activity` → `getActivity(slug)`
    `src/storage.js:407`; per-session `{userCount, msgs[], files, added, removed}`, line
    counts derived by `editStat()` `src/storage.js:594` (parses Write/Edit/MultiEdit and
    Codex `apply_patch`). **Computed per request, not cached.**
  - `state.git.commits` ← `GET /api/projects/:slug/git` → `extractGit()` `src/git.js:18`;
    each commit `{hash, t, subject, files, isMerge, isRevert, docs:[{name,status}]}`.
- The workspace rollup `GET /api/workspace` → `getWorkspaceRollup()` `src/storage.js:381`
  produces the *cross-project* aggregate (`{projects, sessions, messages, commits, added,
  removed}`) — relevant if the cockpit ever shows an all-projects number, but the per-project
  page does not use it.

### 1.3 Per-day breakdown
- There is **no per-day calendar series**. The visual the screenshots call a "per-day
  breakdown" is **`renderRibbon(sessions)` `public/app.js:2452`** — a continuous,
  time-binned ribbon: commit ticks (`:2463`), a **120-bin heat lane** of message density
  (`:2470`, height `4+√n`, colored by dominant agent via `binColor`), conversation blocks
  (`:2498`), and a code-churn lane (`:2512`). Bucketing is **client-side**; the server
  ships raw timestamps (`msgs[].t`, `commits[].t`), never a daily roll-up. **[assume]** the
  "84 / 8" agent split in the screenshots is the same `claude/codex` count from
  `overviewHeader`, not a separate series.

### 1.4 Live-brain ring + task graph
- `renderCenterpiece()` `public/app.js:1717` → `liveBrain.panel()` (`:5100`); the force-sim
  graph + animation loop is the `liveBrain` object `public/app.js:4783–5184`.
- Nodes are **seeded from `state.docGraph.nodes`** (built in `selectProject`, `~:662`) —
  brain docs + ephemeral "hot" code nodes. Per-node **completion** `{done,total,pct}` is
  parsed **client-side from markdown checkboxes** (`~:4858`); the hero ring's aggregate
  "69 / 114" is summed across plan nodes (`plans[]` map, `~:4794`, `~:4938`). **There is no
  server-side task/plan/completion model** — confirmed: `src/` has only a loose `BRAINISH`
  doc filter (`src/docs.js:34`), no task schema.

### 1.5 Real-time mechanism (two separate systems — important)
- **Project view = polling.** `startLive()` `public/app.js:689` sets
  `setInterval(pollLive, 2000)` (`:697`); `pollLive()` (`:847`) GETs `/api/projects/:slug`,
  compares `updatedAt`, and on change calls `refreshLive()` (`:875`) which re-fetches the
  bundle endpoints and re-renders the Activity card + brain in place. **Cadence: 2 s poll of
  ingested data.**
- **Drive session = SSE, per session.** `new EventSource('/api/agent/sessions/'+id+
  '/stream?after='+…)` `public/app.js:4743` → server `GET /api/agent/sessions/:id/stream`
  `src/agentRoutes.js:281` (text/event-stream, `id: seq` frames, 15 s heartbeat, `?after=`
  backfill). This streams **one** session's events; it is **not** a project-wide feed.

---

## 2. Target-state spec (from `viberate-cockpit.jsx`)

Three zones in a single calm column (`maxWidth: 414`), plus the existing dense view demoted
behind a link.

| Zone | Mockup component | What it shows | Data it consumes |
|---|---|---|---|
| **Now** (the new heart) | `NowCard` / `AgentRow` / `Ring` / `StatusDot` / `CtxMeter` / `Sparkline` | Per-agent live roster: id, type, status, current task, plan/file, **elapsed timer**, **context %**; an aggregate completion `Ring`; a header summary ("N working · M waiting · K idle", "69/114 tasks · active 13m ago"); a merged-pulse sparkline | **Live agent runtime** (per-agent state, ticking) + aggregate task completion |
| **Latest** | `EventRow` / `Marker` | Calm event feed: brain-doc changes (◆ + subject), **commit bursts** ("18 commits", expandable to subjects, `+/−` diff), conversations ("9 messages") | `git.json` commits, `dochistory.json`, `activity` |
| **Next** | plan rows (progress bars) | 2–3 plans closest to done, each `name · N left · pct` | Per-**plan** completion |
| **Full timeline** | (link only) | The **existing** dense Activity + ribbon + brain | Unchanged — today's `overviewHeader` + `renderRibbon` + `renderCenterpiece` |

---

## 3. Gap analysis (core)

### 3.1 Per-agent telemetry — the roster
The live roster reads the agent runtime. The list endpoint exists — `GET
/api/agent/sessions` `src/agentRoutes.js:108` → `listSessions()` `src/agent.js:726` →
`publicView()` `src/agent.js:732` — but it is a **one-shot GET** and returns a **thin**
record (verified):

```js
publicView = { id, cwd, projectSlug, permissionMode, claudeSessionId,
               status, title, createdAt, lastEventAt, seq }   // agent.js:732
```

Per roster field (verdict + where the gap lives):

| Roster field | Verdict | Evidence / where it lives |
|---|---|---|
| stable id / label | **TRACKED** | `publicView.id`, `.title` (first prompt) `agent.js:732`. Filter roster by `projectSlug` for a per-project view. |
| **type (claude / codex)** | **NOT CAPTURED** | Drive only ever spawns the `claude` binary (`CLAUDE_BIN`, `agent.js:30`); session objects carry no `source`/`type`/`provider`. `source` exists **only** in *parsed* transcripts (`parsers.js`, `getActivity` sessions), not on live runtime sessions. **Gap: agent runtime + model.** The mockup's codex agents have no live counterpart today. |
| status (working / **waiting** / idle) | **PARTIAL** | `status` enum = `starting \| working \| idle \| error \| exited` (`agent.js:291,508,581`). **There is no `waiting` state** — the mockup's "waiting / awaiting review" does not exist. **Gap: new lifecycle state in the runtime** (`agent.js setStatus`). |
| current-task summary | **DERIVABLE, not surfaced** | Latest `{kind:'tool_use'}` / `user_prompt` / `title` in the SSE event log; not on `publicView`. **Gap: client must hold an SSE per agent, or the runtime must denormalize "last action" onto the list payload.** |
| plan / file it's touching | **TRACKED** | File is on `lastAction.file`. **Plan** comes two ways: inferred (`planDocOf` → `session.currentPlan`, the last PLAN-ish doc touched, sticky) and **declared** (`session.declaredPlan` via the MCP `report` tool — ground truth). Both on `publicView`; the roster `◆` chip prefers declared (brighter pill) over inferred. |
| **elapsed on current prompt** | **DERIVABLE, not stored** | Every event has `t` (`agent.js:312`); `user_prompt` (`:507`) → now gives elapsed. `publicView` exposes `createdAt`/`lastEventAt` but **not turn-start**. **Gap: stamp `promptStartedAt` on the session and add it to `publicView`,** else the timer can't tick from the list endpoint alone. |
| **context-window fill %** | **TRACKED in stream, not in list** | Emitted as `{kind:'usage', usage:{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens}}` per `message_start` (`agent.js:373–387`); model via `{kind:'system', model}`. Client computes `pct = (input+cacheRead+cacheCreate)/windowOf(model)` (`parsers.js:38–54`; `windowOf` 200k/1M). **Gap: this lives on the per-session SSE, not on `/api/agent/sessions`,** so a roster meter needs the value denormalized onto the list payload or N live streams. |

**Concurrency is fine:** `sessions` is a `Map` (`agent.js:275`); many sessions run in
parallel, one process per turn (`agent.js:532`); `listSessions()` already returns all of
them. So a *roster* is supported — the gap is **richness of the payload** and **a live
transport for it**, not the existence of multiple agents.

**Transport gap (call this out):** there is **no project-wide agent-state stream**. The
choices are (a) **poll** `/api/agent/sessions` on a cadence, or (b) open **N per-session
SSE** (`/api/agent/sessions/:id/stream`), or (c) **build a new aggregate SSE** that fans the
runtime's per-session events into one project-scoped channel. (c) is the clean answer for
ticking timers + context meters across many agents; it's new server surface in
`src/agentRoutes.js` / `src/agent.js`.

### 3.2 Event feed ("Latest")
- **Commit bursts ("18 commits").** Commits are available with `{hash,t,subject,files,
  isMerge,isRevert,docs[]}` (`git.js:18`). Grouping into bursts by **time window** is a
  pure client-side reduction over `commits[].t`. ~~But commits carry no agent attribution.~~
  **RESOLVED (2026-06-23):** the time-window correlation flagged here as **[assume]** is
  shipped — `commitSource()` maps a commit to the session whose `[start, end]` (+grace)
  window it falls in, `rollupSources()` picks a burst's dominant source (or `mixed`), and
  `agentBadge()` labels the row. No commit→agent ingest metadata was needed; attribution is
  a heuristic over existing timestamps, so a commit outside any session window stays
  **unlabelled** (correct — better than a false guess).
- **Brain-doc changes as discrete events.** **Available.** Each commit's `docs:[{name,
  status}]` (`git.js`) plus `dochistory.json` (`extractDocHistory()` `src/git.js:79`, keyed
  by path → `[{hash,t,status,content}]`) yields a subject + hash + file + content per
  change. The mockup's `PLAN_CAPACITOR.md` ◆ row is directly buildable.
- **Conversations as feed events with a message count.** **Available** from `getActivity()`:
  `{title, userCount, startedAt, endedAt, source}` per session. The "9 messages" row is
  `userCount`.

### 3.3 Plans ("Next")
- **Per-plan completion IS available** — it's exactly the per-node `{done,total,pct}` the
  `liveBrain` graph already parses from each `PLAN_*.md`'s checkboxes (`app.js:~4858`); the
  "69/114" hero number is the **sum** of those nodes. So "Next" needs the **un-summed**
  per-plan values, sorted by closeness to done. **No new server surface required** for the
  numbers themselves.
- **Plan ↔ task association** = checkbox lines *within each* `PLAN_*.md`. There is **no
  cross-file task graph and no server task model** (confirmed, §1.4). "Tasks left" per plan
  = `total − done` from that file's checkboxes. **Gap (only if we want it server-side):**
  promote this client parse into the bundle so it's not recomputed everywhere.

### 3.4 Merged-pulse sparkline
- **Derivable, no new aggregate strictly required.** A single combined series can be reduced
  client-side from existing timestamps (`msgs[].t`, `commits[].t`) — `renderRibbon` already
  bins into 120 buckets (`app.js:2470`); the sparkline is the same reduction at daily/30-pt
  resolution. **[assume]** a precomputed daily series in the bundle would be cheaper than
  re-binning on every render, but it is an optimization, not a blocker.

---

## 4. Navigation / information-architecture changes
- **Today's home** for a project is `renderTimeline()` (`app.js:1281`), reached from
  `/p/:slug` (`:5544`) and `/app` (`:5591`) via `selectProject()` (`:586`).
- **Target:** the **cockpit becomes the default** body of `renderTimeline()`; the existing
  dense stack (`overviewHeader` + `renderRibbon` + `renderCenterpiece`) moves **behind a
  "Full timeline →" link** (present in the mockup's `NowCard` footer and the "All activity →"
  / "6 plans →" section links).
- **Implementation options:** (a) a new view-state flag (`state.view = 'cockpit' |
  'timeline'`) toggled within the same route, or (b) a real sub-route (e.g.
  `/p/:slug/timeline`). (b) preserves deep-linkability and is the cleaner cutover.
- **Things that assume the old view is home:** the live-poll wiring (`startLive`/`pollLive`,
  `:689`/`:847`) currently refreshes the Activity card and brain specifically
  (`refreshActivityCard()` `:995`) — the cockpit's "Now"/"Latest" need their own refresh
  targets. Card deep links `/c/:id` are independent and unaffected.

## 5. Component-level change list (mockup → real)
Mockup pieces are React; the work is to author equivalent **render functions** in
`public/app.js`'s string-template idiom + CSS in `public/style.css`.

**NEW**
- `NowCard` → a `renderNowCard()` reading enriched `listSessions()` (per-project filter),
  with the agent runtime transport from §3.1.
- `AgentRow`, `StatusDot`, `CtxMeter` → per-agent row + status dot + context meter
  (CtxMeter reuses the `pctColor`/`ctxColor` gradient idea; see `pctColor` `app.js:2397`).
- `Ring` (aggregate completion) → **reuse the existing ring**: `gcprog`/`dvb-prog`
  stroke-dasharray rings already exist (`app.js:1792`, `:5107`) with `pctColor`.
- `Sparkline` (merged pulse) → new, but fed by the same binning `renderRibbon` uses.
- `EventRow`/`Marker` (Latest feed) + plan rows (Next) → new render functions over
  `git`/`dochistory`/`activity` and per-plan completion.

**MODIFIED**
- `renderTimeline()` `:1281` — becomes the cockpit composer; `overviewHeader()` `:2424`
  demoted to the Full-timeline view.
- `publicView()`/`listSessions()` `agent.js:726–745` — **enrich** with `type`,
  `promptStartedAt`, last-action summary, and latest context `%` (or add an aggregate
  stream).
- `setStatus()` `agent.js:326` — add a `waiting` lifecycle state.

**RELOCATED**
- `renderRibbon()` `:2452` and `renderCenterpiece()` `:1717` → moved behind "Full timeline".

**REMOVED**
- None outright; the dense view is **demoted, not deleted** (it remains the Full-timeline).

**Shared primitives worth extracting:** the dasharray completion ring (`gcprog`/`dvb-prog`),
`pctColor`/`ctxColor`, the time-binning in `renderRibbon`, and the format helpers (`fmtN`,
`fmtAgo`, `fmtShort`, `plw`).

## 6. Open questions & risks
- **Default roster sort.** Mockup sorts `working → waiting → idle`, then by elapsed
  (`NowCard` `sorted`). Signals available today: `status` (TRACKED, but no `waiting`),
  elapsed (DERIVABLE), context-critical (DERIVABLE from usage), `error` (TRACKED). A
  "needs-attention" sort (waiting-for-review / errored / context-critical first) needs the
  **new `waiting` state** and context% **on the list payload**. Decision pending.
- **Scale at 10+ agents.** `listSessions()` is unbounded; the mockup already handles overflow
  ("+N more" with dots). Flat list vs. **group by `projectSlug`/plan** is an open call once
  rosters get large.
- **Real-time transport & cost.** Ticking timers + live context meters across many agents:
  poll `/api/agent/sessions` (cheap, coarse) vs N SSE (rich, heavy) vs **one aggregate SSE**
  (new surface). Cadence/cost trade-off is unresolved (see §3.1c).
- **The two-worlds reconciliation (biggest risk).** "Now" is live-runtime; "Latest"/"Next"
  are ingested-history. They update on different clocks (SSE vs 2 s bundle poll) and can
  disagree (a commit exists in git.json only after ingest; an agent is "working" in the
  runtime before any commit lands). The cockpit header ("active 13m ago" next to live
  tickers) must define which clock wins.
- **Not currently captured (upstream work):** live-session **agent type** (Drive only spawns
  `claude`); **per-plan progress attribution** (which checkbox an agent ticked). (Shipped
  2026-06-23: the **`waiting`** status; **commit→agent** attribution, §3.2; **session↔plan
  tier 1** inferred from touched files and **tier 2** self-reported via the MCP `report`
  tool, §3.1.) What's left is mostly the live agent-type capture; session↔plan is now
  covered both inferred and declared.

## 7. Suggested sequencing
1. **Unblock the roster data (runtime work).** Enrich `publicView`/`listSessions`
   (`agent.js:726`) with `type`, `promptStartedAt` (→ elapsed), last-action summary, and
   latest context `%`; add the `waiting` lifecycle state (`setStatus` `:326`). Ship behind
   the existing view — no UI change yet.
2. **Live transport.** Add a project-scoped aggregate stream (or, MVP, poll the enriched
   list). Validate ticking timers + meters across ≥3 concurrent sessions.
3. **Build "Now"** against the enriched data; keep the dense view as home until parity.
4. **Build "Latest" + "Next"** from existing `git`/`dochistory`/`activity` + per-plan
   completion (mostly client-side; no server blockers). Add commit→agent attribution if the
   burst rows need agent labels.
5. **Merged sparkline** (client reduction; optional precomputed daily series later).
6. **Route cutover.** Make the cockpit the default `renderTimeline()` body; move the dense
   stack to `/p/:slug/timeline` ("Full timeline →"). Wire the live refresh to the new
   zones.

What can ship *behind* the current view before cutover: steps 1–2 (pure runtime/API), and
the "Latest"/"Next" data plumbing (step 4 data layer), since they don't disturb the existing
home until step 6 flips the default.

---

### Appendix — primary source map
- Front end: `public/app.js` — `boot` `:5543`, `selectProject` `:586`, `renderTimeline`
  `:1281`, `overviewHeader` `:2424`, `renderRibbon` `:2452`, `renderCenterpiece` `:1717`,
  `liveBrain` `:4783`, live poll `startLive` `:689` / `pollLive` `:847` / `refreshLive`
  `:875`, per-session SSE `:4743`.
- Server/data: `src/server.js` (routes `:134+`), `src/storage.js` (`getActivity` `:407`,
  `editStat` `:594`, `getWorkspaceRollup` `:381`), `src/git.js` (`extractGit` `:18`,
  `extractDocHistory` `:79`), `src/docs.js` (`BRAINISH` `:34`).
- Agent runtime: `src/agent.js` (`sessions` Map `:275`, `createSession` `:283`, `setStatus`
  `:326`, usage emit `:373–387`, `listSessions`/`publicView` `:726–745`), `src/agentRoutes.js`
  (`/api/agent/sessions` `:108`, `/stream` `:281`).
