import SwiftUI

struct ProjectsView: View {
    let me: Me
    @Environment(AuthModel.self) private var auth
    @Environment(NavRouter.self) private var router

    @State private var projects: [Project] = []
    @State private var loading = true
    @State private var error: String?
    // Observe the push singleton so a tapped notification's `pendingRoute` triggers onChange.
    @State private var push = PushManager.shared

    private var client: APIClient { APIClient(token: TokenStore.load()) }

    var body: some View {
        @Bindable var router = router
        NavigationStack(path: $router.path) {
            List {
                if let error {
                    Text(error).font(.footnote).foregroundStyle(.red)
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
                                if let vis = project.visibility { Text(vis) }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            // Plain style: rows sit directly on the background (iOS Settings-ish) rather
            // than inside one big rounded "web card" container.
            .listStyle(.plain)
            .overlay {
                if loading && projects.isEmpty { ProgressView() }
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
                                 initialStatus: r.status, forceNew: r.forceNew)
            }
            .toolbar {
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
