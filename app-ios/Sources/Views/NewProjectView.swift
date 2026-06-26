import SwiftUI

/// Create a project from scratch on the phone — the native counterpart to the dashboard's
/// "New project" button (`POST /api/projects/new`). It only mints the project record (+ an
/// optional repo hint); the actual checkout is cloned later by `WorkspaceSetupView` the
/// first time you drive an agent, so a repo URL is optional here. On success it hands the
/// new project back to the caller, which reloads the list and navigates straight into it.
struct NewProjectView: View {
    let token: String?
    /// Called with the freshly-minted project once `POST /api/projects/new` succeeds.
    var onCreated: (Project) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var repo = ""
    @State private var branch = ""
    @State private var creating = false
    @State private var error: String?

    private var client: APIClient { APIClient(token: token) }
    private var trimmedRepo: String { repo.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name (optional)", text: $name)
                        .disabled(creating)
                } footer: {
                    Text("A label for this project. Defaults to the repo name if left blank.")
                }

                Section {
                    TextField("https://github.com/owner/repo", text: $repo)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .disabled(creating)
                    TextField("Branch (optional)", text: $branch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(creating)
                } header: {
                    Text("Repository (optional)")
                } footer: {
                    Text("The repo an agent will drive. You can add it now or paste it in when you first start a session.")
                }

                if let error {
                    Section {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(creating)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(creating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if creating {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await create() } }
                    }
                }
            }
        }
    }

    private func create() async {
        error = nil
        creating = true
        do {
            let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedBranch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            let reply = try await client.createProject(
                name: trimmedName.isEmpty ? nil : trimmedName,
                repo: trimmedRepo.isEmpty ? nil : trimmedRepo,
                branch: trimmedBranch.isEmpty ? nil : trimmedBranch)
            // The fresh project isn't in the list yet — hand a lightweight stub straight to
            // the caller so it can navigate in immediately (slug == the returned id). The
            // list reload that follows fills in the rest.
            let project = Project(slug: reply.id, name: trimmedName.isEmpty ? nil : trimmedName,
                                  sessions: nil, visibility: nil, updatedAt: nil, streaming: nil)
            onCreated(project)
            dismiss()
        } catch {
            self.error = apiMessage(error)
            creating = false
        }
    }
}
