# Onboarding & credentials — how a new user gets to "my agent is working"

> Status: **open spec.** The two central forks (whose Claude runs the agent; new
> vs. existing app) are undecided — this doc lays out the options and the current
> code state, per the house decision style (`PLAN_AGENT_RUNTIME.md`,
> `PROJECT_VIEW_PLAN.md`): document the forks, don't pick unilaterally. Canonical
> frame: `PRODUCT_STRATEGY.md`. Web-account auth (sign-in to the dashboard) is a
> *separate, already-built* layer — see `AUTH.md`.

## Why this is the top blocker

VibeRate is now a mobile, agent-first IDE, but **only the operator can actually
drive.** A new user has no path to "my agent is running on my repo from my phone."
Until onboarding exists, Drive is a single-tenant dogfooding tool. Everything else
in the agent-first cluster (`ROADMAP.md`) sits behind this.

## What exists today (grounded in code)

- **Drive runs on the operator's Claude, not the user's.** `agent.js` spawns the
  real `claude` binary with the host's auth: a Fly operator's Max subscription
  seeded from the `CLAUDE_CREDENTIALS_JSON` secret into `~/.claude/.credentials.json`
  (`ensureSubscriptionCredentials`), or an `ANTHROPIC_API_KEY`. When a subscription
  login is present it strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the
  child so the Max token wins (`childEnv`). **There is no per-user Claude credential
  and no per-user billing.**
- **Drive is gated, deny-by-default.** Local = loopback-only; hosted = an
  admin-email allowlist checked against the signed-in user (`agentRoutes.js`
  `makeAdminGuard` / `loopbackOnly`). A phone hitting the hosted URL is not loopback,
  so it must pass the admin gate — i.e. today only the operator's account can drive
  from a phone.
- **Web accounts already work** (separate from Claude creds): GitHub/Google OAuth,
  signed-cookie sessions, the `/link` claim flow (`oauth.js`, `accounts.js`,
  `AUTH.md`). This is how a user *signs in*; it does **not** grant drive rights or
  supply a Claude credential.
- **Workspace setup is clone-only.** `workspaces.js` `startClone` requires a valid
  `https://` or `git@` repo URL and clones it into `/data/workspaces/<slug>`
  (`PLAN_DRIVE_WORKSPACES.md`). Private repos use a `GITHUB_TOKEN` instance secret.
  There is **no start-a-new-project path** — every session runs in an existing
  checkout (or the host default cwd).

## Fork 1 — whose Claude runs the agent?

The load-bearing question. Three shapes; not mutually exclusive.

### A — Operator-Claude + billing *(leaning toward this as the clean path)*
The user adds a payment method and rents *our* Claude. We meter their usage
(tokens / turns / time) and bill it, running every session on operator-held
credentials (API key, or pooled subscription within Anthropic's terms).
- **Pros:** zero credential friction for the user (sign in, add card, drive); no
  user-side ToS exposure; one auth surface we control; natural monetization.
- **Cons:** we carry the cost and the abuse/runaway risk (an RCE control plane the
  user pays for — needs hard usage caps, rate limits, and per-user spend ceilings);
  margin/pricing must be worked out; Anthropic-terms review for reselling capacity.
- **Build:** per-user metering on the turn loop, a billing integration (Stripe), a
  spend cap that interrupts a session, and per-user credential isolation so one
  user's runaway can't burn another's budget.

> **Reaffirmed 2026-06-23 (Mike):** **1A is the intended model** — "I'll let users use
> my tokens and then charge them." Operator-Claude + per-user metering + billing.
> Sequencing: **pricing/margin must be settled before go-to-market** — it gates the
> launch, not the build, and the demo (`DEMO_PLAN.md`) can be recorded ahead of it. The
> open 1A questions below (flat vs. metered vs. credit-pack, the spend-cap UX, and
> whether Anthropic's terms permit pooled-subscription resale vs. requiring API-key
> billing) are the pre-launch homework, not blockers for dogfooding now.

### B — BYO key (user supplies their own `ANTHROPIC_API_KEY`)
The user pastes their own API key; we run their sessions on it.
- **Pros:** fastest to market; we carry no model cost; clean ToS story (it's their
  key, their account).
- **Cons:** key handling is a serious secret-management problem (store encrypted,
  never log, scope per session); not a *subscription* — API-key pricing is what the
  user pays Anthropic directly; worse UX (most phone users don't have an API key
  handy).

### C — BYO OAuth / subscription token *(gated on ToS clarity — likely not viable)*
The user supplies their own Claude *subscription* OAuth token so sessions run on
their Max/Pro plan.
- **Pros:** best user economics (their existing subscription), best UX if it works.
- **Cons:** **almost certainly bumps Anthropic's terms** for non-CLI use of
  subscription credentials, and is fragile (token rotation/expiry). **Do not ship
  without explicit legal/ToS clarity.** Treat as blocked until then.

**Recommendation to validate:** ship **A** (operator-Claude + billing) as the real
product path, optionally offer **B** (BYO key) as a power-user fast lane, and hold
**C** until the ToS question is answered. "Maybe we can do both" (A + B) is a
reasonable end state; A is the one that makes a phone-first, card-on-file
consumer onboarding work.

## Fork 2 — load an existing app vs. start a new one

- **Existing app (works today):** clone a Git repo into the workspace
  (`workspaces.js`), bind it to the project, drive in it. Onboarding here is: sign
  in → paste/pick a repo URL (prefill from the pushed bundle's `git.origin` when we
  have it) → clone → drive. For private repos, a per-user GitHub auth (the existing
  OAuth identity can carry a repo-scoped token) replaces the single instance
  `GITHUB_TOKEN`.
- **New app (missing):** a user with no repo yet needs a **scaffold** path — create
  an empty workspace (+ optional starter brain: `CLAUDE.md`, `SEED.md`, a plan doc)
  and optionally an empty Git remote to push to. This is the natural first-touch for
  a non-developer-ish "vibe coder" who's never had a repo. Build: a "Start a new
  project" entry alongside "Connect a repo," a minimal scaffolder, and (later) an
  origin-create step via the user's GitHub identity.

## First-run flow (target, once forks are picked)

```
phone → sign in (Google/GitHub, exists)
      → add payment method            (Fork 1A) — or paste API key (1B)
      → New project | Connect a repo  (Fork 2)
            New:     scaffold workspace + starter brain
            Connect: clone repo (private → per-user GitHub token)
      → Drive: type the first prompt → agent works on the host
```

Everything after "Drive" already exists (workspace bind, spawn, stream, brain glow,
context meter, resume/adopt). The net-new work is **per-user credential + billing**
(Fork 1) and the **new-project scaffold** (Fork 2), plus opening the admin gate to
billed/keyed users instead of an email allowlist.

## Constraints carried in from the runtime

- **Driving is RCE on the host.** Per-user drive means per-user blast radius —
  isolate workspaces and credentials per user, enforce the single-writer ownership
  lease (`PLAN_AGENT_RUNTIME.md`), and add hard spend/rate caps before opening the
  gate beyond the operator.
- **Separate device/control credentials from share/view credentials** when this
  goes multi-tenant (the runtime doc's standing rule).
- **Secret hygiene:** a user-supplied key/token (1B/1C) and a per-user repo token
  must be stored encrypted, never logged, and never sent to the browser — same
  discipline as the existing `GITHUB_TOKEN` clone path.

## Open questions

- Pricing/margin for Fork 1A (flat, metered, or credit-pack?) and the spend-cap UX.
- Does Anthropic's terms permit reselling subscription capacity (1A pooled) vs.
  requiring API-key billing for resold usage? Answers gate 1A's exact shape.
- Where multi-tenant drive rights live once the email allowlist is replaced (a
  `driveable` flag per account? tied to "has a valid payment method / key"?).
- Per-user GitHub auth for private clones — reuse the existing OAuth identity's
  scopes, or a separate "connect GitHub for repos" grant?
