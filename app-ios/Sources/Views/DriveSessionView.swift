import SwiftUI

/// Read-only live transcript for a project's most recent Drive session. This is the
/// thinnest end-to-end proof that the whole pipe works: token auth → admin-guarded
/// roster → authenticated SSE stream rendering live. Sending prompts, rich tool-call
/// rendering, and the cockpit roster come as later slices.
struct DriveSessionView: View {
    let project: Project

    @State private var lines: [String] = []
    @State private var status = "connecting…"
    @State private var streamTask: Task<Void, Never>?

    private var token: String? { TokenStore.load() }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(.footnote, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .onChange(of: lines.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
        .navigationTitle(project.name ?? project.slug)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top) {
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(6)
                .background(.bar)
        }
        .task { await connect() }
        .onDisappear { streamTask?.cancel() }
    }

    private func connect() async {
        let client = APIClient(token: token)
        do {
            let sessions = try await client.agentSessions()
            let match = sessions.first { $0.projectSlug == project.slug } ?? sessions.first
            guard let session = match else {
                status = "No active Drive session for this project yet."
                return
            }
            status = "streaming · \(session.status ?? "live")"
            let url = APIConfig.url("/api/agent/sessions/\(session.id)/stream")
            let sse = SSEClient(url: url, token: token)
            streamTask = Task { @MainActor in
                do {
                    for try await event in sse.events() {
                        append(event.data)
                    }
                    status = "stream ended"
                } catch {
                    status = "stream error: \(error.localizedDescription)"
                }
            }
            await streamTask?.value
        } catch {
            status = "error: \(error.localizedDescription)"
        }
    }

    /// The stream emits JSON events `{kind, …}`. The starter surfaces a compact line
    /// per event; richer rendering (thinking, tool I/O, diffs) is a later slice.
    private func append(_ data: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else {
            lines.append(data)
            return
        }
        let kind = obj["kind"] as? String ?? "event"
        if let text = (obj["text"] as? String) ?? (obj["content"] as? String) {
            lines.append("[\(kind)] \(text)")
        } else if let name = obj["name"] as? String {
            lines.append("[\(kind)] \(name)")
        } else {
            lines.append("[\(kind)]")
        }
    }
}
