---
name: viberate
description: Capture this repository's Claude Code / Codex sessions and publish them to VibeRate — an interactive, link-shareable dashboard of the user's prompts, file changes, git timeline, evidence, and agent docs. Use this whenever the user wants to share, review, visualize, publish, watch, or get feedback on their agent work or coding history, asks to "push to viberate" or "vbrt", or wants a shareable link to what they just built — even if they don't say "viberate" explicitly.
allowed-tools: Bash(node *)
---

# VibeRate

Publish this repository's agent sessions to the hosted VibeRate viewer and hand the user a shareable link. The skill is a thin push client — it never runs a local server. VibeRate is the viewer and feedback layer for terminal-agent development: prompts, file changes, git history, evidence, and brain docs in one readable project dashboard.

## When to use

Trigger when the user wants to share / review / visualize / publish their agent work, get feedback on a session, or get a link to what they just built. Phrases: "share this session", "push to viberate", "vbrt", "show me a dashboard of my work", "make a link of this".

## How to run

Run from the **repository root** (the folder whose sessions should be published — the place the user ran Claude Code or Codex):

```bash
VBRT_API_URL="${VBRT_API_URL:-https://vbrt.fly.dev}" node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all
```

- `push --all` selects every session discovered for this folder, non-interactively (no prompts). **Always pass `--all`** — bare `vbrt push` opens an interactive session picker you can't drive.
- If `vbrt` is on your `PATH` (a global install, or running under **Codex**), drop the `node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js"` prefix and just run `vbrt push --all` / `vbrt shot …` / `vbrt watch`. Same commands, agent-agnostic.
- On success the command prints `✓ Pushed project ... view & share at:` followed by a URL like `https://vbrt.fly.dev/p/<id>`. **Give that full URL to the user** — that's their shareable dashboard.
- Hosted pushes are **private by default**. To make an existing pushed link shareable
  without uploading the bundle again, run `vbrt publish --public`. To pull it back,
  run `vbrt publish --private`. Conversations are scrubbed for obvious secrets (API
  keys, tokens, private keys) before upload, but a public link is still a shareable
  surface.

## Before you build (preflight + project size)

**Always run `vbrt doctor` first**, before your first capture or push. In a few
seconds it reports whether this is a git repo, whether `vbrt watch` is already live,
whether headless capture works (Playwright + browser), and prints the exact `shot`
command to use. Trust its output — don't discover capabilities by trial and error.

- **If `vbrt watch` is live** (doctor says so): it streams changes automatically.
  **Do not run `vbrt push --all`** at the end — only push manually if watch errors or
  the user asks. Capture artifacts normally; they ride the stream.
- **For a real-time ticker (Claude Code), wire the hooks once:** `vbrt hooks --install`
  merges `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` hooks into
  `.claude/settings.json`. Each fires `vbrt hook`, a fast dependency-free process that
  appends the agent's live activity (working/idle, current action, context load) to
  `.vbrt/stream.jsonl`, which `vbrt watch` streams to the dashboard ticker — **no token
  cost** (hooks run in the harness, not the model). Without it the ticker still works,
  but lags ~20–30s behind the session-log flush. (Codex writes its log per event, so it
  needs no hook.)
- **Need the share link, or unsure what's going on? Run `vbrt status`** — it shows in
  one glance whether watch is live, the **project URL**, how much evidence is captured,
  anything queued in the outbox, and whether a manual push is needed. Use it instead of
  pushing just to get a URL (that's what caused redundant pushes + rate-limit errors).
- **End with `vbrt status`.** Make it the final source of truth before reporting back:
  it should show the project URL, visibility, evidence count, outbox state, and whether
  a manual push is still needed.
- **Scale the process to the work — lean is the default.** Don't stand up a
  mini project-management system for a small build. Default to:
  - **`DEVLOG.md` + `README.md` only** for small experiments. Do **not** create
    `ROADMAP.md`, `PLAN_*.md`, `TASKS.md`, or similar ceremony unless the work is
    multi-session, the user asks, or the repo already uses those docs. `DECISIONS.md`
    only when a real fork was decided.
  - **2–3 artifacts total** for a small app — typically one *before*, one final
    *clip*, maybe one final *shot*. More is ceremony, not evidence.
  - Commit at meaningful milestones, not every micro-phase.

  The brain conventions below are how to make work legible *when there's enough of
  it* — not homework for a toy app. More ceremony than product is a failure mode, not
  discipline. (Scale **up** to the full conventions for a real, multi-session project.)
- **Make your UI capturable.** When you build something visual, support
  **deep-link / query params** that drive its state — e.g. `?autoplay=1&speed=10&view=x`.
  Then a single `vbrt shot "<url>?autoplay=1&…"` (or `--clip`) reproduces exactly the
  state worth showing, with no scripting or manual interaction. This is the cheapest
  way to make motion/UI work recordable.

## Capturing evidence (screenshots) for a prompt

When you make a **visible UI change**, capture a before/after screenshot so it shows on the prompt that produced it. One line; it binds itself to the current conversation — no session/turn id needed.

Point it at **the app's URL** — normally its **deployed site** (reachable from anywhere for headless capture, and it reflects the real shipped state). Use a `localhost` dev URL only if that's literally where the app is running.

**Default order:** commit the first working version before capture, unless the user
explicitly wants a pre/post comparison. Evidence is most useful when it ties to a
git checkpoint; `vbrt shot` will warn if there is no commit yet.

```bash
# before the change (current live state):
node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" shot https://<your-app>.fly.dev --label before --note "baseline"
# make + deploy the change, then:
node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" shot https://<your-app>.fly.dev --label after  --note "what changed"
```

- `--label before` before editing, `--label after` once it's live; they render side by side on the prompt card.
- **Don't point `shot` at VibeRate itself** — `push` already sends there. `shot` captures *your app*.
- Already have an image (or gif/clip)? Register it instead of a URL: `shot ./screenshot.png --label after` (also accepts `.gif` / `.webm`).
- Stored locally, uploaded on the next `push` (or live under `vbrt watch`). UI/visual work only — backend changes don't need it.

**Motion: capture a clip** when the change is only legible animated (transitions, easing, a sort/animation running, hover/drag feedback). Records a few seconds of the URL:

```bash
node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" shot http://localhost:5173 --clip 8 --label after --note "merge animation"
```

- `--clip [seconds]` is a **cap, not a fixed length**. The clip records from first paint and **auto-stops once the motion settles**, so length tracks the real animation — a button toggle gives a ~1s loop, a long sim runs to the cap. You don't need to tune the app's speed to fill a fixed window (that's what left a 6s clip mostly static). Produces a **gif** (if `ffmpeg`) else a **webm**; both loop in the reader.
- Pick the cap as "at most this long" (default 8, max 20); keep `--viewport` modest (e.g. `960x600`) since clips inline into the bundle. If the output says it *hit the cap*, the motion was still going — raise it.
- For animated apps, games, simulations, visualizers, drag/drop, hover states, or
  transition-heavy UI, capture **at least one `--clip` after the first commit**. A
  final still alone is not enough evidence for motion-first work.

### Capturing a state behind an interaction

If the shot needs a state the URL alone can't show — a modal open, a menu expanded, a
detail/lightbox you reach by clicking — drive the page there with `--click`, then
`--wait` for the state to settle. Don't hand-roll a browser script for this; that's
what these flags are for.

```bash
node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" shot https://<your-app> \
  --click '.theme-menu' --click 'text=Dark' \
  --wait '.app.theme-dark' --label after --note "dark mode"
```

- `--click <selector>` clicks it (Playwright auto-waits for it to be actionable); pass
  `--click` more than once to click **in sequence** (open a menu → pick an item).
- `--wait <selector|ms>` holds until that element appears (or N milliseconds) before the
  shot — use it so the final state has rendered.
- Works with `--clip` too: click to *start* an animation, then record what it triggers.
- **Prefer a URL param** if your app has one (`?theme=dark` is cheaper and reusable);
  reach for `--click`/`--wait` only when no param gets you to the state.

### If capture fails — the decision tree (don't improvise)

URL/clip capture needs Playwright **and** a browser binary. If `vbrt shot <url>` reports
Playwright is missing or a browser is unavailable:

1. Install it **in this repo** and re-run the *same* command — vbrt resolves Playwright
   from the repo's own `node_modules`:
   ```bash
   npm i -D playwright && npx playwright install chromium
   ```
2. If that's not possible (no network, headless capture unavailable), **fall back to a
   file**: take the screenshot/clip with your own tooling and register it —
   ```bash
   vbrt shot ./shot.png --label after --note "…"   # also accepts .gif / .webm
   ```
3. **Do NOT** edit `NODE_PATH`, inspect the skill install, or write a custom capture
   script to work around resolution — that is never the fix and just burns time. The two
   options above are the only ones.

## Making your work legible in VibeRate (brain conventions)

VibeRate renders this repo's **brain** — the agent/architecture docs — as a live graph, and any `.md` with a checklist as completion rings on a timeline. A few zero-cost conventions make your work show up well, in any project:

- **The graph is built by reachability.** A markdown doc becomes a brain node only if it has a known name (`SOUL`/`AGENTS`/`CLAUDE`/`SEED`/`CONTEXT`/`MEMORY`/`ROADMAP`/`DECISIONS`/`README`/…) **or** is **linked by name** from a doc already in the brain. So when you create a new brain doc, **reference it by its filename** from a seed (e.g. add `PLAN_x.md` to `ROADMAP.md`). An unlinked "orphan" doc won't appear in the live graph — it only surfaces once committed, via git history.
- **Any doc with a checklist gets a completion ring.** Give a doc a `- [ ]` checklist and **link it from a seed (e.g. `ROADMAP.md`) at creation**. VibeRate draws a ring from the checked ratio — no special filename needed (a `PLAN_<name>.md` is just a readable convention). **Check the boxes as you go** and the ring fills live; write-then-complete-then-commit and it just snaps to done at the commit.
- **Finished checklists retire to the graveyard automatically — do nothing.** When a doc's checklist hits **100%**, VibeRate moves it to the brain graveyard on its own: it drops out of the live web while the file stays on disk (and ghosts back in time-travel). No marker, no `git rm`, no extra step — completion *is* the signal, regardless of filename. Only the exceptions need a one-line `status:` frontmatter:
  - Keep a finished checklist visible anyway → `status: active` (also `live`/`pinned`/`wip`).
  - Retire a doc that has no 100% checklist → `status: archived`.
  ```
  ---
  status: active
  ---
  ```
  Never `git rm` a doc to "archive" it — that loses the doc; retirement is visual-only.
- **Commits are the brain's checkpoints.** The live graph updates on save for reachable docs and on commit for git-derived history — so commit at meaningful boundaries (per plan / per phase). That's the timeline the viewer shows.
- **Keep a dev journal.** A dated `DEVLOG.md` plus a `DECISIONS.md` (one line + the *why* per decision) give the brain a narrative spine and make choices traceable — the heart of "a living history of how you and your agents changed this project."

## Local / self-hosted testing

Point the client at a running host by setting the endpoint, e.g.:

```bash
VBRT_API_URL="http://localhost:4317" node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all
```

## If it reports no sessions

The client looks up sessions by the current folder. Make sure you're running from the repo root where the user actually worked with Claude Code / Codex. The error output lists the session stores it searched.
