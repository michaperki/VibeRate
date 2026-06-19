# Plan — Drive workspaces (bind a project to a checkout on the host)

> The missing link that makes "✦ Drive inside project X" actually work *on
> project X's code*. Hosted-first: agents run on the Fly volume, so a project
> needs a real git checkout there, cloned once and bound. Follows
> `PLAN_AGENT_RUNTIME.md` (Drive) and `DRIVE_CONVO_RECONCILIATION.md` (the fold-in).

## The problem

"Project" means two different things and they weren't connected:

1. **Dashboard project** — pushed *bundle* data (conversations + brain). **No
   source code.** Keyed by slug.
2. **Workspace** — a real git checkout on the host where `claude` is spawned (a
   `cwd`). This is what Drive needs to *do* anything.

Hosted Drive runs agents on the **Fly volume** (`/data`), not a laptop. So driving
"in project X" only works if X's repo is checked out on the volume and the session
is pointed at it. Today Drive uses a single global `VBRT_AGENT_CWD=/data/drive`, so
the `✦ Drive`-in-a-project gesture is cosmetic — the agent doesn't get X's code.
And `vbrt push` ships the *bundle*, not the tree, so push can't supply the checkout.

Cloning is **project setup, done once** — never a per-conversation step (that was
the chicken-and-egg knot: "ask the agent to clone" happens in a convo that's in the
wrong place). We bind a project to a workspace once; every convo then starts inside
it.

## Model

- **Workspaces root** on the volume: `VBRT_WORKSPACES_DIR` (default
  `<DATA_DIR>/workspaces`, i.e. `/data/workspaces` hosted). Never `/app` (server
  source) or the project store.
- Each project gets `<root>/<slug>` as its checkout dir.
- The binding lives on the project manifest (`project.json`):
  `workspace: { repo, branch, dir, status, head, error, updatedAt }` where
  `status ∈ none | cloning | ready | error`.
- The repo URL is **prefilled** from the pushed bundle's `git.origin` (captured at
  push) when available, but is editable in the setup step.
- **Private repos**: clone uses a `GITHUB_TOKEN` instance secret if present
  (`https://x-access-token:<token>@github.com/…`); the token is used for the clone
  and never persisted or logged. No token through the browser.

## Flow

```
✦ Drive in project X
   └─ GET /api/agent/workspace/X
        ├─ status=ready  → start form, cwd = workspace.dir (locked) → prompt
        └─ otherwise     → "Set up workspace" card:
              repo (prefill from bundle origin) + branch
                 └─ POST /workspace/X/setup → clone into /data/workspaces/X (async)
                       └─ poll GET until ready → prompt
   └─ POST /api/agent/sessions { projectSlug:X, prompt, permissionMode }
        server resolves X → workspace.dir (must be ready) → spawns claude there
```

## Surface

- **storage.js** — `getProjectManifest(slug)`, `getWorkspace(slug)` (→ binding +
  `suggestedRepo` from manifest.repoUrl), `setWorkspace(slug, patch)`; persist
  `repoUrl` from `bundle.git.origin` on ingest (set once).
- **git.js** — `extractGit` also returns `origin` (`git remote get-url origin`).
- **src/workspaces.js** (new) — `workspaceDir(slug)`, `cloneWorkspace(slug,{repo,
  branch})` (async, rm+clone, token-auth, status tracking), `syncWorkspace(slug)`
  (fetch + hard reset), `resolveProjectCwd(slug)` (ready dir or null), head sha.
- **agentRoutes.js** — `GET /workspace/:slug`, `POST /workspace/:slug/setup`,
  `POST /workspace/:slug/sync` (all admin-guarded); `POST /sessions` accepts
  `projectSlug` → resolves to the workspace cwd (409 if not ready).
- **app.js** — `openDriveForProject(slug)`: status fetch → ready→prompt, else
  setup card with clone + polling; sessions pass `projectSlug`.
- **DEPLOY.md** — document `VBRT_WORKSPACES_DIR` and the `GITHUB_TOKEN` secret.

## Non-goals (v1)

- Auto-pull before every turn (agents can `git pull/push` themselves; a manual
  **sync** button covers drift).
- Per-user workspaces / multi-tenant (instance is single-admin today —
  [[viberate-drive-auth]]).
- Surfacing a driven session in the convos rail before its JSONL is ingested
  (tracked separately; `watch`/`push` still bridges that).

## Checklist

- [x] `git.js` captures `origin`; ingest persists `repoUrl` on the manifest.
- [x] storage.js workspace get/set helpers.
- [x] `src/workspaces.js`: clone / sync / resolve, token auth, status tracking.
- [x] Workspace routes + `projectSlug` resolution in `POST /sessions`.
- [x] Front-end `openDriveForProject` setup+drive flow with clone polling.
- [x] DEPLOY.md documents the workspaces dir + `GITHUB_TOKEN`.
- [x] Syntax-checked, booted, routes probed (clone octocat/Hello-World → ready), committed.
