# PLAN_HARNESS_VERSIONING.md — keeping the Claude Code / Codex harness current, observable, and safe

How VibeRate stays on the **latest** coding-agent harness (Claude Code today,
Codex alongside it) **without** silently breaking when Anthropic ships a release
that changes the output schema we parse. The product stance (Mike, 2026-06-23):
*don't pin — auto-grab latest; it's our job to adapt the UI to new updates.* This
plan makes "auto-latest" **deterministic, observable, and gated by a tripwire** so
"adapt the UI" happens on our schedule, before a user hits a broken session — not
after.

Companion to `PLAN_AGENT_RUNTIME.md` (the runtime that spawns `claude`), feeds the
home-dashboard **harness rail** in `PLAN_COCKPIT.md`, and is the concrete answer to
the *upstream schema-drift* risk flagged in `STORY.md` Ch.10. Context on what
actually drifts: the coupling inventory in §1 below.

## TL;DR

- **Today the version is neither pinned nor reliably latest** — it's frozen at
  whatever `@latest` resolved the last time one Docker layer happened to build
  (could be weeks ago). A Fly redeploy updates it *nondeterministically* (depends
  purely on layer-cache hit/miss). We can't see what's running and can't predict
  when it changes.
- **Three pieces, smallest-first:** (1) **surface the live version** we already
  receive but throw away; (2) **make "latest" deterministic** (bust the install
  layer so every deploy truly re-pulls); (3) **smoke-gate** every update with a
  golden-transcript test so a schema change fails CI red and pings us instead of
  breaking a live turn.
- **Dashboard centerpiece** (the "harness rail") is the *read* surface over #1: per
  harness — Claude/Codex icon, running version, release date, "N behind" / "⚠
  permission changes" drift badge. Lives in the cockpit home; spec'd in
  `PLAN_COCKPIT.md`.
- **Deferred:** full in-app runtime version-swap admin (install many versions, flip
  active per-session live, instant rollback). Only pays off post multi-user, which
  is itself deferred (`[[onboarding-deferred]]`).

---

## Implementation status (2026-06-23) — WS1–WS4 shipped

The version-plumbing, deterministic-latest, smoke-gate, and one-command bump are
**built**. WS5's *data* is live; its cockpit *rendering* stays with
`PLAN_COCKPIT.md`. WS6 remains deferred.

| WS | State | Where it landed |
|---|---|---|
| **WS1** surface the version | ✅ shipped | `src/harness.js` (new: host-sample + build-file + live-init + npm-latest + drift). `agent.js` captures the init-event version onto the session (`harnessVersion`, in `publicView`) and feeds `recordLiveVersion`. Read API: `GET /api/agent/harness` (`agentRoutes.js`). |
| **WS2** deterministic latest | ✅ shipped | `Dockerfile` `ARG CLAUDE_CACHE_BUST` busts the `claude` install layer and bakes the resolved version to `/opt/vbrt/harness.json`; `fly.toml` `[build.args] CLAUDE_CACHE_BUST` makes the bust a tracked, deploy-read value. |
| **WS3** smoke-gate | ✅ shipped | `test/harness-smoke.test.mjs` + `test/fixtures/claude-stream.jsonl` & `claude-transcript.jsonl`. Pipes golden fixtures through the **real** parsers (`agent.js` `__replayForTest`, `parsers.parseClaude`, `hooks.eventFromPayload`) and asserts the §0 coupling list. `npm test`. |
| **WS4** one-command bump | ✅ shipped | `vbrt harness` (status) / `vbrt harness bump`: changelog-diff w/ permission canaries → scratch-install the candidate → smoke-gate → bump `CLAUDE_CACHE_BUST`. `npm run bump-harness`. Drift/changelog helpers in `harness.js` (`changelogDrift`, `cmpSemver`, `behindCount`). |
| **WS5** harness rail | ✅ shipped | Render landed in the **overarching workspace home** (not the per-project cockpit — see the placement note below): `renderHarnessRail`/`renderHarnessCard`/`loadHarnessRail` in `public/app.js`, mounted at `#harness-rail` in `bootDashboard`, gated by `ensureDriveProbe()` (admin/drive rights), styled in `style.css` (`.harness-rail`/`.harness-card`). Per harness: installed version + source (host/build/live), drift badge (✓ up to date · N behind · latest unknown · not installed), latest version + release age, and a copy-to-clipboard `npm run bump-harness` when outdated. Data still from `/api/agent/harness` (`harnessReport()`). |
| **WS6** runtime swap admin | ⏸ deferred | Untouched; the `VBRT_CLAUDE_BIN` seam is preserved. |

Verified live: `vbrt harness` reads claude **2.1.185** (host) vs latest **2.1.186**
("1 behind"); the full `bump` flow runs the changelog canary scan + 13-check smoke
gate green and bumps the cache-bust. The `/api/agent/harness` route mounts under the
same admin/loopback guard as the rest of the control plane.

**Placement note (2026-06-24, Mike):** the rail lives in the **overarching workspace
home** (`#ws-overview` sibling), not a per-project cockpit, because the harness is
*instance-global* — one Fly host, one `claude`/`codex` binary shared by every project.
Version + drift are a property of the instance, so a per-project cockpit would repeat
the same card on every project. (The cockpit `PLAN_COCKPIT.md` "Now/Latest/Next" stays
per-project; the harness rail is the one home-level, cross-project element.)

**Follow-up (not yet wired):** the drift badge shows "N behind" but **not** the "⚠
permission changes in 2.1.18x" canary the WS5 spec calls for. The canary data already
exists (`changelogDrift` → `canaries`, used by the `bump` CLI) — surfacing it in the
rail just needs `harnessReport()` to fold a (cached) changelog scan into each harness's
payload, then a `⚠` variant of `.hc-badge`. Deferred as a cheap enhancement; the
behind-count is the core "are we drifting" signal and ships today.

---

## 0. Current state — ground truth from the code

| Fact | Where | Implication |
|---|---|---|
| `claude` installed unpinned at image-build | `Dockerfile:50` — `RUN npm install -g @anthropic-ai/claude-code` | Version = whatever `@latest` was when this **layer** last actually executed. |
| `npm start` = `node bin/vbrt.js serve` | `package.json` scripts; `Dockerfile:66` `CMD` | **Nothing re-installs or updates `claude` at boot.** The running machine never changes the binary on its own. |
| Runtime spawns the binary behind an env seam | `src/agent.js:30` — `const CLAUDE_BIN = process.env.VBRT_CLAUDE_BIN \|\| 'claude'` | We can already point the runtime at *any* binary path with **zero code change** — the hook for multi-version / staged installs. |
| We already receive the version, then discard it | `src/agent.js:463-473` — `system`/`init` event carries `model`, `tools`; the raw `init` payload includes the CLI version | **The data for "what's running" is already in hand — we just don't store/show it.** This is the cheapest win. |
| Harness is already a first-class dimension | `source: 'claude' \| 'codex'` threaded through `src/parsers.js`, `src/evidence.js` (`parseClaude`/`parseCodex`), `src/discover.js`, `src/workspace.js` | The "available harnesses" rail renders a concept the pipeline **already carries** — not new modeling. |

### The redeploy nondeterminism (the actual bug)

`Dockerfile:50`'s instruction text never changes, and it sits *after* `COPY
package.json` + `npm ci` + the Playwright install. Docker re-runs a `RUN` layer only
if its text changes or an earlier layer changed. So:

- Redeploy with **warm** build cache + unchanged `package.json` → **cache hit** →
  the install line does **not** re-run → **old Claude version kept.**
- Redeploy with **cold** cache (fresh builder, evicted cache, or `package.json`
  touched) → re-runs → grabs newest.

Result: a redeploy updates Claude Code **sometimes**, with nothing telling us which
happened. That's what we're killing.

### What "schema drift" concretely threatens (coupling inventory)

The surfaces that break if Anthropic changes the harness output, ranked by churn
(from the changelog trend: permission model + tool names move most; message
envelope is stable-but-undocumented):

1. **`--permission-mode` / auto-mode prompting** (`agent.js:598-602`) — *highest*.
   Stricter auto-mode prompting can stall a headless driven turn waiting on a
   prompt nobody answers.
2. **`stream-json` event shape** — `system/init`, `stream_event` (nested Anthropic
   SSE), `assistant`, `user`, `parent_tool_use_id` (`agent.js:461-549`) — *high*.
   The whole live UI rides this; undocumented + unversioned.
3. **JSONL transcript schema** — `type`/`message.role`/`content[]`/`usage`
   (`parsers.js:38-195`, `hooks.js:83-89`) — *medium*. Long-stable envelope;
   changes have been additive (e.g. `thinking` blocks).
4. **Hook event names + payload** (`hooks.js:98-129`) — *medium*. They keep *adding*
   hooks; a new one = missed signal, not a crash.
5. **CLI flags, MCP config shape, `CLAUDE_CONFIG_DIR` paths, `.credentials.json`**
   (`agent.js:141-168`, `594-623`) — *lower*; sticky conventions, some fallbacks
   already exist.

Upstream facts feeding this plan: Claude Code is **public-but-closed** (the repo is
an issue tracker + changelog; binary ships compiled; near-daily releases, currently
~2.1.186). Internal prompts/flags/schemas shift between releases and are tracked
unofficially by `marckrenn/claude-code-changelog`. Codex (`openai/codex`) is fully
open source with its own changelog. Best canary: watch the official changelog for
the word **"permission"** and the marckrenn prompt-diffs.

---

## 1. Workstreams

### WS1 — Surface the live version (do first; unblocks everything)

The running binary already announces itself in the `system/init` event
(`agent.js:463`). Capture and persist it.

- In `handleRawEvent` (`agent.js`), read the version field off the raw `init`
  payload and stash on the session (alongside `session.model`).
- Persist it with the session record (`src/storage.js`) so it survives and can be
  rolled up per project.
- Add a tiny server-side cache of the **host's** `claude --version` (and
  `codex --version` if present) sampled at boot / on demand — this is the
  authoritative "what this instance runs," independent of whether a session is live.
- Expose via a small read endpoint (extend the existing agent-config route —
  `agentRoutes.js:105` already returns `{ bin, defaultCwd }`; add `version`,
  `latest`, `releaseDate`).

**Done when:** the API can answer "what Claude Code / Codex version is this instance
running" without a live session.

### WS2 — Make "latest" deterministic

Kill the layer-cache nondeterminism so a deploy is a *reliable* update trigger.

- Bust the install layer on demand: a build `ARG CLAUDE_CACHE_BUST` placed right
  before `Dockerfile:50` (bumped by the deploy script / CI), **or** move the global
  install to after `COPY . .` so any source change re-pulls. Prefer the explicit
  `ARG` — it makes "I am updating the harness" a deliberate, logged act.
- Record the resolved version into the image at build (write
  `claude --version` to a file the server reads) so WS1 has a build-time source of
  truth even before any session runs.
- Keep using the npm channel for now (simplest to pin/bust in Docker) even though
  Anthropic has deprecated it in favour of `curl | bash`; revisit the installer
  channel only if npm distribution stops working.

**Done when:** `fly deploy` (with the cache-bust bumped) is guaranteed to install
the newest Claude Code, every time, and the image knows its own version.

### WS3 — The smoke-gate (makes auto-latest *safe*)

A golden-transcript test that proves the schema we parse still holds — run in CI
**before** an updated image ships.

- Fixtures: one captured **stream-json** session (the `agent.js` path) + one
  **JSONL** transcript (the `parsers.js` / `hooks.js` path), checked into the repo.
- Test: pipe each through the real parsers and assert the load-bearing shape —
  `system/init` fields, `stream_event` nesting, content-block types, `usage` keys,
  hook event names. Focus on the §0 coupling list.
- Wire as a **pre-deploy gate**: CI installs the candidate Claude Code, runs the
  smoke test against it; **red blocks the deploy and pings us.** This is the
  "adapt the UI before users hit it" tripwire.
- Bonus signal: a step that fetches the changelog diff since our last shipped
  version and greps for `permission` / removed tools, surfaced in the CI log.

**Done when:** a Claude release that changes a parsed field turns CI red with a
pointer to the broken assumption, instead of breaking a live session silently.

### WS4 — One-command update flow (developer ergonomics)

The "dead simple + quick safety check" loop Mike asked for, as a single command.

- `npm run bump-harness` (or `vbrt harness bump`): installs the candidate to a
  scratch path, runs WS3's smoke test against it locally, prints the changelog diff
  with canaries highlighted, and bumps the `CLAUDE_CACHE_BUST` arg. Green → you
  deploy with confidence; red → you see exactly what to fix first.
- Optional calendar-automatic: a nightly GitHub Action that runs the bump + smoke +
  `fly deploy`, so "auto-latest" happens without anyone remembering — and stays
  safe because the gate is in the path.

**Done when:** updating the harness is one command that tells you whether it's safe.

### WS5 — Dashboard "harness rail" (the centerpiece)

The home-dashboard element Mike pictured. **Spec and sequence live in
`PLAN_COCKPIT.md`** (it's a cockpit home component); this plan owns the *data* it
renders (WS1) and the *drift* computation.

- Per harness: Claude / Codex icon, **running version**, **release date**, and a
  **drift badge** — "N releases behind" and/or "⚠ permission changes in 2.1.18x"
  computed by diffing running-vs-latest against the changelog canaries.
- "Latest available" comes from polling the npm registry / GitHub releases
  (cache server-side; don't hammer on every render).
- Primary action = **deploy latest** (kicks WS4's flow) or copy-the-command;
  **not** a live runtime swap (that's WS6).

**Done when:** the home dashboard shows, at a glance, which harnesses are installed,
their versions/dates, and whether we're drifting from upstream.

### WS6 — (Deferred) in-app runtime version-swap admin

Install multiple pinned versions to volume paths; flip the active one per-session
via the `VBRT_CLAUDE_BIN` seam (`agent.js:30`); stage-and-smoke a new version live;
instant rollback. A real privileged admin panel. **Defer** until we can't casually
redeploy — i.e. real multi-user, which is itself deferred
(`[[onboarding-deferred]]`). Noted here so the `VBRT_CLAUDE_BIN` seam isn't
"refactored away" before it's needed.

---

## 2. Sequencing

1. **WS1** — surface the version (cheap; unblocks the rail and any update flow).
2. **WS2 + WS3** — deterministic latest + smoke-gate (the safety core; do together).
3. **WS4** — one-command bump (ergonomics over WS2/WS3).
4. **WS5** — harness rail in the cockpit (read surface; coordinate with
   `PLAN_COCKPIT.md` sequencing §7).
5. **WS6** — deferred until multi-user.

## 3. Open questions

- **Codex parity:** WS1/WS5 should treat Codex symmetrically (we already parse it),
  but Codex's version/release feed and install path differ — confirm before the rail
  claims to cover it.
- **Calendar auto-deploy (WS4 nightly):** do we want unattended nightly updates, or
  human-in-the-loop "green, click deploy"? Leaning human-in-the-loop until the
  smoke-gate has proven itself over a few releases.
- **Fixture freshness:** the golden transcripts must be re-captured occasionally as
  *our own* usage evolves, or they'll assert against a stale shape. Capture them
  from a real driven session, not hand-authored.
