# VibeRate — native iOS app (SwiftUI)

The native rewrite of the VibeRate control surface. It talks to the **same Fly backend**
(`https://vbrt.fly.dev`) the web app and Drive use — this is a native *client*, not a new
server. Decision + rationale: `../PLAN_NATIVE_REWRITE.md`.

## Why native (and what it costs)

The Capacitor/WKWebView wrapper was abandoned because every hard bug lived at the webview
seam — the tall header, the OAuth cookie-jar split, the blank SSE stream (`../STORY.md`
Ch. 11). Native deletes that seam: `ASWebAuthenticationSession` does OAuth in a real system
browser, and `URLSession.bytes` streams SSE **with** an `Authorization` header (browser
`EventSource` can't), so the `?access_token=`-in-URL hack disappears.

The cost: the dogfooding loop is slower. The webview pulled the live URL, so feature work
needed no rebuild. Native needs a ~10–15 min Codemagic build per UI change to reach the
phone, and the Linux Drive box **can't compile Swift** — Codemagic is the compiler, the
device is the verifier.

## Layout

```
app-ios/
  project.yml              XcodeGen spec — the project IS generated from this
  Sources/
    VibeRateApp.swift      @main App
    Models.swift           Codable: Me, Project, AgentSession
    Core/
      APIConfig.swift      base URL + custom scheme
      TokenStore.swift     Keychain bearer-token store
      APIClient.swift      async JSON client (Bearer auth)
      SSEClient.swift      SSE over URLSession.bytes (can set Authorization)
    Auth/
      AuthModel.swift      ASWebAuthenticationSession → deep-link → token exchange
    Views/
      RootView.swift       loading / signed-out / signed-in switch
      SignInView.swift     GitHub / Google buttons
      ProjectsView.swift   GET /api/projects
      DriveSessionView.swift  live SSE transcript (read-only)
  Assets.xcassets/         AppIcon (placeholder) + AccentColor
```

`VibeRate.xcodeproj` and `Support/Info.plist` are **generated** (gitignored) — `xcodegen`
recreates them from `project.yml`, the same way the old Capacitor workflow ran `cap add ios`.

## Build it

**On Codemagic (no Mac needed)** — push to `main`; the `ios-native` workflow in
`../codemagic.yaml` runs `xcodegen generate`, signs, builds, and publishes to the
`Internal Testers` TestFlight group. (First run: trigger it manually in the Codemagic UI.)

**Locally (if you have a Mac):**
```sh
brew install xcodegen
cd app-ios
xcodegen generate
open VibeRate.xcodeproj
```

## Auth flow (RFC 8252 deep-link OAuth)

1. Tap a provider → `ASWebAuthenticationSession` opens
   `/auth/native/:provider/start?cb=viberate://auth`.
2. The server signs the callback scheme into the OAuth `state` (no cookie — that's the
   bug class we're avoiding), runs the normal provider flow, and on callback mints a
   **one-time code**, redirecting to `viberate://auth?code=…`.
3. The app catches the deep link, POSTs the code to `/api/auth/native/exchange`, and gets
   a **bearer token** linked to the account → full project scope + Drive admin. Stored in
   the Keychain; sent as `Authorization: Bearer` on every call.

Server side lives in `../src/oauth.js` (the `native` branch of the OAuth callback +
`/auth/native/:provider/start` + `/api/auth/native/exchange`).

## Next slices

- Send a Drive prompt (`POST /api/agent/sessions/:id/message`) + optimistic bubble.
- Rich transcript rendering (thinking, tool I/O, diffs) instead of one line per event.
- Cockpit roster via `/api/agent/roster/stream`.
- Brain view (`/api/projects/:slug/docs`).
- APNs push ("your agent is asking a question / finished") for the App Store 4.2 guardrail.
- Real app icon (`Assets.xcassets/AppIcon.appiconset`).
