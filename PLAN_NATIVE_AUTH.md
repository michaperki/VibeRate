# PLAN_NATIVE_AUTH — sign-in inside the native (Capacitor/TestFlight) app

Why social sign-in fails in the wrapped iOS app, the interim workaround, and the
proper fix. First hit 2026-06-23 in TestFlight.

## Symptom

In the TestFlight build, tapping **Continue with Google** *or* **Continue with
GitHub** opens an external browser, you complete the provider login, and the
callback lands on:

> `Sign-in failed: bad OAuth state. Try again from /app.`

(That string is ours — `src/oauth.js`, the `state !== cookieState` guard.)

## Root cause — a split browser context

Our OAuth is a server-side **state-cookie** flow:
`/auth/:provider/start` sets `vbrt_oauth_state` (SameSite=Lax, HttpOnly) then
redirects to the provider; `/auth/:provider/callback` checks the returned `state`
against that cookie. Fine in one browser. In the wrapped app it breaks because the
flow spans **two cookie jars**:

1. Tapping the button navigates the **Capacitor webview** to `vbrt.fly.dev/auth/.../start`
   → `vbrt_oauth_state` is set **in the webview's cookie store** → redirect to the provider.
2. `capacitor.config.json` has `allowNavigation: ["vbrt.fly.dev"]` only, so the
   provider domain (`accounts.google.com` / `github.com`) is **not** allowed in the
   webview — Capacitor punts it to the **external system browser**.
3. The provider redirects to `vbrt.fly.dev/auth/.../callback` **in the external
   browser**, which never had `vbrt_oauth_state` → state mismatch → the error.

Two compounding facts mean "just keep it in the webview" is not a fix:
- **Google blocks OAuth inside embedded webviews** (`disallowed_useragent`).
- Even if the flow completed in the external browser, the `vbrt_sid` **session cookie
  would be set in that browser, not the webview** — so the app would still be logged out.

So both providers fail for the same structural reason; GitHub is not a usable
workaround (confirmed 2026-06-23).

## Interim workaround — token sign-in (shipped)

The sign-in screen's **"Use an access token instead"** path bypasses OAuth entirely:
it stores the token in `localStorage` and sends it as `Authorization: Bearer` — no
cookies, no external browser, all inside the webview. This is the supported way into
the native app today.

To make a pasted token behave like a full account sign-in (not just the projects
pushed under that one token), `currentOwners` in `src/server.js` now resolves a
**bearer token whose hash is linked to an account** to that account's full
`ownerHashes` (via `findUserByOwnerHash` in `src/accounts.js`). So any
account-linked token — one minted via `/api/tokens`, or hand-linked — signs you in
with your whole project list.

**Security note:** this broadens an account-linked token from "its own pushes" to
"all of the account's projects." Acceptable while VibeRate is single-user; revisit
when onboarding/multi-user is picked up (auth infra is deferred — see the memory /
`ONBOARDING.md`).

## Proper fix (deferred — real work, not a one-liner)

Pick one when native sign-in becomes a priority:

- **Deep-link OAuth (RFC 8252, recommended):** run the whole flow in a single
  system-browser auth session (`ASWebAuthenticationSession`), and return to the app
  via a custom URL scheme (`viberate://auth?…`) carrying a one-time code the webview
  exchanges for a session. Needs a custom URL scheme, webview handling, and a server
  endpoint that issues a one-time code to the deep link instead of setting a cookie +
  redirecting to `/app`.
- **Native Google Sign-In SDK:** returns an ID token the backend verifies. Best UX,
  most work, changes the auth model.

Until then: token sign-in is the path, and it now grants full account scope.

## Status

- [x] Documented root cause (cookie context split; both providers; webview block).
- [x] Token sign-in grants full account scope (`currentOwners` + `findUserByOwnerHash`).
- [ ] Deep-link or native OAuth — deferred with onboarding.
