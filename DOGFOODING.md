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
