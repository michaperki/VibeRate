# viberate

VibeRate is a **mobile, agent-first IDE** for terminal-agent development. You
**Drive** coding agents (Claude Code today) from your phone or browser — steering
them through the project's **brain** (its `.md` docs, plans, and memory) and your
prompts, managing their context, and watching the work land — without opening the
code. The agent runs on the host; the dashboard is your control surface.

VibeRate started as an *observation* tool ("GitHub for agent conversations" — a
viewer + feedback layer that published prompts, diffs, screenshots, and brain docs
for review). Drive flipped it: the read-only watcher is now the *read* mode of a
thing whose center is **driving** agents, not just reviewing them. Sharing and
feedback are now a later social/learning layer, not the core. Full framing in
`PRODUCT_STRATEGY.md`.

The loop is **capture → understand → drive**:

- **Drive** — a chat box in the dashboard that spawns and steers a real `claude`
  binary on a bound checkout. The composer is an RCE control plane, so it's
  loopback-gated locally and admin-gated when hosted (`PLAN_AGENT_RUNTIME.md`,
  `ONBOARDING.md`).
- **Understand** — the AI-architecture **brain** (the `.md` network), the live
  transcript + context meter, the prompt-unit reader, and outcome/evidence chips.
- **Capture** — the `vbrt` CLI watches/parses your existing Claude & Codex sessions
  and pushes a shareable bundle. This is the original local mode; the CLI reference
  below still applies, but the hosted dashboard + Drive is where the product lives.

Product strategy and priorities: `PRODUCT_STRATEGY.md`. Onboarding & credentials:
`ONBOARDING.md`. Mobile port: `PLAN_MOBILE.md`. Detailed viewer planning:
`PROJECT_VIEW_PLAN.md`. Shipped / next work: `ROADMAP.md`.

## CLI / local capture mode

The `vbrt` CLI is the local capture-and-push half of the loop (the original
product). It's still how you ingest existing sessions and publish a bundle.

## Install

```bash
npm install
npm link        # makes the `vbrt` command available everywhere (optional)
```

If you skip `npm link`, run it as `node /path/to/viberate/bin/vbrt.js <cmd>`.

## Use locally

From inside any project folder where you've used codex or claude:

```bash
vbrt            # or: vbrt add
```

This scans for that folder's sessions:

- **Claude Code** — `~/.claude/projects/<encoded-cwd>/*.jsonl`
- **Codex** — `~/.codex/sessions/**/*.jsonl` (matched by the `cwd` recorded in each session)

…and shows an interactive picker (space to toggle, `a` for all, enter to
confirm). Selected sessions are parsed into a normalized shape and stored as
flat JSON under `~/.viberate/projects/<slug>/`.

Then browse them:

```bash
vbrt serve              # http://localhost:4317
vbrt serve --port=5000  # custom port
```

The viewer shows projects → sessions → the full conversation, with collapsible
thinking blocks and tool calls.

## Publish / watch

The hosted workflow is the product path:

```bash
vbrt push --all     # upload a shareable project dashboard
vbrt publish --public # make the last pushed link public without re-uploading
vbrt status         # local truth: watch, URL, visibility, evidence, outbox
vbrt watch          # keep the hosted dashboard live while you work
vbrt shot <url|img> # attach before/after UI evidence to the active prompt
```

Uploads are redacted for obvious secrets before leaving the machine, but hosted
projects are private by default. Use `vbrt publish --public` when the existing
link should be shareable, or `vbrt publish --private` to make it owner-only again.

## Agent skill

The `vbrt` CLI is also packaged as an **agent skill** (Claude Code / Codex) so an agent
can capture and publish its own session. Build/install it from the repo:

```bash
node scripts/build-skill.mjs                            # → ~/.claude/skills/viberate
node scripts/build-skill.mjs ~/.codex/skills/viberate   # → ~/.codex/skills/viberate
```

> ⚠️ **Pitfall — the skill is a COPY, not a live link.** Editing `skill/SKILL.md` (or
> `src/*`) in the repo has **no effect on installed agents** until you rebuild, and the
> skill installs **per agent** — you must rebuild into **both** the Claude and Codex
> dirs above. The `vbrt` CLI on your `PATH` is often `npm link`-ed to the repo and stays
> current on its own, which makes it easy to *assume* the skill updated too — it didn't.
> A stale skill silently invalidated a whole experiment run (the agent never saw the
> clip / `vbrt doctor` guidance and we drew false conclusions from it). **After any
> `SKILL.md` or capture-code change, re-run both build commands** before trusting a run.

## Layout

```
bin/vbrt.js        CLI (add / serve / push / watch / shot)
src/parsers.js    Claude + Codex jsonl → normalized messages
src/discover.js   Find a folder's sessions across both tools
src/storage.js    Read/write the flat-JSON project store
src/server.js     Express API + static viewer
public/           The web UI (vanilla HTML/CSS/JS)
```

Data lives in `~/.viberate` (override with `VBRT_DATA_DIR`).
```
~/.viberate/projects/<slug>/project.json     # manifest
~/.viberate/projects/<slug>/sessions/*.json  # one file per session
```
