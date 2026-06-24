# PLAN — Drive runtime guidance reaches *every* cloned repo

**Status:** proposed (2026-06-24). Surfaced by the first real "clone someone else's
repo and Drive it" dogfood: the **daber** project (`github.com/michaperki/daber`,
a Hebrew-learning Preact+Fastify monorepo).

## The dogfood that exposed it

Mike used the new clone feature to make a VibeRate project from an old repo and asked
the agent to "start the app and take a screenshot." Transcript:
`/data/claude/projects/-data-workspaces-daber/ac858936-7330-4526-8770-7e6e25f85b1c.jsonl`
(105 events, 2026-06-24 05:23→05:30 UTC).

The agent **succeeded** — it rendered the app and read the PNG — but did it the slow,
from-scratch way, and the box nearly fell over doing it:

- Hunted the filesystem for a browser (`chromium-cli` not on PATH) before finding the
  baked-in Playwright Chromium at `/ms-playwright/chromium-1228/...` by hand.
- Hit `NODE_ENV=production` + npm `omit=dev`, so `vite`/`ts-node` were missing; had to
  reinstall with `--include=dev`, then build the content package.
- Stood up its **own** Vite server on `:5173` and shot it with raw headless Chrome.
- **Never referenced `$VBRT_PREVIEW_BASE` or `vbrt shot`** — 0 mentions in the transcript.

Side effect: a full monorepo dev-dep install + Vite + headless Chromium on a ~1 GB box
spiked memory (MemFree had dropped to ~72 MB) and disk (daber `node_modules` = 260 MB on
a volume with ~231 MB free). Consistent with an OOM kill + Fly auto-restart — the
"VibeRate crashed" Mike saw, which then self-healed. (Cleaned up 2026-06-24: stray Vite
killed, `node_modules` removed, disk 75%→48%.)

## Root cause: env is injected, *guidance* is not

The Drive runtime already hands a driven agent everything it needs as **environment**:

- `VBRT_PREVIEW_BASE` / `VBRT_PREVIEW_LOOPBACK` / `VBRT_PROJECT_SLUG` —
  `src/agent.js:274-283`. daber's session had these.
- An `--append-system-prompt` is **already** spawned — `src/agent.js:646-655` — but it
  injects **only** the MCP `ask`/`report` tool guidance. Nothing about previews,
  screenshots, the baked-in browser, or the `NODE_ENV` trap.

All the *operational* guidance — `$VBRT_PREVIEW_BASE`, capture-and-`Read`, the Playwright
Chromium, `vbrt shot`, "deps auto-install / `python` is absent / port 8080 is taken" — is
**documentation-only, in VibeRate's own `CLAUDE.md`** ("Drive runtime env" section). A
cloned third-party repo has its own (minimal) docs, so the agent inherits the *tools* but
never the *instructions*. It rediscovers the recipe every time, or misses it entirely.

This is the concrete, repo-agnostic form of the upstream-drift / portability risk: VibeRate
is only as good on *other people's* repos as the guidance it injects itself.

## Fix direction

Make the runtime guidance travel with the runtime, not the repo.

1. **Extend the existing `--append-system-prompt`** (`src/agent.js:646-655`) with a small,
   repo-agnostic "Drive runtime" preamble. Highest-value lines, condensed from
   `CLAUDE.md`:
   - **Showing/seeing UI:** a file you write is served live at `$VBRT_PREVIEW_BASE/<path>`
     (no commit/push). To verify your own UI headless: preview it, capture with the
     baked-in Playwright Chromium, and `Read` the PNG. `vbrt shot` is on-request only and
     returns no pixels.
   - **Container facts:** `node:20-slim`; `python` absent (use `node`); port 8080 taken;
     `curl`/`jq`/`gh`/`ffmpeg` present.
   - **The `NODE_ENV=production` + npm `omit=dev` trap** — dev deps (vite/ts-node/etc.)
     won't install without `--include=dev`; this bit daber directly.
   Keep it short — it's appended to *every* turn's system prompt; link out rather than
   inline the long version.
2. **Guard the box from the install/run spike.** ~1 GB RAM + ~1 GB disk can't absorb a
   full monorepo dev install + dev server + headless browser. Options: bump the Fly
   machine for Drive runs, cap/secure against runaway `node_modules`, or detect low
   disk/mem and warn the agent. At minimum the guidance should steer toward
   `$VBRT_PREVIEW_BASE` (no second server) over spinning a fresh dev server.
3. **Optional — per-project run-skill.** The daber agent offered to generate a project
   run-skill via `/run-skill-generator`. If Drive captured that on first run, subsequent
   runs of the same repo would "just work." Complements (1); doesn't replace it, since the
   first run still needs the injected guidance.

## Open questions

- How much guidance is too much to append every turn? (token cost vs. self-rediscovery
  cost — daber burned ~real minutes rediscovering it.)
- Should the preamble be static, or partly derived from the detected stack (e.g. only
  surface the `NODE_ENV`/dev-dep note for npm projects)?
- Is the right durable home a generated per-project `CLAUDE.md`/run-skill the agent writes
  on first clone, the injected system prompt, or both?

## Pointers

- `src/agent.js:262-293` — `childEnv`: where preview/loopback/slug env is injected.
- `src/agent.js:626-660` — the existing `--append-system-prompt` (MCP-tools-only today);
  the place to extend.
- `src/agentRoutes.js:95`, `src/evidence.js:259-266` — preview/loopback + `vbrt shot`
  rewrite plumbing this guidance would point agents at.
- `CLAUDE.md` "Drive runtime env" — the source-of-truth prose to condense from.
