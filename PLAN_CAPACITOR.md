# PLAN_CAPACITOR — VibeRate as a native iOS app

The cheapest, lowest-friction path to a real App-Store iOS app, chosen because it keeps
the existing dev loop intact and never requires owning a Mac. Decided & scaffolded
2026-06-22.

> **STATUS: PAUSED / DORMANT (2026-06-23).** We stepped back from TestFlight as the
> dogfooding surface. Every hard bug in the build lived at the WKWebView boundary — the
> recurring tall header (safe-area double-count), the OAuth cookie-jar split, the blank
> Drive stream — and fixing them cost real security debt (RCE-capable token, token-in-URL;
> `PLAN_NATIVE_AUTH.md`). Daily dogfooding moved back to **mobile Safari / Add-to-Home-Screen
> standalone PWA**, where `env(safe-area-inset-*)` and cookies just work (see `STORY.md`
> Ch. 11). The scaffold below is **kept, not deleted** — it's config + CI pointing at the
> live URL, cheap to park. The iOS-only cruft that had leaked into the shared web app (the
> `?satdebug` diagnostic + the keyboard-close safe-area measurement loop) was removed from
> `public/app.js`. **If reviving this path, do it properly:** deep-link OAuth (RFC 8252) to
> retire the auth hacks, and reintroduce the WKWebView safe-area compensation (git
> `b73e4af..5e45389`) only inside the wrapper, not the shared app. Everything below is the
> original plan, preserved for that revival.

## The decision

Wrap the existing web SPA in a **Capacitor** native shell and build it on a **cloud Mac
(Codemagic)** — not a native rewrite, not a cloud-Mac desktop.

Why this over the alternatives we weighed:

- **vs. native Swift / React Native rewrite** — the phone is a pure control surface; the
  agent runs on the Fly server, not the device. A rewrite re-implements 5,700 lines of
  working UI to point at the same backend, and (for Swift) reintroduces a Mac dependency
  for the dev loop. Capacitor reuses the SPA verbatim.
- **vs. PWA** — Capacitor gives a real App-Store listing + proper APNs push; a PWA can't
  list and has weaker iOS push. We already pay the $99/yr Apple fee, so the store path is
  worth taking.
- **vs. owning / renting a Mac** — Codemagic compiles + signs on its macOS instances,
  triggered by a git push, just like Fly autodeploys the web app. No Mac, ever.

## How it preserves the existing loop

The Capacitor webview loads **`https://vbrt.fly.dev/app`** directly (`server.url` in
`capacitor.config.json`). So the loop is unchanged:

> prompt → Drive edits + pushes → Fly autodeploys → refresh inside the native app

Feature work needs **no iOS rebuild**. A Codemagic build is only run when you want a fresh
store/TestFlight build (e.g. after changing native config, icons, or push handling). The
agent keeps working in the Drive Linux container exactly as today — it never touches a Mac.

Trade-off accepted: the app is online-only (no offline shell) and reflects whatever is
live on Fly. Fine for now; revisit with bundled assets + live-updates if offline matters.

## The App Store 4.2 guardrail

Apple can reject an app that is *purely* a remote website. The mitigation is built in from
the start: ship **native push notifications** (`@capacitor/push-notifications`, wired for
"your agent is asking a question / finished") plus native integration. Lead with that in
the review notes; don't ship a bare webview.

## What's already scaffolded (in this repo)

- `package.json` — Capacitor deps (`@capacitor/core`, `/ios`, `/push-notifications`) +
  dev (`/cli`, `/assets`); scripts `ios:add`, `ios:sync`, `ios:assets`.
- `capacitor.config.json` — appId `com.viberate.app`, webview → `vbrt.fly.dev/app`, push
  presentation options. **`ios.contentInset: "never"`** is deliberate: the SPA already
  owns the safe area via `viewport-fit=cover` + `env(safe-area-inset-*)` (PLAN_MOBILE.md),
  so the WKWebView must NOT also inset its scroll content. The scaffold shipped with
  `"always"`, which double-applied the top inset and rendered a ~120px dark band above the
  mobile app bar in TestFlight (header looked ~200px tall). Leave it `"never"`.
- `codemagic.yaml` — `ios-release` workflow: generates the Xcode project on the Mac
  (`cap add ios`), signs, builds the IPA, publishes to TestFlight. The `ios/` Xcode
  project is intentionally **not committed** — CI regenerates it (it can't be built or
  verified from the Linux Drive container anyway). Note: Capacitor 8's CLI needs **Node
  ≥22**, so the CI workflow pins Node 22 — this is independent of the server, which stays
  on Node 20.

## What only you can do (one-time, ~30–45 min, all from Windows + browser)

These need your Apple identity / secrets, so they can't be scaffolded by the agent:

1. **Register the app** — in [Apple Developer](https://developer.apple.com/account) create
   an App ID for bundle `com.viberate.app`; in
   [App Store Connect](https://appstoreconnect.apple.com) create the app record. Note its
   numeric **Apple ID** and put it in `codemagic.yaml` (`APP_STORE_APPLE_ID`).
2. **App Store Connect API key** — App Store Connect → Users and Access → Integrations →
   create an API key (App Manager role). Download the `.p8`.
3. **Codemagic** — sign up (free tier), connect this GitHub repo, then Teams →
   Integrations → **App Store Connect** → add the key, naming it **`VibeRateASC`** (the
   name `codemagic.yaml` references). Codemagic manages signing certs/profiles for you.
3a. **TestFlight internal group** — in App Store Connect → your app → **TestFlight**,
   create an **internal** beta group named EXACTLY **`Internal Testers`**, set its
   distribution to **Manual** (toggle OFF "Automatically distribute builds" — automatic
   groups can't accept the manual build assignment Codemagic does), and add yourself as a
   tester. `codemagic.yaml` publishes the build straight to this group with no beta
   review. If the group is missing the publish step fails with *"Cannot find Beta group
   with the name 'Internal Testers'"*; if you instead route through external review (by
   adding `submit_to_testflight: true`) Apple additionally demands a feedback email +
   reviewer contact info under TestFlight → Test Information. Internal direct-publish
   needs none of that. **Export compliance** is also required before a build is
   assignable: a build with no `ITSAppUsesNonExemptEncryption` answer is flagged
   "Missing Compliance" and the publish fails with *"Build is not assignable. - Build
   is not in an internally testable state."* `codemagic.yaml` injects
   `ITSAppUsesNonExemptEncryption = false` into the generated `Info.plist` each build
   (VibeRate only uses exempt HTTPS/TLS), so you don't have to answer it in the UI.
4. **Push key (APNs)** — in Apple Developer → Keys, create an APNs Auth Key (`.p8`) for
   push. You'll feed it to whatever sends pushes (your Fly server) when wiring the
   notification backend — separate task, not needed for the first build.
5. **App icon** — drop a 1024×1024 `assets/icon.png` (and optional `assets/splash.png`)
   in the repo; CI auto-generates all sizes via `@capacitor/assets`. Until then it builds
   with the default icon.

Then run the `ios-release` workflow in Codemagic → build lands in **TestFlight** → install
on your iPhone via the TestFlight app. Internal testers skip App Review.

## Status / next

- [x] Capacitor + Codemagic scaffold committed-ready in the repo.
- [x] App registered: name **VibeRate IDE**, bundle `com.viberate.app`, App Store Connect
      Apple ID `6782960153` (wired into `codemagic.yaml`).
- [x] You: App Store Connect API key → added to Codemagic as `VibeRateASC`; repo connected.
- [x] Build compiles, signs, uploads to App Store Connect, and finishes processing.
- [x] Build number auto-bumps above the latest TestFlight build (CI derives it from
      `get-latest-testflight-build-number`), so re-uploads no longer 409 on a duplicate
      `CFBundleVersion` (Capacitor hardcodes it to `1`).
- [ ] You: create internal TestFlight group `Internal Testers` (Manual distribution) — see
      step 3a; the publish step can't find it until you do. Build & signing already work;
      this is the last gate before the build lands on your phone.
- [ ] You: add `assets/icon.png`.
- [ ] First Codemagic build → TestFlight install.
- [ ] Wire APNs push end to end (Fly server → device) — the "agent needs you" notification.
- [ ] Submit for App Review (lead with push/native value for the 4.2 guardrail).
