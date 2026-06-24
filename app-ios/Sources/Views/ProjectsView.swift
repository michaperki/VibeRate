import SwiftUI

struct ProjectsView: View {
    let me: Me
    @Environment(AuthModel.self) private var auth

    @State private var projects: [Project] = []
    @State private var loading = true
    @State private var error: String?

    private var client: APIClient { APIClient(token: TokenStore.load()) }

    var body: some View {
        NavigationStack {
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
                                    Label("live", systemImage: "dot.radiowaves.left.and.right")
                                        .foregroundStyle(.green)
                                }
                                Text("\(project.sessionCount) sessions")
                                if let vis = project.visibility { Text(vis) }
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .overlay {
                if loading && projects.isEmpty { ProgressView() }
            }
            .navigationTitle("Projects")
            .navigationDestination(for: Project.self) { project in
                CockpitView(project: project)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = me.email { Text(email) }
                        Button("Sign out", role: .destructive) { auth.signOut() }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
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
