# viberate

A tiny tool to browse your old **Codex** and **Claude Code** coding sessions as
"projects". Run a command in any folder to pick that folder's sessions, then
read them in a local web viewer.

## Install

```bash
npm install
npm link        # makes the `vbrt` command available everywhere (optional)
```

If you skip `npm link`, run it as `node /path/to/viberate/bin/vbrt.js <cmd>`.

## Use

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

## Layout

```
bin/vbrt.js        CLI (add / serve)
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
