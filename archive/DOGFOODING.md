# Dogfooding VibeRate with Drive

VibeRate's **Drive** flow can be used to develop VibeRate itself.

Drive binds a project to a real checkout on the host: it clones the repo into a
workspace directory under `/data/workspaces/<slug>` and runs the agent there.
That means you can point Drive at this very repository and use the dashboard —
brain web, plan rings, live mode — to drive (and watch) changes to VibeRate's
own source.

So the loop closes on itself: the sessions, brain docs, and graveyard nodes you
see in the dashboard can be *this* project's work, edited through the very tool
you're looking at. Drive is both the product and its own test fixture.

This note was itself added via the Drive flow as a small dogfooding test.

## Known friction — no instant preview of agent-built output (2026-06-20)

Surfaced while building a mobile UI prototype through Drive: when the agent
writes a file (a prototype, a mock, a new page), there is **no smooth way for the
driver to see it**. The hosted server at `vbrt.fly.dev` runs from the built Docker
image, *not* from the Drive workspace checkout under `/data/workspaces/<slug>`, so
an agent-written file is invisible until it is **committed, pushed to main, and
redeployed by CI** (~minutes). For a throwaway prototype that round-trip is heavy.

**Proposed fix (infra):** a **live preview route** that serves files directly from
the active Drive workspace checkout — e.g. `GET /preview/<slug>/<path>` mapped to
`/data/workspaces/<slug>/<path>`. The hosted server already shares the Fly volume
with the workspaces, so it can serve a freshly-written file with **zero redeploy**.
Scope/guard it to the driver of that workspace (it exposes the checkout's files),
and it turns "build → push → wait for CI → look" into "build → look." This is the
capture→understand→**drive** loop demanding a fourth verb: **preview**.
