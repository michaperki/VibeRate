import SwiftUI

struct ProjectsView: View {
    let me: Me
    @Environment(AuthModel.self) private var auth
    @Environment(NavRouter.self) private var router

    @State private var projects: [Project] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showNew = false   // the "New project" create sheet
    // Observe the push singleton so a tapped notification's `pendingRoute` triggers onChange.
    @State private var push = PushManager.shared

    private var client: APIClient { APIClient(token: TokenStore.load()) }

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            List {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                        .listRowBackground(Color.clear)
                }
                ForEach(projects) { project in
                    NavigationLink(value: project) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.name ?? project.slug).font(.headline)
                            HStack(spacing: 10) {
                                if project.streaming == true {
                                    Label("Live agent", systemImage: "dot.radiowaves.left.and.right")
                                        .foregroundStyle(.green)
                                }
                                Text("\(project.sessionCount) conversation\(project.sessionCount == 1 ? "" : "s")")
                                // "When did I last touch this?" is the first question on a
                                // project list — answer it (UI review 2026-06-26).
                                if let ago = project.updatedAgo { Text("· \(ago)") }
                                // "private" is on every row and carries no signal until
                                // something can be public — show only the exception.
                                if project.visibility == "public" {
                                    Label("Public", systemImage: "globe")
                                }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            }
            // Plain style: rows sit directly on the background (iOS Settings-ish) rather
            // than inside one big rounded "web card" container.
            .listStyle(.plain)
            // Hued, layered backdrop instead of pure-black `systemBackground` (the rows are
            // cleared above so it shows through), with a faint brain watermark filling the
            // dead air below a short list.
            .screenBackground()
            .overlay {
                if loading && projects.isEmpty {
                    ProgressView()
                } else if projects.isEmpty && error == nil {
                    VStack(spacing: 16) {
                        GlyphWatermark(systemName: "square.stack.3d.up", size: 140)
                        Text("No projects yet")
                            .font(.headline)
                            .foregroundStyle(.secondary)
                        Button { showNew = true } label: {
                            Label("New project", systemImage: "plus")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .offset(y: 20)
                }
            }
            .navigationTitle("Projects")
            .navigationDestination(for: Project.self) { project in
                CockpitView(project: project)
            }
            // Registered at the stack root (not inside CockpitView) so a push tap can push
            // Cockpit + Drive in one path assignment. Drives both in-app row taps and the
            // out-of-app deep-link. PLAN_NATIVE_PARITY §13.
            .navigationDestination(for: DriveRoute.self) { r in
                DriveSessionView(project: r.project, attachTo: r.sessionId, resumeCid: r.resumeCid,
                                 agentType: r.agentType, initialStatus: r.status, forceNew: r.forceNew)
            }
            // Brain + doc reader, registered once at the root so the cockpit (and a future
            // deep-link) can push them with a single `path` append. PLAN_NATIVE_BRAIN.md.
            .navigationDestination(for: BrainRoute.self) { r in
                BrainView(project: r.project)
            }
            .navigationDestination(for: DocRoute.self) { r in
                DocView(doc: r.doc)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New project")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = me.email { Text(email) }
                        Button("Sign out", role: .destructive) {
                            PushManager.shared.onSignedOut()
                            router.path = NavigationPath()
                            auth.signOut()
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            // Create a project from scratch (the dashboard "New project" parity). On success
            // jump straight into the new project's Cockpit, then refresh the list behind it.
            .sheet(isPresented: $showNew) {
                NewProjectView(token: TokenStore.load()) { project in
                    router.path.append(project)
                    Task { await load() }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            // Signed in and on the home screen — request push permission (first time only)
            // and register this device so the agent can reach you when it needs a decision.
            .task { PushManager.shared.onSignedIn() }
            // A tapped notification set a deep-link route. `initial: true` also fires on a
            // cold launch, where the route was set before this view existed.
            .onChange(of: push.pendingRoute, initial: true) { _, _ in consumeRoute() }
        }
    }

    /// Turn a pending push route into navigation: push the project's Cockpit, then its
    /// DriveSessionView, in one path assignment. Resolves the real Project from the loaded
    /// list when available (so Cockpit reads its name); falls back to a slug-only stub on a
    /// cold launch where projects haven't loaded yet — DriveSessionView only needs the slug.
    private func consumeRoute() {
        guard let r = push.pendingRoute else { return }
        let project = projects.first { $0.slug == r.projectSlug }
            ?? Project(slug: r.projectSlug, name: nil, sessions: nil,
                       visibility: nil, updatedAt: nil, streaming: nil)
        var p = NavigationPath()
        p.append(project)
        p.append(DriveRoute(project: project, sessionId: r.sessionId))
        router.path = p
        push.pendingRoute = nil
    }

    private func load() async {
        loading = true
        error = nil
        do {
            projects = try await client.projects()
        } catch APIError.notAuthorized {
            auth.signOut()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}
