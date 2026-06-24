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

### First milestone (shipped as the template)

The thinnest end-to-end proof of the whole pipe: **OAuth sign-in → projects list
(`/api/projects`) → live read-only Drive transcript (authenticated SSE)** → TestFlight.
That validates auth + JSON + SSE + signing + publish in one loop.

## The dogfooding-loop tradeoff (accepted going in)

Native **flips the loop slower**. Capacitor's webview pulled the live URL, so feature work
needed no rebuild. Native needs a **~10–15 min Codemagic build per UI change** to reach the
phone, and the **Linux Drive box can't compile Swift** — Codemagic is the compiler, the
device is the verifier. New loop: Drive writes Swift → push `app-ios/**` → Codemagic builds
→ TestFlight → install. (`fly-deploy.yml` ignores `app-ios/**` so a Swift-only push doesn't
also redeploy/restart the server.)

## Status / next

Scaffolded 2026-06-24. The starting template builds the first milestone; everything below
is incremental.

- [x] `app-ios/` SwiftUI skeleton: token-in-Keychain, APIClient, SSEClient, sign-in →
      projects → live transcript.
- [x] Server: native deep-link OAuth (`/auth/native/:provider/start`, callback `native`
      branch, `/api/auth/native/exchange`) — additive, web flow untouched.
- [x] `ios-native` Codemagic workflow (XcodeGen → sign → bump → IPA → Internal Testers),
      gated to `app-ios/` changes; `fly-deploy.yml` path-filtered off `app-ios/**`.
- [x] `PLAN_NATIVE_REWRITE.md` + `CLAUDE.md` index link.
- ◻ You (one-time): confirm the `Internal Testers` group exists (Manual distribution), then
      trigger the `ios-native` workflow in Codemagic for the first build.
- ◻ Add a real app icon (`Assets.xcassets/AppIcon.appiconset` or `assets/icon.png`).
- ◻ Send a Drive prompt from the app (`POST /api/agent/sessions/:id/message`) + optimistic bubble.
- ◻ Rich transcript rendering (thinking / tool I/O / diffs) instead of one line per event.
- ◻ Cockpit roster (`/api/agent/roster/stream`) + brain view (`/api/projects/:slug/docs`).
- ◻ APNs push end to end ("agent needs you / finished") — also the App Store 4.2 anchor.
