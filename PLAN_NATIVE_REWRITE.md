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
- ◻ **You (one-time): add `paths-ignore: ['app-ios/**']` to `fly-deploy.yml`** so Swift-only
      pushes stop redeploying/restarting the server. The Drive token is `repo, read:user` only
      (no `workflow` scope), so it can't push `.github/workflows/` — apply it from GitHub's web
      editor or a `workflow`-scoped checkout. Exact diff is in the chat / `app-ios/README.md`.
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
- ◻ Rich transcript rendering — `thinking` and `tool_result` are currently skipped on the
      phone (only `tool_use` shows as `→ name`); fold them in next.
- ◻ Optimistic-send polish: a "Working…" spinner row while the agent runs between events.
- ◻ Cockpit **"Latest" + "Next"** zones (commit bursts / brain-doc changes / convos, and
      plans-closest-to-done) — the read-only follow-ups to the Now roster, over the same
      `git`/`dochistory`/`activity` + per-plan completion the web cockpit uses.
- ◻ Brain view (`/api/projects/:slug/docs`) — note Ch. 12 demoted the brain; the cockpit
      owns legibility now, so this is low priority on the phone.
- ◻ APNs push end to end ("agent needs you / finished") — now has a destination (the
      cockpit row / Drive); also the App Store 4.2 anchor.
