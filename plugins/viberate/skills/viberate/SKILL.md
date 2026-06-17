---
name: viberate
description: Capture this repository's Claude Code / Codex sessions and publish them to VibeRate — an interactive, link-shareable dashboard of the user's prompts, file changes, git timeline, and agent docs (a "GitHub for agent conversations"). Use this whenever the user wants to share, review, visualize, publish, or get feedback on their agent session(s) or coding history, asks to "push to viberate" or "vbrt", or wants a shareable link to what they just built — even if they don't say "viberate" explicitly.
allowed-tools: Bash(node *)
---

# VibeRate

Publish this repository's agent sessions to the hosted VibeRate viewer and hand the user a shareable link. The skill is a thin push client — it never runs a local server.

## When to use

Trigger when the user wants to share / review / visualize / publish their agent work, get feedback on a session, or get a link to what they just built. Phrases: "share this session", "push to viberate", "vbrt", "show me a dashboard of my work", "make a link of this".

## How to run

Run from the **repository root** (the folder whose sessions should be published — the place the user ran Claude Code or Codex):

```bash
VBRT_API_URL="${VBRT_API_URL:-https://vbrt.fly.dev}" node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all
```

- `push --all` selects every session discovered for this folder, non-interactively (no prompts).
- On success the command prints `✓ Pushed project ... view & share at:` followed by a URL like `https://vbrt.fly.dev/p/<id>`. **Give that full URL to the user** — that's their shareable dashboard.
- Conversations are scrubbed for obvious secrets (API keys, tokens, private keys) before upload. The link is unlisted but anyone who has it can view it — remind the user of that.

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
- Already have an image? Register it instead of a URL: `shot ./screenshot.png --label after`.
- Stored locally, uploaded on the next `push` (or live under `vbrt watch`). UI/visual work only — backend changes don't need it.

## Local / self-hosted testing

Point the client at a running host by setting the endpoint, e.g.:

```bash
VBRT_API_URL="http://localhost:4317" node "${CLAUDE_SKILL_DIR}/client/bin/vbrt.js" push --all
```

## If it reports no sessions

The client looks up sessions by the current folder. Make sure you're running from the repo root where the user actually worked with Claude Code / Codex. The error output lists the session stores it searched.
