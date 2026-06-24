# PLAN_NATIVE_REWRITE — VibeRate as a native SwiftUI app

The App-Store push, revived (2026-06-24) as a **clean native rewrite** rather than the
Capacitor wrapper. Mike called for it directly: rebuild the control surface in SwiftUI,
ship to TestFlight via Codemagic, grow it slice by slice as the dogfooding cycle
establishes. This plan is the starting template + the decisions behind it. Supersedes
`PLAN_CAPACITOR.md` as the live iOS path (the Capacitor scaffold stays dormant, not deleted).

## Why native now (and why not the wrapper)

`STORY.md` Ch. 11 named the lesson: **every hard bug in the Capacitor build lived at the
WKWebView seam** — the tall header (safe-area double-count), the OAuth cookie-jar split,
the blank Drive SSE stream — and each fix piled on security debt (RCE-capable token,
token-in-URL). A native client deletes the seam outright:

- **OAuth** runs in `ASWebAuthenticationSession` (a real system browser — Google doesn't
  block it the way it blocks embedded webviews) and returns via a `viberate://` deep link.
- **SSE** uses `URLSession.bytes`, which **can set an `Authorization` header** (browser
  `EventSource` can't) — so the admin-guarded `/stream` route is hit directly, and the
  `?access_token=`-in-URL hack from `PLAN_NATIVE_AUTH.md` is gone.
- **Safe area** is the OS's own, no double-count, no measurement loop.

## What transfers from the Capacitor work (don't rebuild it)

The build/ship half of `PLAN_CAPACITOR.md` is fully reused — only the throwaway webview
shell is replaced:

- App Store Connect record **VibeRate IDE**, bundle `com.viberate.app`, Apple ID
  `6782960153` — kept verbatim.
- Codemagic connected to this repo, `VibeRateASC` API key, `ios_signing` group, signing
  cert/profile auto-creation, export-compliance, **build-number auto-bump**, direct
  **`Internal Testers`** internal-group publish (no beta review).

## The architecture (the starting template — `app-ios/`)

A native *client* to the same Fly backend; no new server except the auth front door.
iOS 17+, SwiftUI, `@Observable`, `NavigationStack`, `URLSession` async/await, **zero
third-party deps**. The Xcode project is **generated** from `app-ios/project.yml` by
XcodeGen on the Codemagic Mac (the Linux Drive box has no Xcode) — exactly how the old
workflow ran `cap add ios`; `VibeRate.xcodeproj` is a build artifact, not committed.

```
app-ios/
  project.yml            XcodeGen spec (bundle id, iOS 17, viberate:// URL scheme, plist)
  Sources/Core/          APIConfig, TokenStore (Keychain), APIClient, SSEClient
  Sources/Auth/          AuthModel (ASWebAuthenticationSession → deep-link → exchange)
  Sources/Views/         RootView, SignInView, ProjectsView, DriveSessionView
  Sources/Models.swift   Me, Project, AgentSession
  Assets.xcassets/       placeholder AppIcon + AccentColor
```

### Auth: RFC 8252 deep-link OAuth (server-side, additive)

OAuth-first by Mike's choice. The native flow is **cookie-free** so it can't hit the
cookie-jar split. It reuses the SAME provider redirect URI as the web flow (no new
callback to register with GitHub/Google) by branching on a signed `native` flag — all in
`src/oauth.js`:

1. App → `GET /auth/native/:provider/start?cb=viberate://auth`. The server signs `cb`
   into the OAuth `state` (HMAC, un-forgeable — that's the binding, no cookie needed).
2. Provider → existing `/auth/:provider/callback`. The `native` branch exchanges the code,
   upserts the user, mints a bearer token **linked to the account** (`linkOwner` → full
   project scope; `adminEmailFor` resolves it to the admin email, so **Drive unlocks too**),
   stashes a **one-time code**, and redirects to `viberate://auth?code=…`.
3. App catches the deep link → `POST /api/auth/native/exchange {code}` → bearer token →
   Keychain. Every call thereafter is `Authorization: Bearer`.

Web sign-in is untouched (it still requires the state cookie). Security posture is the same
single-user RCE-capable-admin-token tradeoff already accepted in `PLAN_NATIVE_AUTH.md`;
revisit at multi-user.

> **Bearer-token gotcha (fixed 2026-06-24).** The native flow ends by calling `/api/me`
> with the minted bearer token, but `/api/me` originally authenticated via `currentUser`
> — the **session cookie only**. The phone has no cookie, so OAuth would complete, save its
> token, then `me()` 401'd and the app fell back to the sign-in screen — indistinguishable
> from "the login button doesn't work." Fix: `currentAccount(req)` in `src/oauth.js`
> resolves the account from the cookie **or** an account-linked bearer token
> (`findUserByOwnerHash`), and `/api/me` uses it. This is a *server* fix, so it unblocks the
> OAuth buttons in the build **already on the phone** — no new TestFlight build needed for
> that part. A pasted-token fallback ("Use an access token instead", mirroring the PWA) was
> also added to `SignInView` and rides the same fixed path.

### First milestone (shipped as the template)

The thinnest end-to-end proof of the whole pipe: **OAuth sign-in → projects list
(`/api/projects`) → live read-only Drive transcript (authenticated SSE)** → TestFlight.
That validates auth + JSON + SSE + signing + publish in one loop.

## The dogfooding-loop tradeoff (accepted going in)

Native **flips the loop slower**. Capacitor's webview pulled the live URL, so feature work
needed no rebuild. Native needs a **~10–15 min Codemagic build per UI change** to reach the
phone, and the **Linux Drive box can't compile Swift** — Codemagic is the compiler, the
device is the verifier. New loop: Drive writes Swift → push `app-ios/**` → Codemagic builds
→ TestFlight → install.

> **Heads-up:** `fly-deploy.yml` does **not** path-filter `app-ios/**` (the filter was
> dropped — the Drive box's GitHub token lacks `workflow` scope, so it can't push
> `.github/workflows/`). So a Swift-only push **also redeploys/restarts the server**.
> Harmless (the server rebuilds from the same tree), just an extra ~couple-minute deploy.
> Apply the `paths-ignore: ['app-ios/**']` filter from a checkout whose token has
> `workflow` scope when convenient.

## First-deploy log — what broke getting to TestFlight (2026-06-24)

The scaffold built locally-clean but the first real `ios-native` runs surfaced three
bugs, each a *green build that shipped nothing* or *a build Apple rejected*. Order found:

1. **IPA never uploaded (silent).** `ios-native` had `working_directory: app-ios`, but
   `xcode-project build-ipa` always exports the IPA to the **clone-root** `build/ios/ipa/`
   (relative to `$CM_BUILD_DIR`, ignoring `working_directory`), while the artifact/publish
   glob resolved under `app-ios/build/ios/ipa/`. Publishing found no IPA → uploaded nothing
   → **still reported success.** Symptom: nothing new in App Store Connect; phone stuck on
   the old Capacitor build. **Fix (`48cd5f0`):** run from the clone root like the proven
   `ios-release`; only `cd app-ios` for the XcodeGen step; clone-root artifact path. *Lesson:
   the artifact glob must match where `build-ipa` actually exports — never relocate it with
   `working_directory`.*
2. **Apple rejected the bundle (90023 + 90474).** Missing app icon (the `AppIcon.appiconset`
   had a 1024 slot but no PNG), and Portrait-only orientation isn't allowed when targeting
   iPad. **Fix (`4c10aed`):** generated a real 1024×1024 marketing icon on the Linux box with
   **ffmpeg** (gradient + bold "V", `-pix_fmt rgb24` to strip alpha — Apple rejects alpha on
   the marketing icon) and wired its `filename` into `Contents.json`; switched to
   **iPhone-only** (`TARGETED_DEVICE_FAMILY: "1"`), which clears both the iPad-icon and
   iPad-orientation gates at once. *Lesson: icon generation needs no Mac; for a phone-first
   app, iPhone-only dodges iPad App Store gates.*
3. **OAuth "didn't work" after a clean build.** See the bearer-token gotcha in the Auth
   section above — `/api/me` was cookie-only, so native OAuth completed then 401'd. Fixed
   server-side (`currentAccount`), unblocking the already-installed build.
4. **Projects list failed to decode.** The `Project` Swift model typed `sessions` as `Int`
   (assumed a count), but `/api/projects` returns the raw manifest where `sessions` is an
   **array** of capture objects → `DecodingError.typeMismatch … [0].sessions expected Int,
   found array`. Fix: decode `sessions: [ProjectSession]?` and expose `sessionCount`. *Lesson:
   match Swift `Codable` types to the server's actual JSON, not the field name's implied
   meaning — the API sends manifests, not view-models.*

(Also noted along the way: the prior Drive session diagnosed #1 correctly but its edit tools
were blocked by permission prompts that never surfaced to the human — resolved by re-doing
the edits under bypass permissions.)

## The silent SSE hang — empty Drive transcript (2026-06-24)

First real on-device drive after the cockpit shipped surfaced the headline bug: opening a
conversation showed an **empty transcript**, sending a message showed the optimistic bubble
and a "working" status but **nothing streamed before or after it**, and navigating away and
back lost even the local bubble. Confirmed-by-contrast: the *same* convo was fully visible in
mobile Safari. Diagnosis took one instrumented build (don't re-learn this):

1. **The tell was a diagnostic indicator.** Blind (no Swift compile on the Linux box, ~15 min
   per Codemagic build), guessing is expensive — so the fix-build added a status-bar
   indicator that distinguishes *never connected* (`·`) from *open-but-zero-events* (`↯200`)
   from *rejected* (`⚠<code>`) from *flowing* (`⚡N`). It read **`·`**: the stream connected
   without error yet delivered zero events. That one character ruled out auth/routing and
   pointed straight at the reader.
2. **Root cause — `URLSession.bytes(...).lines` buffers SSE.** `SSEClient` consumed the stream
   with `for try await line in bytes.lines`, which doesn't yield a line until the response
   body *completes* — but an SSE stream never completes, so the loop hung forever, zero events,
   socket open. The `POST .../message` path worked (ordinary request), which is why prompts
   reached the agent while the transcript stayed blank; the web `EventSource` never hits this.
3. **Fix (`a97756e`): read the stream via a `URLSessionDataDelegate`** — parse SSE frames out
   of each `didReceive(data:)` chunk as it arrives (the standard robust SSE-on-URLSession
   pattern). History backfilled and live responses streamed immediately. *Lesson: never use
   `URLSession.bytes`/`.lines` for an endless stream; it's for finite downloads.*

Shipped in the same fix-cluster (`7e2bcdc`+`a97756e`): explicit `?after=0` backfill so a convo
re-paints its history on open; **render `tool_use` targets + `tool_result` output** so a
tool-heavy turn visibly moves instead of looking frozen; **smarter session targeting**
(prefer a live working/waiting session over a stale idle one); and **durable reconnect** —
persist `claudeSessionId` per project and `POST /sessions/adopt` it when no live session is
found, so a convo survives an app relaunch *and* the redeploy that push-to-main triggers.

## Status / next

Scaffolded 2026-06-24; first TestFlight build landed the same day after the fixes above.

- [x] `app-ios/` SwiftUI skeleton: token-in-Keychain, APIClient, SSEClient, sign-in →
      projects → live transcript.
- [x] Server: native deep-link OAuth (`/auth/native/:provider/start`, callback `native`
      branch, `/api/auth/native/exchange`) — additive, web flow untouched.
- [x] `ios-native` Codemagic workflow (XcodeGen → sign → bump → IPA → Internal Testers),
      gated to `app-ios/` changes. **Builds + uploads green as of `4c10aed`.**
- [x] Real app icon (branded "V"); iPhone-only to pass App Store validation.
- [x] `/api/me` accepts an account-linked bearer token (`currentAccount`) so native OAuth
      actually signs in; pasted-token fallback added to `SignInView`.
- [x] `PLAN_NATIVE_REWRITE.md` + `CLAUDE.md` index link.
- [x] **Steer from the app** — `DriveSessionView` is interactive: a composer sends a
      prompt to the running session (`POST /api/agent/sessions/:id/message`), or **starts**
      one in the project workspace if none is running (`POST /api/agent/sessions`).
      Optimistic prompt bubble, deduped against the stream's `user_prompt` echo; streamed
      `assistant_text_delta`s are coalesced into one growing bubble (not a line per token).
- [x] **Killed the "streaming · idle" jargon** — the status bar now reads plain language
      ("Working…", "Idle", "Waiting for you", "No agent running yet…") via `humanStatus`.
- ◻ You (one-time): confirm the `Internal Testers` group exists (Manual distribution).
- ◻ Confirm a provider redirect URI `https://vbrt.fly.dev/auth/{github,google}/callback`
      is registered in the GitHub/Google OAuth apps — the only remaining server-side OAuth
      variable the Drive box can't inspect (the token fallback works regardless).
- [x] **`paths-ignore: ['app-ios/**']` on `fly-deploy.yml`** (`a86e28c`) — Swift-only
      pushes no longer redeploy/restart the server. (Applied from a `workflow`-scoped
      checkout, since the Drive token is `repo, read:user` only. A cosmetic `# add these two
      lines` comment is still in the file; harmless.)
- [x] **Cockpit "Now" roster** (`CockpitView` + `RosterStore`, 2026-06-24) — the
      drive+cockpit milestone on the phone. A new screen sits **between** the projects list
      and Drive: `Projects → Cockpit → Drive`. It subscribes to the aggregate roster SSE
      (`/api/agent/roster/stream?project=…`, PLAN_COCKPIT.md §3.1c) via the bearer-header
      `SSEClient`, paints a `snapshot` then merges `agent`/`removed` frames, and shows one
      live row per agent: status dot, current action (`lastAction` verb+file), `◆ plan` chip
      (declared-over-inferred), a **locally-ticking elapsed timer** (`promptStartedAt`, a 1 s
      `Timer`), and a context-fill meter (`ctxPct`). Header summarizes "N working · M
      waiting · K idle"; rows sort needs-you-first (waiting → working → error → idle).
      **Tapping a row drives that specific agent** (`DriveSessionView(attachTo:)`); **✦ New
      agent** starts a fresh one — matching the web cockpit's settled model (PLAN_COCKPIT
      §X.2: roster rows are the reconnect targets, no global "Return to Drive"). One-shot
      `/api/agent/sessions` decode is the instant-paint + pull-to-refresh fallback when the
      stream can't connect. `DriveSessionView` no longer auto-attaches to "the first session
      in the project" — the cockpit owns selection now (new `attachTo`/`initialStatus`
      params; `nil` attach = fresh agent). *No server change — the enriched `publicView` +
      roster stream already shipped for the web cockpit.* **Pending Codemagic build +
      on-device verify** (the Linux box can't compile Swift).
- [x] **Durable Drive transcript** (2026-06-24) — SSE reader rewritten to a
      `URLSessionDataDelegate` (the silent-hang fix above), `?after=0` backfill on open,
      `tool_use` targets + `tool_result` output rendered, live-session-preferred targeting,
      and `claudeSessionId`-persist → `adopt` reconnect so a convo survives relaunch/redeploy.
- [x] **Markdown in assistant messages** (2026-06-24) — assistant bubbles used
      `Text(b.text)`, but SwiftUI only parses Markdown from string *literals*
      (`LocalizedStringKey`); a runtime `String` renders verbatim, so `**bold**`,
      backticked `` `code` ``, fences, and pipe-tables showed raw. New `MarkdownView`
      (`app-ios/Sources/Views/MarkdownView.swift`) ports the web `renderMarkdown`
      (`public/app.js`): block-level parse (code fences, headings, lists, blockquotes,
      hr, tables) + `AttributedString` inline spans (bold/italic/code/links). Tables
      stack into labelled key/value cards on the phone, mirroring the web's `data-label`
      CSS. Streamed and backfilled assistant text share the one `.assistant` path, so
      they render identically.
- [x] **Live thinking + stream auto-reconnect** (2026-06-24) — two coupled fixes.
      (a) *Live thinking*: Claude's extended thinking already streamed to the phone
      (`thinking_start`/`thinking_delta`/`thinking`, `src/agent.js:563`) but `ingest()`
      dropped it. It now renders as an ephemeral dimmed `✦` trace — the same line-by-line
      reasoning the terminal shows, streamed live and cleared at the turn boundary so the
      transcript stays clean (mirrors the web Drive view, `public/app.js:5300`). Free
      insight: thinking is a byproduct of the model reasoning, not something the agent
      spends tokens reporting (that's what `mcp__viberate__report` is for — coarse
      plan/roster status, deliberately separate). (b) *Auto-reconnect*: the native
      `SSEClient` had none, so once the server closed an idle/deployed connection, live
      events stopped and only reappeared when the user re-entered the chat (a manual
      reconnect via `?after=0`) — the "messages refresh instead of stream" bug. The
      browser's `EventSource` reconnects for free; `DriveSessionView.openStream` now does
      too, resuming from `lastSeq` (`?after=<seq>` → server backfills only the gap via the
      `id:`/Last-Event-ID dedupe, `agentRoutes.js:357`), skipping a 4xx so it can't
      hot-loop. Plus `SSEClient` refuses gzip + caching so URLSession can't buffer the
      trickle. *Both text and thinking ride the same stream, so this unblocks both.*
- [x] **Optimistic-send polish — "Working…" spinner row** (2026-06-24). The gap between
      sending a prompt and the first streamed event read as dead air (the status bar might
      still say "Idle" until the server's first `status` frame). `DriveSessionView` now
      shows a `ProgressView` + "Working…"/"Thinking…" row at the foot of the transcript
      whenever the agent is busy but nothing is actively streaming into a bubble
      (`showWorkingRow` = `awaitingResponse || status busy`, hidden while assistant text or
      a thinking trace is growing — that text is its own progress signal). `awaitingResponse`
      flips on at send and off at the first real `status`/`turn_end`/`error`; a lingering
      "Working…" is cleared at `turn_end` so the spinner can't stick after the agent goes idle.
- ✅ **New agent from the phone** — the `+` opened a fresh Drive but `connect()` then
      re-attached/adopted the agent *already* running on the project, so you landed back in
      the open convo with no way to start a second one. Fixed: `DriveSessionView` takes a
      `forceNew` flag; CockpitView passes `forceNew: t.sessionId == nil` (both `+` entry
      points use a `nil` sessionId, a row-tap passes the agent id), and `connect()` short-
      circuits before the live-lookup/adopt path — the first message starts a *second*
      concurrent session. The viberate workspace is already cloned so the 409 below doesn't
      bite; it's still open for a *fresh* project.
- ✅ **Always drive in bypass permissions** — the native client sent no `permissionMode`,
      so every session ran in `default`, which silently denies edits in a headless Drive
      (no prompt can reach the phone; "go ahead" in chat doesn't grant a tool permission —
      this stranded a prior session mid-edit). `APIClient.startSession` *and* `adopt` now
      send `permissionMode: "bypassPermissions"` (server validates it + adds
      `--dangerously-skip-permissions`, `agent.js:363,685`).
- [x] **Workspace setup for a fresh project** (2026-06-24) — `POST /api/agent/sessions`
      409s if the project's checkout isn't cloned (`agentRoutes.js:182`); previously that
      stranded a fresh project on the phone with a bare error and no recovery. The server
      `POST /api/agent/workspace/:slug/setup` route already existed (clone + dep-install,
      background, status walks `cloning → ready|error`) — this adds the iOS affordance.
      `send()` now detects the 409 (`isWorkspaceNotSetup`), rolls back the optimistic
      bubble, queues the prompt, and presents `WorkspaceSetupView`: a sheet that prefills
      the project's `suggestedRepo` (from `GET /api/agent/workspace/:slug`), clones via
      `setupWorkspace`, polls the status (~3 min ceiling) until `ready`, then calls back
      to re-send the queued prompt — which now starts the project's first agent. New
      `WorkspaceInfo`/`WorkspaceState` models, `workspace`/`setupWorkspace` on `APIClient`,
      and a shared `apiMessage(_:)` error-body helper (DriveSessionView's `friendly` now
      delegates to it). *No server change — the route already shipped for the web onboarding
      flow.* **Pending Codemagic build + on-device verify** (the Linux box can't compile Swift).
- [x] **Cockpit "Conversations" — see + resume past sessions** (2026-06-24). Symptom from
      dogfooding: after a redeploy (every push to `main` restarts the box) the cockpit showed
      "No agents running" for a project with real history, because the roster only lists *live
      in-memory* sessions — the durable past conversations vanished from view, and the only way
      back was `DriveSessionView`'s silent best-effort adopt of the per-project stored cid. That
      read as "I can't start a new agent" — every entry collapsed onto the one remembered
      session. (The `+`/`forceNew` path already starts a genuinely independent agent server-side:
      `startSession` mints a fresh claude session, no `--resume`, no per-cwd reuse — verified.)
      Fix: a **Conversations** section under the Now roster lists the project's durable sessions
      (`GET /api/agent/workspace/:slug/sessions` → on-disk transcripts, survives the redeploy),
      deduped against the live roster. Tapping one **deliberately** resumes it — a still-live one
      routes to its running agent (`attachTo`), an offline one adopts its exact `claudeSessionId`
      (new `resumeCid` branch in `connect()`, distinct from the step-3 fallback). `+ New agent`
      stays separate and unmistakable. New `WorkspaceSession` model + `workspaceSessions` on
      `APIClient`. *No server change — the workspace-sessions endpoint already shipped.*
      **Pending Codemagic build + on-device verify.**
- [x] **State-machine legibility pass** (2026-06-24) — the screens around projects /
      agents / sessions / conversations blurred together; this makes "where am I" obvious
      without touching the dark/rounded/big-type visual direction or the compact inline
      header. (a) **Cockpit section labels**: the "Now" header now reads the noun ("Agents"
      / "2 agents") with the working/needs-input/idle mix demoted to the footer — replacing
      the bare, ambiguous "2 idle". (b) **Labeled meters**: `CtxMeter` is now "Context NN%"
      (a bare percentage is meaningless); every agent row carries an explicit **status pill**
      ("Working" / "Needs input" / "Error" / "Idle"), not just a colored dot. (c) **`+` =
      "New agent"** (title+icon in the toolbar, not a bare plus). (d) **Conversations rows
      restyled distinct from live agent rows** — leading history icon, status word
      ("Resumable" / "Working" / "Needs input"), message-count + last-active metadata to
      disambiguate same-prefix truncated titles, and a trailing **Resume / Open** affordance
      so resuming reads as a deliberate choice. (e) **Drive status bar** replaces the cryptic
      `⚡N`/`↯200`/`⚠403` glyphs with plain words + a dot: "Connecting…" → "Connected" →
      "Stream connected" / "History loaded" / "Disconnected"; resume paths say "Resuming
      agent…". (f) **New-agent empty state** is no longer blank: project context + four
      starter chips ("Review the repo", "Continue the last plan", "Fix an iOS bug",
      "Summarize current state") that start the agent on tap. (g) **Tool-call lines → compact
      chips** (icon + monospaced, tinted card, line-clamped) so a tool-heavy turn reads as
      quiet steps, not a wall of mono text. `CockpitView.swift` + `DriveSessionView.swift`
      (+ `ProjectsView.swift`: "N conversations", "Live agent"). *No server change.*
      **Pending Codemagic build + on-device verify** (the Linux box can't compile Swift).
- ◻ Cockpit **"Latest" + "Next"** zones (commit bursts / brain-doc changes / convos, and
      plans-closest-to-done) — the read-only follow-ups to the Now roster, over the same
      `git`/`dochistory`/`activity` + per-plan completion the web cockpit uses.
- ◻ Brain view (`/api/projects/:slug/docs`) — note Ch. 12 demoted the brain; the cockpit
      owns legibility now, so this is low priority on the phone.
- ◻ APNs push end to end ("agent needs you / finished") — now has a destination (the
      cockpit row / Drive); also the App Store 4.2 anchor.
