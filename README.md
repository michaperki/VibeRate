# viberate

VibeRate is a hosted viewer and feedback layer for terminal-agent development.
It lets agents publish the work behind a repo — prompts, decisions, screenshots,
diffs, commits, and brain docs — so developers and reviewers can watch,
understand, and discuss how the project was built.

The old shorthand was "GitHub for agent conversations." The current frame is
closer to an **agent work viewer**: developers increasingly build through
terminal agents instead of a traditional IDE, and VibeRate gives that work a
readable, shareable environment.

Product strategy and current priorities live in `PRODUCT_STRATEGY.md`; detailed
viewer planning lives in `PROJECT_VIEW_PLAN.md`; shipped / next work is tracked
in `ROADMAP.md`.

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
