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
- **Project creation no longer needs the terminal (Slice 1, shipped 2026-06-24).**
  A **"New project"** button in the dashboard (`public/app.js` `openNewProjectModal`)
  creates a project from a Git repo URL alone — `POST /api/projects/new`
  (`src/server.js` → `createProject` in `src/storage.js`) mints the project record
  with the repo as the clone prefill, then the modal kicks the one-time clone and
  drops you into Drive. Previously the **only** way to mint a project was `vbrt push`
  from a terminal; that path still works and remains the capture-first origin, but it
  is no longer required. **Key separation:** project *creation* is account-scoped
  (`currentOwners`), while the *clone* stays on the admin-gated
  `/api/agent/workspace/:slug/setup` — so creation and drive rights are decoupled
  (you can create a project before you can drive it). This is the existing-app half of
  Fork 2 (below), built **without** touching Fork 1 (credentials/billing), so it ships
  while Drive stays operator-Claude + admin-gated for dogfooding.
- **Per-user GitHub connect + repo picker (Slice 2, shipped 2026-06-24).** A signed-in
  user can **Connect GitHub** (`/auth/github/connect`, `repo` scope — a grant separate
  from sign-in's read-only scope) and the New-project window then shows a **picker of
  their repositories** (`GET /api/github/repos`), private ones included. Private clones
  and the agent's pushes now use **the project owner's** connected token, not the shared
  instance `GITHUB_TOKEN`: the token is stored **encrypted** at rest (`encryptSecret`,
  AES-256-GCM keyed off `SESSION_SECRET`), decrypted only in-memory at clone/push time,
  and never sent to the browser. The clone uses a command-scoped credential helper that
  resets the global one (`workspaces.js`); the agent's push uses it via the session's
  child env (`agent.js childEnv`). A pasted URL remains the fallback, and where GitHub
  OAuth isn't configured (local `vbrt serve`) the picker degrades to that URL box.
- **Still clone-only under the hood; no scaffold yet.** `workspaces.js` `startClone`
  still requires a valid `https://` or `git@` repo URL. There is still **no
  start-a-new-project scaffold** — every session runs in an existing checkout (picked
  via GitHub, pasted, or pushed) or the host default cwd. That's the remaining Fork 2
  piece (Slice 3, below). A **GitHub App** (finer scopes than the OAuth `repo` grant)
  is a later hardening upgrade.

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

- **Existing app — Slices 1 & 2 shipped (2026-06-24).** Sign in → **New project** →
  **Connect GitHub** → pick a repository (private included) → it clones and you Drive in
  it, all from the browser. Slice 1 was the no-terminal create (`openNewProjectModal` →
  `POST /api/projects/new` → `createProject`, then `/workspace/:slug/setup` to clone);
  Slice 2 added the **per-user GitHub grant + repo picker** so private clones/pushes use
  the user's own token, not the instance `GITHUB_TOKEN` (`/auth/github/connect`,
  `/api/github/repos`; token encrypted at rest, decrypted only at clone/push time). A
  pasted URL is still accepted, the repo prefill still flows from a pushed bundle's
  `git.origin` (`manifest.repoUrl`), and the setup card remains the fallback for a
  repo-less project. It's now genuinely one-tap for an arbitrary user's *private* repo,
  not just public/operator. **Remaining hardening:** a **GitHub App** for finer scopes
  than the broad OAuth `repo` grant, and token-revocation/expiry UX (the repos call
  already flags `reconnect` on a 401).
- **New app (Slice 3 — still missing):** a user with no repo yet needs a **scaffold**
  path — create an empty workspace (+ optional starter brain: `CLAUDE.md`, `SEED.md`,
  a plan doc) and optionally an empty Git remote to push to. This is the natural
  first-touch for a non-developer-ish "vibe coder" who's never had a repo. Build: a
  "Start a new project" entry alongside "New project from a repo," a minimal
  scaffolder, and (later) an origin-create step via the user's GitHub identity. The
  `createProject` helper already mints a repo-less project record, so the missing piece
  is the scaffolder (seed files + first commit + optional remote), not the record.

## First-run flow (target, once forks are picked)

```
phone → sign in (Google/GitHub, exists)
      → add payment method            (Fork 1A) — or paste API key (1B)
      → New project | Connect a repo  (Fork 2)
            New:     scaffold workspace + starter brain
            Connect: clone repo (private → per-user GitHub token)
      → Drive: type the first prompt → agent works on the host
```

The **Connect: clone repo** branch and everything after "Drive" already exist
(New-project button + GitHub repo picker → workspace bind, spawn, stream, brain glow,
context meter, resume/adopt). The net-new work left is **per-user credential + billing**
(Fork 1), the **new-project scaffold** for repo-less users (Fork 2 Slice 3), plus
opening the admin gate to billed/keyed users instead of an email allowlist.

## Remaining steps (in build order)

1. **Slice 3 — scaffold a brand-new app** *(Fork 2 new-app):* a "Start from scratch"
   entry that seeds an empty workspace (`CLAUDE.md`/`SEED.md`/a plan), commits it, and
   optionally creates the origin via the user's connected GitHub (the `repo` grant from
   Slice 2 already covers repo-create). `createProject` already makes the record; this
   adds the scaffolder.
2. **Fork 1 — per-user credentials + billing** *(the gate to non-operator drive):*
   operator-Claude + metering + billing (1A, reaffirmed), optionally BYO key (1B), and
   replace the admin-email allowlist with a per-account `driveable` grant. Pricing/margin
   is pre-launch homework, not a build blocker (see Fork 1A note above).
3. **Hardening (after the above):** swap the broad OAuth `repo` grant for a **GitHub
   App** (per-repo scopes), add token-revocation/expiry UX (the `reconnect` flag is
   already surfaced), and per-user workspace/credential isolation before opening drive
   beyond the operator.

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
