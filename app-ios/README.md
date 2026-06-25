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
    Cockpit/
      RosterStore.swift    live "Now" roster over /api/agent/roster/stream (snapshot+frames)
    Views/
      RootView.swift       loading / signed-out / signed-in switch
      SignInView.swift     GitHub / Google buttons + "use an access token" fallback
      ProjectsView.swift   GET /api/projects → pushes CockpitView
      CockpitView.swift    the "Now" roster: live agent rows → tap to Drive / ✦ New agent
      DriveSessionView.swift  live SSE transcript + composer (attaches to a chosen session)
  Assets.xcassets/         AppIcon (branded "V", 1024 no-alpha) + AccentColor
```

Navigation is `Projects → Cockpit → Drive`. The cockpit is the project home (the "Now"
zone of `../PLAN_COCKPIT.md` on the phone): one live row per Drive agent, fed by the
aggregate roster SSE. Tapping a row drives *that* agent; ✦ starts a fresh one. Drive no
longer guesses which session to attach to — the cockpit passes it `attachTo`.

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

### CI gotchas the first deploy hit (don't re-learn these)

- **Don't set `working_directory: app-ios` on the `ios-native` workflow.** `xcode-project
  build-ipa` exports the IPA to the **clone-root** `build/ios/ipa/` no matter what, so with
  a working directory the publish glob looked in `app-ios/build/ios/ipa/`, found nothing, and
  shipped a **green build with zero upload**. Run from the clone root; only `cd app-ios` for
  `xcodegen generate`.
- **App icon is required to pass App Store validation** (error 90023). The `AppIcon.appiconset`
  needs an actual PNG with a `filename` in `Contents.json`, and the 1024 marketing icon must
  be **flattened (no alpha)** — generate it with ffmpeg on the Drive box, no Mac needed:
  `ffmpeg -f lavfi -i "gradients=s=1024x1024:..." -frames:v 1 -vf drawtext=... -pix_fmt rgb24 AppIcon.png`.
- **iPhone-only** (`TARGETED_DEVICE_FAMILY: "1"`). Targeting iPad too (`1,2`) makes Apple demand
  a 152×152 iPad icon (90023) **and** all four interface orientations for iPad multitasking
  (90474). Phone-first app → drop iPad, both gates clear at once.
- A Swift-only push currently **also redeploys the Fly server** — `fly-deploy.yml` isn't
  path-filtered off `app-ios/**`, and the Drive box's token is `repo, read:user` only (no
  `workflow` scope), so an agent can't push `.github/workflows/`. To decouple iOS builds from
  server deploys (so an iOS build stops restarting a live Drive session), apply this from
  GitHub's web editor or a `workflow`-scoped checkout:

  ```yaml
  # .github/workflows/fly-deploy.yml
  on:
    push:
      branches: [main]
      paths-ignore:        # add these two lines
        - 'app-ios/**'
  ```

  `paths-ignore` only skips when **every** changed file matches, so a push that also touches
  server code still deploys — exactly what you want.

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

> **Note (2026-06-24):** the token from step 3 only works because `/api/me` now resolves an
> account-linked bearer token (`currentAccount`), not just the web session cookie — otherwise
> OAuth completes but `me()` 401s and the app looks "stuck" on sign-in. If the social buttons
> ever fail on a device, **"Use an access token instead"** on the sign-in screen is the
> guaranteed fallback (paste a token minted in the web app). See `../PLAN_NATIVE_AUTH.md`.

## Next slices

- ✅ Send a Drive prompt (`POST /api/agent/sessions/:id/message`) + optimistic bubble.
- ✅ Cockpit "Now" roster via `/api/agent/roster/stream` (`CockpitView` + `RosterStore`) —
  live agent rows, tap-to-drive, ✦ new agent. *Pending Codemagic build + on-device verify.*
- Cockpit "Latest" + "Next" zones (commit bursts / brain-doc changes, plans-closest-to-done).
- Rich transcript rendering (thinking, tool I/O, diffs) instead of one line per event.
- ✅ APNs push ("your agent is asking a question / finished / errored") + the native
  ask selector (`AskView`/`AskSheet`, inline in `DriveSessionView` and from a tapped
  notification). Server `src/apns.js` + `/api/agent/push/{register,unregister}`. *Pending
  build + the one-time portal/secret setup in `../PLAN_NATIVE_REWRITE.md` (enable Push on
  the App ID, create an APNs .p8, set `APNS_KEY_P8`/`APNS_KEY_ID`/`APNS_TEAM_ID` on Fly).*
- Brain view (`/api/projects/:slug/docs`) — low priority; the cockpit owns legibility now.
- Polish the app icon (currently a generated branded "V" placeholder — fine for TestFlight).
