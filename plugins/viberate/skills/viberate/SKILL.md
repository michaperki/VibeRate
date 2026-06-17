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
- Conversations are scrubbed for obvious secrets (API keys, tokens, private keys) before upload. The link is unlisted but anyone who has it can view it — remind the user of that.

## Before you build (preflight + project size)

Run **`vbrt doctor`** once at the start. It reports — in a few seconds — whether this
is a git repo, whether `vbrt watch` is already live, whether headless capture works
(Playwright + browser), and prints the exact `shot` command to use. Trust its output
instead of discovering capabilities by trial and error.

- **If `vbrt watch` is live** (doctor says so): it streams changes automatically.
  **Do not run `vbrt push --all`** at the end — only push manually if watch errors or
  the user asks. Capture artifacts normally; they ride the stream.
- **Scale the process to the work.** For small experiments (under ~1 hour): keep just
  `ROADMAP.md` + `DEVLOG.md`, skip per-phase `PLAN_*.md` files unless the user asks,
  commit at meaningful milestones (not every micro-phase), and capture **≤3 artifacts**
  (typically one before, one final clip, maybe one final shot). The brain conventions
  below are how to make work legible *when there's enough of it* — not homework for a
  toy app. More ceremony than product is a failure mode, not discipline.

## Capturing evidence (screenshots) for a prompt

When you make a **visible UI change**, capture a before/after screenshot so it shows on the prompt that produced it. One line; it binds itself to the current conversation — no session/turn id needed.

Point it at **the app's URL** — normally its **deployed site** (reachable from anywhere for headless capture, and it reflects the real shipped state). Use a `localhost` dev URL only if that's literally where the app is running.

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
node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" shot http://localhost:5173 --clip 4 --label after --note "merge animation"
```

- `--clip [seconds]` (default 4, max 15). Produces an animated **gif** if `ffmpeg` is installed, otherwise a **webm** — both render and loop in the reader, no difference to you.
- Keep clips short and the `--viewport` modest (e.g. `960x600`); they inline into the bundle, so smaller is better. Prefer a clip only when a still wouldn't show the point.

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

VibeRate renders this repo's **brain** — the agent/architecture docs — as a live graph, and its `.md` plan docs as completion rings on a timeline. A few zero-cost conventions make your work show up well, in any project:

- **The graph is built by reachability.** A markdown doc becomes a brain node only if it has a known name (`SOUL`/`AGENTS`/`CLAUDE`/`SEED`/`CONTEXT`/`MEMORY`/`ROADMAP`/`DECISIONS`/`README`/…) **or** is **linked by name** from a doc already in the brain. So when you create a new brain doc, **reference it by its filename** from a seed (e.g. add `PLAN_x.md` to `ROADMAP.md`). An unlinked "orphan" doc won't appear in the live graph — it only surfaces once committed, via git history.
- **Plan docs get a completion ring.** Name them `PLAN_<name>.md`, give them a `- [ ]` checklist, and **link them from `ROADMAP.md` at creation**. VibeRate draws a ring from the checked ratio. **Check the boxes as you go** and the ring fills live; write-then-complete-then-commit and it just snaps to done at the commit.
- **Commits are the brain's checkpoints.** The live graph updates on save for reachable docs and on commit for git-derived history — so commit at meaningful boundaries (per plan / per phase). That's the timeline the viewer shows.
- **Keep a dev journal.** A dated `DEVLOG.md` plus a `DECISIONS.md` (one line + the *why* per decision) give the brain a narrative spine and make choices traceable — the heart of "a living history of how you and your agents changed this project."

## Local / self-hosted testing

Point the client at a running host by setting the endpoint, e.g.:

```bash
VBRT_API_URL="http://localhost:4317" node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all
```

## If it reports no sessions

The client looks up sessions by the current folder. Make sure you're running from the repo root where the user actually worked with Claude Code / Codex. The error output lists the session stores it searched.
