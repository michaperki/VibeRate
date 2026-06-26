import SwiftUI

/// First-run setup for a project that has no checkout on the host yet. Driving an agent
/// needs a real workspace (`/data/workspaces/<slug>`), so `POST /api/agent/sessions`
/// 409s until one is cloned. This sheet closes that gap on the phone: it prefills the
/// repo the project was created from, clones it (`POST /api/agent/workspace/:slug/setup`),
/// polls until the clone + dep-install finishes, then hands control back so the queued
/// prompt can start the project's first agent. Runs once per project.
struct WorkspaceSetupView: View {
    let project: Project
    let token: String?
    /// Called when the workspace reaches `ready` — the caller re-sends the queued prompt.
    var onReady: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var repo = ""
    @State private var branch = ""
    @State private var phase: Phase = .loading
    @State private var error: String?
    @State private var scaffolding = false   // the busy `.cloning` phase is a from-scratch init, not a clone

    /// `loading` = fetching the prefill/current state, `form` = awaiting the user,
    /// `cloning` = clone in flight (poll until ready/error).
    private enum Phase { case loading, form, cloning }

    private var client: APIClient { APIClient(token: token) }
    private var trimmedRepo: String { repo.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://github.com/owner/repo", text: $repo)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(phase == .cloning)
                    TextField("Branch (optional)", text: $branch)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(phase == .cloning)
                } header: {
                    Text("Repository")
                } footer: {
                    Text("VibeRate clones this repo onto the host so an agent can drive it. This happens once per project.")
                }

                // No repo to point at? Start from scratch instead — `git init` an empty,
                // brain-seeded checkout so the project is driveable without any GitHub repo.
                if phase != .cloning {
                    Section {
                        Button { Task { await scaffold() } } label: {
                            Label("Start from scratch (no repo)", systemImage: "sparkles")
                        }
                        .disabled(phase == .loading)
                    } footer: {
                        Text("Creates an empty project your agent builds up from your first message.")
                    }
                }

                if phase == .cloning {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(scaffolding ? "Setting up an empty project…" : "Cloning and installing dependencies… this can take a minute.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
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
            .navigationTitle("Set up workspace")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(phase == .cloning)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(phase == .cloning)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if phase == .cloning {
                        ProgressView()
                    } else {
                        Button("Clone") { Task { await clone() } }
                            .disabled(trimmedRepo.isEmpty || phase == .loading)
                    }
                }
            }
            .task { await prefill() }
        }
    }

    /// Prefill the form from the project's suggested repo, and short-circuit if the
    /// workspace is already ready (e.g. someone set it up from the web meanwhile).
    private func prefill() async {
        do {
            let info = try await client.workspace(slug: project.slug)
            if let ws = info.workspace, ws.status == "ready" { onReady(); dismiss(); return }
            if repo.isEmpty, let s = info.suggestedRepo, !s.isEmpty { repo = s }
            else if repo.isEmpty, let r = info.workspace?.repo, !r.isEmpty { repo = r }
            if let b = info.workspace?.branch, !b.isEmpty { branch = b }
        } catch {
            self.error = apiMessage(error)
        }
        phase = .form
    }

    /// Start from scratch: `git init` a brain-seeded empty checkout (no repo, no remote).
    /// Resolves to `ready` synchronously server-side, so there's no polling — hand control
    /// straight back so the queued first message can start the project's first agent.
    private func scaffold() async {
        error = nil
        scaffolding = true
        phase = .cloning   // reuse the busy state to lock the form while it runs
        defer { scaffolding = false }
        do {
            let ws = try await client.scaffoldWorkspace(slug: project.slug, name: project.name)
            if ws.status == "ready" { onReady(); dismiss(); return }
            error = ws.error ?? "Could not start from scratch."
            phase = .form
        } catch {
            self.error = apiMessage(error)
            phase = .form
        }
    }

    /// Kick off the clone, then poll the workspace status until it leaves `cloning`.
    private func clone() async {
        let url = trimmedRepo
        guard !url.isEmpty else { return }
        error = nil
        phase = .cloning
        let br = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await client.setupWorkspace(slug: project.slug, repo: url, branch: br.isEmpty ? nil : br)
            // Clone + dep-install runs in the background server-side; poll until done.
            // ~3 min ceiling so a wedged clone can't poll forever.
            for _ in 0..<90 {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let info = try await client.workspace(slug: project.slug)
                switch info.workspace?.status {
                case "ready":
                    onReady(); dismiss(); return
                case "error":
                    error = info.workspace?.error ?? "Clone failed."
                    phase = .form
                    return
                default:
                    continue   // still cloning
                }
            }
            error = "Still cloning — give it a moment and try sending again."
            phase = .form
        } catch {
            self.error = apiMessage(error)
            phase = .form
        }
    }
}
