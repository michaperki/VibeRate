import SwiftUI

/// A project's live Drive session: watch the agent work AND steer it. Streams the
/// transcript over authenticated SSE and posts follow-up prompts; if no agent is
/// running yet, the first message starts one in the project's bound workspace. This is
/// the core "drive from your phone" loop — the read-only viewer became interactive.
struct DriveSessionView: View {
    let project: Project
    /// The specific agent to attach to (a tap on a cockpit roster row). `nil` means a
    /// fresh agent — don't auto-attach; the first message starts a new session.
    var attachTo: String? = nil
    /// A durable past conversation to resume by its claude session id (a tap on a
    /// cockpit "Conversations" row). Adopted via `/sessions/adopt`, which replays the
    /// on-disk transcript — used when the session is no longer live in memory (e.g. after
    /// a redeploy). Ignored when `attachTo` or `forceNew` is set.
    var resumeCid: String? = nil
    /// The roster's last-known status for `attachTo`, so the bar reads right on entry.
    var initialStatus: String? = nil
    /// Force a brand-new agent: skip the live-session lookup *and* the adopt path so the
    /// **+** never re-attaches to the agent already running on this project. The first
    /// message then starts a second, concurrent session.
    var forceNew: Bool = false

    struct Bubble: Identifiable {
        enum Role { case user, assistant, tool, thinking, error }
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
    @State private var thinkingOpen = false          // last bubble is an in-progress thinking block
    @State private var pendingEcho: String?          // optimistic prompt awaiting its stream echo
    @State private var eventCount = 0                // diagnostics: events seen on this stream
    @State private var streamHTTP: Int?              // diagnostics: stream response status
    @State private var lastSeq = 0                   // highest event seq seen — resume point for reconnect
    @State private var historyLoaded = false         // a fresh open has backfilled the transcript
    @State private var awaitingResponse = false      // sent a prompt, nothing has streamed back yet
    @State private var showSetup = false             // a fresh project needs its workspace cloned first
    @State private var queuedPrompt: String?         // the prompt to re-send once the workspace is ready

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
            HStack(spacing: 8) {
                Text(status).font(.caption.weight(.medium)).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                // Plain-language stream state (dot + words) instead of the old cryptic
                // ⚡/↯/⚠ glyphs: "Connecting…", "Stream connected", "History loaded",
                // "Disconnected". The dot color carries the same at a glance.
                HStack(spacing: 4) {
                    Circle().fill(connectionColor).frame(width: 6, height: 6)
                    Text(connectionLabel).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.bar)
        }
        .task { await connect() }
        .onDisappear { streamTask?.cancel() }
        .sheet(isPresented: $showSetup) {
            WorkspaceSetupView(project: project, token: token) {
                // Workspace cloned + ready — re-send the prompt that 409'd, which now
                // starts the project's first agent.
                if let p = queuedPrompt {
                    queuedPrompt = nil
                    draft = p
                    Task { @MainActor in await send() }
                }
            }
        }
    }

    // MARK: - Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if bubbles.isEmpty {
                        if forceNew { newAgentEmptyState }
                        else { idleEmptyState }
                    }
                    ForEach(bubbles) { b in
                        bubbleView(b)
                            .frame(maxWidth: .infinity, alignment: b.role == .user ? .trailing : .leading)
                    }
                    if showWorkingRow { workingRow }
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
            .onChange(of: showWorkingRow) { _, on in
                if on { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            }
        }
    }

    // MARK: - Empty states

    /// Shown when attached/resumed but the transcript hasn't painted yet.
    private var idleEmptyState: some View {
        Text("Nothing here yet. Send a message to steer the agent.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 40)
    }

    /// Starter prompts for a brand-new agent — (chip label, prompt sent). Gives the blank
    /// state something to do and shows what "driving" looks like.
    private let starters: [(String, String)] = [
        ("Review the repo", "Review the repo and summarize how it's structured and what it does."),
        ("Continue the last plan", "Find the most recently worked PLAN_*.md and continue advancing it to completion."),
        ("Fix an iOS bug", "Audit the native iOS app (app-ios/) for a bug and fix it."),
        ("Summarize current state", "Summarize the current state of this project: what's shipped, what's in progress, and what's next."),
    ]

    /// The new-agent landing: project context + starter chips, so the screen reads as
    /// "a fresh agent you're about to start", not a blank conversation.
    private var newAgentEmptyState: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Label("New agent", systemImage: "sparkles")
                    .font(.headline)
                Text("Drive a fresh agent in \(project.name ?? project.slug). Type a message below, or start with one of these:")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
                ForEach(starters, id: \.0) { chip in
                    Button { startWith(chip.1) } label: {
                        Text(chip.0)
                            .font(.footnote.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .padding(.horizontal, 8)
                            .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(!ready || sending)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 24)
    }

    /// Fill the composer with a starter prompt and send it — starts the agent.
    private func startWith(_ prompt: String) {
        draft = prompt
        Task { @MainActor in await send() }
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
            MarkdownView(text: b.text)
                .textSelection(.enabled)
        case .tool:
            toolChip(b.text)
        case .thinking:
            // Claude's live extended thinking — the same line-by-line reasoning the
            // terminal shows, streamed as it happens. Rendered dimmed/italic to read as
            // meta, and cleared at the turn boundary (see clearThinking) so a finished
            // turn leaves a clean transcript — matching the web Drive view.
            HStack(alignment: .top, spacing: 6) {
                Text("✦").font(.footnote).foregroundStyle(.tertiary)
                Text(b.text)
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            .padding(.vertical, 2)
        case .error:
            Text(b.text)
                .font(.footnote)
                .foregroundStyle(.red)
        }
    }

    /// A tool call ("→ Read PLAN.md") or its result ("⤷ …output…") rendered as a compact
    /// chip — visible but quiet, so a tool-heavy turn reads as a list of steps rather than
    /// a wall of mono text that crowds out the agent's actual replies.
    @ViewBuilder
    private func toolChip(_ text: String) -> some View {
        let isResult = text.hasPrefix("⤷")
        let body = text.hasPrefix("→ ") ? String(text.dropFirst(2))
                 : text.hasPrefix("⤷ ") ? String(text.dropFirst(2))
                 : text
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: isResult ? "arrow.turn.down.right" : "wrench.and.screwdriver")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(body)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(isResult ? 3 : 2)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
    }

    /// Show a "Working…" row whenever the agent is busy but nothing is actively
    /// streaming into a bubble — i.e. the gap between sending a prompt and the first
    /// event, and the pauses between tool calls. Hidden while assistant text or a
    /// thinking trace is growing (that text is its own progress signal).
    private var showWorkingRow: Bool {
        (awaitingResponse || status == "Working…" || status == "Thinking…")
            && !assistantOpen && !thinkingOpen
    }

    private var workingRow: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(status == "Thinking…" ? "Thinking…" : "Working…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
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
            // 0. The + asked for a fresh agent — don't attach or adopt anything. Leave a
            //    blank composer; the first message starts a new session (steps 1–3 would
            //    otherwise drop us back into the agent already running here).
            if forceNew {
                status = "New agent — send a message to start one."
                ready = true
                return
            }
            // 1. The cockpit handed us a specific agent — attach straight to it.
            if let id = attachTo {
                sessionId = id
                status = humanStatus(initialStatus)
                openStream(id)
                ready = true
                // Best-effort: learn this session's durable id so we can adopt it later
                // if a redeploy wipes the live record (don't block the composer on it).
                if let s = try? await client.session(id: id), let cid = s.claudeSessionId { store(cid) }
                return
            }
            // 1b. A "Conversations" row handed us a specific past session to resume —
            //     adopt exactly that claude id (replays its on-disk transcript). This is
            //     the deliberate-resume path, distinct from the step-3 best-effort adopt.
            if let cid = resumeCid {
                status = "Resuming agent…"
                let adopted = try await client.adopt(claudeSessionId: cid, projectSlug: project.slug)
                sessionId = adopted.id
                store(cid)
                status = humanStatus(adopted.status)
                openStream(adopted.id)
                ready = true
                return
            }
            // 2. No target — find a live session for this project. Prefer one that's
            //    actually running/waiting over a stale idle record (the wrong-session
            //    case that streams an empty buffer).
            let mine = try await client.agentSessions().filter { $0.projectSlug == project.slug }
            if let s = mine.first(where: { isLive($0.status) }) ?? mine.first {
                sessionId = s.id
                if let cid = s.claudeSessionId { store(cid) }
                status = humanStatus(s.status)
                openStream(s.id)
                ready = true
                return
            }
            // 3. Nothing live — adopt the last session we drove here (survives the
            //    redeploy that push-to-main triggers; transcript is still on disk).
            if let cid = stored() {
                status = "Resuming agent…"
                let adopted = try await client.adopt(claudeSessionId: cid, projectSlug: project.slug)
                sessionId = adopted.id
                status = humanStatus(adopted.status)
                openStream(adopted.id)
                ready = true
                return
            }
            status = "No agent running yet — send a message to start one."
        } catch {
            status = friendly(error)
        }
        ready = true
    }

    private func isLive(_ s: String?) -> Bool {
        ["working", "running", "starting", "waiting", "waiting_for_input", "blocked"].contains(s ?? "")
    }

    // A durable per-project handle so a conversation survives an app relaunch or a
    // server redeploy: we adopt by claudeSessionId when no live session is found.
    private func storeKey() -> String { "drive.cid.\(project.slug)" }
    private func stored() -> String? { UserDefaults.standard.string(forKey: storeKey()) }
    private func store(_ cid: String) { UserDefaults.standard.set(cid, forKey: storeKey()) }

    /// Plain-language stream state for the header. "Connecting…" before the socket opens,
    /// "Connected" once it's open but quiet, "Stream connected" while events flow live,
    /// "History loaded" once a fresh open has backfilled the transcript, "Disconnected" on
    /// a rejected stream.
    private var connectionLabel: String {
        if let code = streamHTTP, !(200..<300).contains(code) { return "Disconnected" }
        if eventCount == 0 { return streamHTTP == nil ? "Connecting…" : "Connected" }
        if assistantOpen || thinkingOpen || awaitingResponse { return "Stream connected" }
        return historyLoaded ? "History loaded" : "Stream connected"
    }

    private var connectionColor: Color {
        if let code = streamHTTP, !(200..<300).contains(code) { return .red }
        if eventCount == 0 && streamHTTP == nil { return .orange }
        return .green
    }

    /// Open the live SSE stream. `after` is the seq to resume past: 0 on a fresh open
    /// (the server replays the whole buffered transcript so the convo re-paints its
    /// history), or `lastSeq` on a reconnect (it backfills only the gap, no dupes).
    private func openStream(_ id: String, after: Int = 0) {
        streamTask?.cancel()
        if after == 0 { eventCount = 0; lastSeq = 0 }
        streamHTTP = nil
        let url = APIConfig.url("/api/agent/sessions/\(id)/stream?after=\(after)")
        let sse = SSEClient(url: url, token: token)
        sse.onOpen = { code in Task { @MainActor in streamHTTP = code } }
        streamTask = Task { @MainActor in
            do {
                for try await event in sse.events() {
                    eventCount += 1
                    if after == 0 { historyLoaded = true }   // a fresh open backfilled history
                    if let idStr = event.id, let n = Int(idStr) { lastSeq = n }
                    ingest(event.data)
                }
                // Stream closed by the server (idle drop / deploy cycle). Zero events on a
                // *fresh* open means an empty buffer; otherwise reconnect to keep updates
                // flowing — the native client has no auto-reconnect, so without this live
                // events stop after the first backfill and only reappear on re-entry.
                if eventCount == 0 && after == 0 { status = "Connected, but no transcript came back." }
                await reconnect(id)
            } catch is CancellationError {
                // we re-opened the stream or left the view — not an error to surface
            } catch {
                status = "Stream error: \(friendly(error))"
                await reconnect(id)
            }
        }
    }

    /// Re-open a dropped stream, resuming from `lastSeq`. This is what the browser's
    /// `EventSource` does for free; URLSession doesn't, so a healthy stream that the
    /// server closes (idle/deploy) would otherwise go silent until the user re-enters.
    /// Skips a rejected stream (auth/routing) so a 4xx doesn't hot-loop.
    private func reconnect(_ id: String) async {
        if Task.isCancelled { return }
        if let code = streamHTTP, !(200..<300).contains(code) { return }
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        if Task.isCancelled { return }
        openStream(id, after: lastSeq)
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
                if let cid = session.claudeSessionId { store(cid) }
                status = humanStatus(session.status)
                openStream(session.id)
            }
            awaitingResponse = true   // sent; show "Working…" until the stream moves
        } catch {
            // Roll back the optimistic bubble — the send didn't take.
            rollbackOptimistic(text)
            // A fresh project has no checkout yet (`POST /sessions` 409s). Don't strand the
            // user — offer to clone the workspace, then re-send the queued prompt.
            if isWorkspaceNotSetup(error) {
                queuedPrompt = text
                status = "This project needs a workspace before an agent can run."
                showSetup = true
                return
            }
            bubbles.append(Bubble(role: .error, text: friendly(error)))
        }
    }

    /// Remove the optimistic user bubble when a send fails before it took.
    private func rollbackOptimistic(_ text: String) {
        if pendingEcho == text, bubbles.last?.role == .user, bubbles.last?.text == text {
            bubbles.removeLast()
        }
        pendingEcho = nil
    }

    /// The server 409s `… workspace is not set up yet …` when a project has no checkout.
    private func isWorkspaceNotSetup(_ error: Error) -> Bool {
        if case let APIError.http(code, body) = error {
            return code == 409 && body.contains("not set up")
        }
        return false
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
                clearThinking()
            }
        case "thinking_start":
            bubbles.append(Bubble(role: .thinking, text: ""))
            thinkingOpen = true
            status = "Thinking…"
        case "thinking_delta":
            if let t = obj["text"] as? String { appendThinking(t) }
        case "thinking":
            if let t = obj["text"] as? String, !t.isEmpty {
                bubbles.append(Bubble(role: .thinking, text: t))
                thinkingOpen = false
            }
        case "assistant_text_start":
            bubbles.append(Bubble(role: .assistant, text: ""))
            assistantOpen = true
            thinkingOpen = false
        case "assistant_text_delta":
            if let t = obj["text"] as? String { appendAssistant(t) }
        case "assistant_text":
            if let t = obj["text"] as? String {
                bubbles.append(Bubble(role: .assistant, text: t))
                assistantOpen = false
            }
        case "tool_use":
            if let n = obj["name"] as? String {
                let input = obj["input"] as? [String: Any]
                let file = (input?["file_path"] as? String) ?? (input?["path"] as? String)
                let suffix = file.map { " " + ($0 as NSString).lastPathComponent } ?? ""
                bubbles.append(Bubble(role: .tool, text: "→ \(n)\(suffix)"))
                assistantOpen = false
            }
        case "tool_result":
            // Show a short slice of tool output so a tool-heavy turn visibly progresses
            // instead of looking frozen between assistant replies.
            if let t = obj["text"] as? String {
                let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    bubbles.append(Bubble(role: .tool, text: "⤷ " + String(trimmed.prefix(240))))
                    assistantOpen = false
                }
            }
        case "block_stop":
            assistantOpen = false
        case "turn_end", "result", "stopped":
            // Turn over — drop the ephemeral thinking trace, leaving a clean transcript
            // of prompts, replies, and tool activity (matches the web Drive view).
            assistantOpen = false
            awaitingResponse = false
            // No status event may follow a turn end; clear a lingering "Working…" so the
            // spinner row doesn't stick when the agent has actually gone idle.
            if status == "Working…" || status == "Thinking…" { status = "Idle" }
            clearThinking()
        case "status":
            if let s = obj["status"] as? String {
                status = humanStatus(s)
                awaitingResponse = false   // a real status now drives the working row
            }
        case "error":
            awaitingResponse = false
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

    /// Coalesce streamed `thinking_delta`s into one growing thinking bubble, the same way
    /// `appendAssistant` does for reply text.
    private func appendThinking(_ delta: String) {
        if thinkingOpen, var last = bubbles.last, last.role == .thinking {
            last.text += delta
            bubbles[bubbles.count - 1] = last
        } else {
            bubbles.append(Bubble(role: .thinking, text: delta))
            thinkingOpen = true
        }
    }

    /// Remove the ephemeral thinking trace at a turn boundary so it streams live but
    /// doesn't pile up in the transcript.
    private func clearThinking() {
        bubbles.removeAll { $0.role == .thinking }
        thinkingOpen = false
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
    private func friendly(_ error: Error) -> String { apiMessage(error) }
}
