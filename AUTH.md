# Accounts & auth — design + setup checklist

Status: **partly built.** Private-by-default push, machine tokens, signed-in
dashboard, OAuth provider wiring, `/link` claim flow, and publish/unpublish are
implemented. This doc is now the account-layer reference plus the remaining
external provider setup.

## The model (why it's shaped this way)

The CLI/skill runs non-interactively, so it can't do a browser OAuth dance. We
keep two credentials that meet in the middle:

- **Machine token** — minted on first `vbrt push`, saved to
  `~/.viberate/credentials.json`, sent as `Authorization: Bearer`. This is how the
  agent authenticates pushes, headless, today. Unchanged.
- **Account** — how *you* sign in to the web app (Google / GitHub / email link).
- **Claim/link** — `vbrt push` prints `https://vbrt.fly.dev/link#<machineToken>`.
  Open it while signed in and it binds that machine token's projects to your
  account. (Same pattern as `gh auth login` / Vercel CLI.)

So the agent never does OAuth; the human gets real accounts; CLI-pushed projects
show up in the signed-in dashboard after one claim.

## What you need to provision (I can't — these live in your accounts)

Redirect/callback base is `https://vbrt.fly.dev` (swap for a custom domain later).

### GitHub
1. github.com → Settings → Developer settings → OAuth Apps → New OAuth App
2. Homepage URL: `https://vbrt.fly.dev`
3. Authorization callback URL: `https://vbrt.fly.dev/auth/github/callback`
4. Save the **Client ID** + generate a **Client Secret**.

> The **same** OAuth App backs two flows on this one callback: *sign-in*
> (read-only `read:user user:email`) and the separate **"Connect GitHub"** grant
> (`/auth/github/connect`, scope `repo`) that lets a user pick a repo and have Drive
> clone/push it with *their* token instead of the instance `GITHUB_TOKEN`
> (`ONBOARDING.md` Fork 2 Slice 2). The repo token is stored **encrypted** on the
> user record (`encryptSecret`, AES-256-GCM keyed off `SESSION_SECRET`) and never
> returned to the browser. A finer-grained **GitHub App** is the later upgrade.

### Google
1. Google Cloud Console → create/select a project
2. APIs & Services → OAuth consent screen → External; scopes `email`, `profile`
3. Credentials → Create credentials → OAuth client ID → Web application
4. Authorized redirect URI: `https://vbrt.fly.dev/auth/google/callback`
5. Save the **Client ID** + **Client Secret**.

### Email magic-link (optional first cut — needs an email sender)
1. Pick a provider (Resend is simplest; Postmark/SES fine) and verify a sender
   domain or address.
2. Save the **API key** and the **from** address.
   - *If you'd rather ship faster, we can launch Google + GitHub first and add
     magic-link once email is set up.*

### Hand them to Fly as secrets (you run this)
```bash
fly secrets set \
  SESSION_SECRET=$(openssl rand -hex 32) \
  GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  RESEND_API_KEY=...            # only if doing magic-link
```

## What I build once the secrets exist

- [x] Accounts store (user = provider identities + a stable id) and signed-cookie
  sessions (`SESSION_SECRET`).
- [x] Routes: `/auth/{github,google}/start` + `/callback`; `/auth/logout`.
- [x] Claim flow: `/link` binds a machine-token owner-hash to the signed-in
  account; the dashboard lists projects across linked machine tokens.
- [x] Frontend: sign-in buttons on `/app`; token paste remains as a fallback.
- [x] Machine-token push path stays non-interactive.
- [ ] Email magic-link routes, if we decide email auth is worth shipping.
- [ ] Production provider secrets on Fly for whichever providers we launch.
