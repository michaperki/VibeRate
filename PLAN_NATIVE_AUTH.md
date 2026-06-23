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

## Drive (the admin control plane) in the native app

Same root cause, one layer deeper: the Drive button only lights up if
`/api/agent/health` succeeds, and that route's `makeAdminGuard` (`src/agentRoutes.js`)
required an OAuth **session** whose email is in `VBRT_ADMIN_EMAILS`. A token sign-in
has no session, so Drive stayed dark in the app.

Fix: the admin guard now resolves identity from an OAuth session **or** an
admin-linked bearer token (`adminEmailFor` → `findUserByOwnerHash`). So the same
token that signs you in also unlocks Drive on the phone — the "drive agents from
your phone" loop.

**Security:** this makes an admin-linked token **RCE-capable** (Drive spawns agents =
code execution on the host), not just read scope. Accepted for the single-user
instance; before multi-user, move Drive to a real admin *session* (deep-link OAuth)
or a separate, narrowly-scoped Drive credential.

## Drive's live stream (SSE) in the native app

Third layer of the same cookie split, found 2026-06-23 on the first TestFlight drive:
the message you sent and the agent's tool calls showed up in **Convos**, but the
**Drive** chat rendered *nothing* — not even your own bubble — while the working timer
kept ticking.

Cause: Drive paints every bubble from the live SSE transcript (`driveOpenStream` →
`EventSource` → `driveRender`), and `driveSend` doesn't optimistically render — it POSTs
and waits for the server to echo `user_prompt` over the stream. But `EventSource` **can't
set an `Authorization` header**, and the native app has no session cookie, so the
admin-guarded `/api/agent/sessions/:id/stream` 403'd and emitted zero events. Every other
call worked because the fetch helpers carry the Bearer token — hence Convos populated,
Drive stayed blank, and the timer (a client-local interval seeded by the authorized
session fetch) ticked on regardless.

Fix: the stream route accepts the admin token as an `?access_token=` query param, folded
back into the Authorization header by a route-scoped `streamGuard`; the client appends
`state.token` to the EventSource URL. Token-in-URL is logged, but it's the same single-user
RCE-capable token from above — no new trust boundary. Deep-link/native OAuth retires this
alongside the tradeoffs above.

## Status

- [x] Documented root cause (cookie context split; both providers; webview block).
- [x] Token sign-in grants full account scope (`currentOwners` + `findUserByOwnerHash`).
- [x] Drive unlocked in the app via admin-linked token (`adminEmailFor` in the guard).
- [x] Drive live stream authenticates in the app via `?access_token=` (`streamGuard`).
- [ ] Deep-link or native OAuth — deferred with onboarding (also retires the
      RCE-capable-token tradeoff above).
