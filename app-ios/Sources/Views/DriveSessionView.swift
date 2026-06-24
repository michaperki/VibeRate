import SwiftUI

/// A project's live Drive session: watch the agent work AND steer it. Streams the
/// transcript over authenticated SSE and posts follow-up prompts; if no agent is
/// running yet, the first message starts one in the project's bound workspace. This is
/// the core "drive from your phone" loop — the read-only viewer became interactive.
struct DriveSessionView: View {
    let project: Project

    struct Bubble: Identifiable {
        enum Role { case user, assistant, tool, error }
        let id = UUID()
        let role: Role
        var text: String
    }

    @State private var bubbles: [Bubble] = []
    @State private var status = "Connecting…"
    @State private var sessionId: String?
    @State private var streamTask: Task<Void, Never>?
    @State private var draft = ""
    @State private var sending = false
    @State private var ready = false                 // initial connect resolved
    @State private var assistantOpen = false         // last bubble is an in-progress assistant block
    @State private var pendingEcho: String?          // optimistic prompt awaiting its stream echo

    private var token: String? { TokenStore.load() }
    private var client: APIClient { APIClient(token: token) }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            composer
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

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if bubbles.isEmpty {
                        Text("Nothing here yet. Send a message to steer the agent.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 40)
                    }
                    ForEach(bubbles) { b in
                        bubbleView(b)
                            .frame(maxWidth: .infinity, alignment: b.role == .user ? .trailing : .leading)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .onChange(of: bubbles.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: bubbles.last?.text) { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }

    @ViewBuilder
    private func bubbleView(_ b: Bubble) -> some View {
        switch b.role {
        case .user:
            Text(b.text)
                .padding(10)
                .background(Color.accentColor.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .textSelection(.enabled)
        case .assistant:
            Text(b.text)
                .textSelection(.enabled)
        case .tool:
            Text(b.text)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
        case .error:
            Text(b.text)
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }

    // MARK: - Composer

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Message the agent…", text: $draft, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .disabled(sending || !ready)
            Button {
                Task { @MainActor in await send() }
            } label: {
                Image(systemName: sending ? "ellipsis.circle" : "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(sending || !ready || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(8)
        .background(.bar)
    }

    // MARK: - Networking

    private func connect() async {
        do {
            let sessions = try await client.agentSessions()
            let match = sessions.first { $0.projectSlug == project.slug } ?? sessions.first
            if let session = match {
                sessionId = session.id
                status = humanStatus(session.status)
                openStream(session.id)
            } else {
                status = "No agent running yet — send a message to start one."
            }
        } catch {
            status = friendly(error)
        }
        ready = true
    }

    private func openStream(_ id: String) {
        streamTask?.cancel()
        let url = APIConfig.url("/api/agent/sessions/\(id)/stream")
        let sse = SSEClient(url: url, token: token)
        streamTask = Task { @MainActor in
            do {
                for try await event in sse.events() { ingest(event.data) }
            } catch is CancellationError {
                // we re-opened the stream — not an error to surface
            } catch {
                status = "Connection lost — leave and reopen to retry."
            }
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        sending = true
        defer { sending = false }

        // Optimistic: show the prompt immediately; the stream will echo it as a
        // `user_prompt` which we then dedupe against pendingEcho.
        bubbles.append(Bubble(role: .user, text: text))
        assistantOpen = false
        pendingEcho = text

        do {
            if let id = sessionId {
                try await client.sendMessage(sessionId: id, prompt: text)
            } else {
                let session = try await client.startSession(projectSlug: project.slug, prompt: text)
                sessionId = session.id
                status = humanStatus(session.status)
                openStream(session.id)
            }
        } catch {
            // Roll back the optimistic bubble — the send didn't take (e.g. agent busy).
            if pendingEcho == text, bubbles.last?.role == .user, bubbles.last?.text == text {
                bubbles.removeLast()
            }
            pendingEcho = nil
            bubbles.append(Bubble(role: .error, text: friendly(error)))
        }
    }

    // MARK: - Stream rendering

    /// Fold one stream event into the transcript. Streamed assistant text arrives as
    /// many `assistant_text_delta`s — coalesce them into one growing bubble instead of a
    /// line per token. Thinking and bookkeeping events are skipped for this phone view.
    private func ingest(_ data: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { return }
        switch obj["kind"] as? String ?? "" {
        case "user_prompt":
            if let t = obj["text"] as? String {
                if t == pendingEcho { pendingEcho = nil }          // our own optimistic bubble
                else { bubbles.append(Bubble(role: .user, text: t)) }
                assistantOpen = false
            }
        case "assistant_text_start":
            bubbles.append(Bubble(role: .assistant, text: ""))
            assistantOpen = true
        case "assistant_text_delta":
            if let t = obj["text"] as? String { appendAssistant(t) }
        case "assistant_text":
            if let t = obj["text"] as? String {
                bubbles.append(Bubble(role: .assistant, text: t))
                assistantOpen = false
            }
        case "tool_use":
            if let n = obj["name"] as? String {
                bubbles.append(Bubble(role: .tool, text: "→ \(n)"))
                assistantOpen = false
            }
        case "block_stop", "turn_end", "result", "stopped":
            assistantOpen = false
        case "status":
            if let s = obj["status"] as? String { status = humanStatus(s) }
        case "error":
            if let m = obj["message"] as? String { bubbles.append(Bubble(role: .error, text: m)) }
        default:
            break
        }
    }

    private func appendAssistant(_ delta: String) {
        if assistantOpen, var last = bubbles.last, last.role == .assistant {
            last.text += delta
            bubbles[bubbles.count - 1] = last
        } else {
            bubbles.append(Bubble(role: .assistant, text: delta))
            assistantOpen = true
        }
    }

    /// Turn raw session/status strings into something a first-time user understands —
    /// no "streaming", no internal status codes.
    private func humanStatus(_ raw: String?) -> String {
        switch raw {
        case "working", "running": return "Working…"
        case "idle", "ready": return "Idle"
        case "waiting", "waiting_for_input", "blocked": return "Waiting for you"
        case "done", "completed", "ended": return "Done"
        case "error", "failed": return "Error"
        case .some(let s) where !s.isEmpty: return s.prefix(1).uppercased() + s.dropFirst()
        default: return "Idle"
        }
    }

    /// Pull the server's `{error: "…"}` message out of an HTTP error body when present.
    private func friendly(_ error: Error) -> String {
        if case let APIError.http(_, body) = error,
           let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String {
            return msg
        }
        return error.localizedDescription
    }
}
