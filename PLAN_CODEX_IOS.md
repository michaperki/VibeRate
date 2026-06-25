# PLAN_CODEX_IOS — additive Codex Drive path for the native app

Status: backend shim added, iOS call-site wired for live Codex Drive.

## What landed

- `src/codexAgent.js` is a parallel Drive runtime for Codex. It spawns:
  - first turn: `codex exec --json ... -`
  - follow-up: `codex exec resume --json <codexSessionId> -`
- The runtime normalizes Codex JSONL into the same SSE event kinds `DriveSessionView`
  already renders: `user_prompt`, `assistant_text`, `thinking`, `tool_use`,
  `tool_result`, `usage`, `result`, `status`, `turn_end`, and `error`.
- Existing roster surfaces now include Codex sessions:
  - `GET /api/agent/sessions`
  - `GET /api/agent/roster/stream?project=<slug>`
- Codex-specific control endpoints are additive:
  - `POST /api/agent/codex/sessions`
  - `GET /api/agent/codex/sessions/:id`
  - `POST /api/agent/codex/sessions/:id/message`
  - `POST /api/agent/codex/sessions/:id/stop`
  - `POST /api/agent/codex/sessions/:id/end`
  - `GET /api/agent/codex/sessions/:id/stream?after=<seq>`

## iOS path

- `AgentSession` now decodes `type` and `codexSessionId`.
- Fresh Drive starts default to Codex, with a segmented Codex/Claude picker shown before
  the first message.
- Live roster row taps pass `RosterAgent.type` through `DriveRoute` so a Codex row opens
  `/api/agent/codex/sessions/:id/stream` and its follow-up/stop/end actions stay on the
  Codex route family.
- Nil runtime type on push deep-links still defaults to Claude because only Claude pushes
  are currently wired.

## Known limits

- Codex APNs pushes and MCP `ask` are not wired yet. The live iOS Drive view works,
  but Codex cannot currently ask an inline picker question through VibeRate.
- Cross-redeploy resume for Codex needs a native model change because
  `WorkspaceSession` is still hard-coded around `claudeSessionId`.
- Project rail ingest for Codex Drive turns is not connected yet. Live roster and live
  transcript work; durable project history still needs a Codex equivalent of
  `driveIngest.ingestDriveTurn`.
