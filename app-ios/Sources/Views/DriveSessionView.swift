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
        enum Role { case user, assistant, tool, thinking, error, system }
        let id = UUID()
        let role: Role
        var text: String
        // Tool-call fields (role == .tool). One chip per call: the result is paired back
        // into the *same* bubble by `toolUseId` instead of a second stacked bubble, so a
        // tool-heavy turn reads as a list of steps, not a wall of cards (§3.1a / matrix #16b).
        var toolUseId: String? = nil
        var toolResult: String? = nil   // full result text, shown behind a tap
        var toolError: Bool = false
        var toolPending: Bool = true     // no result yet → show a spinner dot
    }

    @State private var bubbles: [Bubble] = []
    @State private var status = "Connecting…"
    @State private var runState: AgentRunState = .idle   // canonical agent state (§1) — Source of truth for `busy`
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
    @State private var pendingAsk: AskRequest?       // the agent called the MCP ask picker; blocked on you
    @State private var askSubmitting = false         // answering the pending ask
    // Mid-turn control (Phase A): the server 400s a send while a turn is in flight, so the
    // queue is a *client* contract — hold follow-ups and drain one per turn on idle.
    @State private var queue: [String] = []          // follow-ups typed while the agent is busy
    @State private var flushing = false              // re-entrancy guard while a drain is in flight
    @State private var stopArmed = false             // Stop is a two-tap armed control (thumb-width from Send)
    @State private var stopDisarmTask: Task<Void, Never>?
    @State private var expandedTools: Set<UUID> = [] // tool chips the user tapped open
    @State private var pinnedToBottom = true         // auto-scroll only when the user is at the bottom (§3.1b)
    @State private var showJump = false              // "↑ new activity" pill when unpinned and content arrives
    @State private var scrollScheduled = false       // a throttled tail-scroll is already queued this frame
    @FocusState private var composerFocused: Bool    // bring up the keyboard after a starter chip pre-fills
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Environment(NavRouter.self) private var router  // push the brain onto the shared stack
    @State private var brain = BrainActivity.shared   // observe so a doc touch lights the pulse

    /// The one "is a turn in flight" predicate, mirroring the web `driveBusy()`. Everything
    /// mid-turn (queue vs send, Stop visibility, working row) keys off this.
    private var busy: Bool { runState.busy }

    private var token: String? { TokenStore.load() }
    private var client: APIClient { APIClient(token: token) }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            composer
        }
        .navigationTitle(project.name ?? project.slug)
        .navigationBarTitleDisplayMode(.inline)
        .appBackButton { dismiss() }
        // Give the nav bar a definite background so transcript text doesn't blur through it
        // as it scrolls past — the translucent default made the header feel like an unstable
        // floating overlay. A visible bar reads as a stable, anchored nav.
        .toolbarBackground(.visible, for: .navigationBar)
        // Status lives *inside* the nav bar as a thin subtitle line — no separate strip,
        // so the header stays a single compact iOS nav bar instead of a stacked block.
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(project.name ?? project.slug)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Circle().fill(connectionColor).frame(width: 5, height: 5)
                        Text(headerSubtitle)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            // Pop to the brain from the live chat — and pulse the button green while the
            // agent is actively touching brain docs this turn (B8 live link). Gated on
            // `busy` so the pulse clears on its own at turn end without a decay timer here.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.path.append(BrainRoute(project: project))
                } label: {
                    ZStack(alignment: .topTrailing) {
                        Image(systemName: "brain")
                            .font(.subheadline.weight(.semibold))
                        if busy && brain.isActive(slug: project.slug, now: Date()) {
                            Circle().fill(Color.green)
                                .frame(width: 7, height: 7)
                                .offset(x: 5, y: -3)
                        }
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .accessibilityLabel("Brain")
            }
        }
        .task { await connect() }
        .onDisappear { streamTask?.cancel(); stopDisarmTask?.cancel() }
        // A backgrounded URLSession SSE socket freezes (matrix #7): on return to the
        // foreground, tear down and reopen from the high-water seq so we don't sit on a
        // dead stream until re-entry. No-op if we never opened one.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, let id = sessionId, ready { openStream(id, after: lastSeq) }
        }
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
                    if let ask = pendingAsk { askCard(ask) }
                    if showWorkingRow { workingRow }
                    // Bottom sentinel doubles as the scroll-pin probe: in a LazyVStack it
                    // only renders while it's in (or near) the viewport, so its appear/
                    // disappear tells us whether the user is parked at the bottom (§3.1b).
                    Color.clear.frame(height: 1).id("bottom")
                        .onAppear { pinnedToBottom = true; showJump = false }
                        .onDisappear { pinnedToBottom = false }
                }
                .padding()
            }
            // Auto-scroll ONLY when the user is pinned to the bottom; otherwise hold their
            // position and surface a jump pill. This is the matrix #16a fix — a tool card no
            // longer yanks you back down while you're reading history.
            .onChange(of: bubbles.count) { _, _ in autoScroll(proxy) }
            // Streamed text grows one delta at a time — scrolling on *every* token thrashes
            // the ScrollView (the P-2 smoothness cost). Coalesce to ~one scroll per frame.
            .onChange(of: bubbles.last?.text) { _, _ in autoScrollThrottled(proxy) }
            .onChange(of: showWorkingRow) { _, on in if on { autoScroll(proxy) } }
            .onChange(of: pendingAsk?.id) { _, id in if id != nil { jump(proxy) } }
            .overlay(alignment: .bottom) {
                if showJump {
                    Button { jump(proxy) } label: {
                        Label("New activity", systemImage: "arrow.down")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(.thinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.3)))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.accentColor)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
    }

    /// Scroll to the foot only when the user is already there; otherwise raise the jump pill
    /// so new activity is announced without stealing their scroll position.
    private func autoScroll(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if pinnedToBottom {
            if animated { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
            else { proxy.scrollTo("bottom", anchor: .bottom) }
        } else {
            withAnimation { showJump = true }
        }
    }

    /// Throttled tail-follow for the streaming hot path: at most one scroll per ~50ms instead
    /// of one per token. When the user has scrolled away we don't move them — just raise the
    /// jump pill (cheap + idempotent, so it's fine to hit on every delta). This is the P-2
    /// smoothness half; the pin-gating (only scroll when parked at the bottom) is the §3.1b
    /// correctness half, already shipped.
    private func autoScrollThrottled(_ proxy: ScrollViewProxy) {
        guard pinnedToBottom else {
            if !showJump { withAnimation { showJump = true } }
            return
        }
        guard !scrollScheduled else { return }
        scrollScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 50_000_000)
            scrollScheduled = false
            if pinnedToBottom { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    /// Explicit jump to the foot (the pill / an ask landing) — always snaps and re-pins.
    private func jump(_ proxy: ScrollViewProxy) {
        withAnimation {
            proxy.scrollTo("bottom", anchor: .bottom)
            showJump = false
            pinnedToBottom = true
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
            newAgentHint
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 24)
    }

    /// A quiet "what happens after you send" footer so the new-agent screen reads as
    /// intentional rather than half-empty — without adding a heavy card. Three faint lines:
    /// where it runs, that nothing's running yet, and what sending does.
    private var newAgentHint: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.vertical, 4)
            hintRow("folder", "Runs in \(project.name ?? project.slug)")
            hintRow("moon.zzz", "No agent running yet")
            hintRow("paperplane", "Your message starts a fresh agent — you'll watch it work here.")
        }
        .padding(.top, 8)
    }

    private func hintRow(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(width: 16)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    /// Pre-fill the composer with a starter prompt (don't auto-send) — on mobile, users
    /// expect to tweak the prompt before launching an agent. Focuses the field so the
    /// keyboard comes up ready to edit/send.
    private func startWith(_ prompt: String) {
        draft = prompt
        composerFocused = true
    }

    @ViewBuilder
    private func bubbleView(_ b: Bubble) -> some View {
        switch b.role {
        case .user:
            // Native partial-copy (long-press → blue handles → adjust range → copy the span)
            // via the UITextView-backed shim, not SwiftUI `Text` selection (whole-element,
            // Copy-only). Prompts show verbatim, so render them plain.
            SelectableText(attributed: MarkdownNS.plain(
                b.text, font: .preferredFont(forTextStyle: .body), color: .label))
                .padding(10)
                .background(Color.accentColor.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 14))
        case .assistant:
            // P-1: while THIS bubble is the live streaming one, render plain Text. Parsing
            // Markdown inline in `body` re-parses the whole accumulated reply on every token
            // (O(n²) as it grows — the "streaming gets janky" cost). Swap to formatted
            // Markdown once, when the block settles (assistantOpen flips false).
            if assistantOpen && b.id == bubbles.last?.id {
                Text(b.text)
                    .font(.subheadline)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                MarkdownView(text: b.text)
                    .textSelection(.enabled)
            }
        case .tool:
            toolChip(b)
        case .system:
            // A neutral system line (turn stopped / ended) — centered, quiet, not an error.
            Text(b.text)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
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

    /// One tool call as a single compact chip ("Read app.js") with a status dot and the
    /// full output folded behind a tap — the `tool_result` is paired into this same bubble
    /// by `toolUseId` (see `ingest`), so a tool-heavy turn reads as a tidy list of steps
    /// instead of two stacked cards per call burying the agent's reasoning (§3.1a).
    @ViewBuilder
    private func toolChip(_ b: Bubble) -> some View {
        let expanded = expandedTools.contains(b.id)
        let hasResult = !(b.toolResult ?? "").isEmpty
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(b.text)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 6)
                // Status dot: pending (spinner), ok (green), or error (red).
                if b.toolPending {
                    ProgressView().controlSize(.mini)
                } else {
                    Circle().fill(b.toolError ? Color.red : Color.green).frame(width: 6, height: 6)
                }
                if hasResult {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if expanded, let r = b.toolResult, !r.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(r)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.top, 2)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onTapGesture {
            guard hasResult else { return }
            if expanded { expandedTools.remove(b.id) } else { expandedTools.insert(b.id) }
        }
    }

    /// Show a "Working…" row whenever the agent is busy but nothing is actively
    /// streaming into a bubble — i.e. the gap between sending a prompt and the first
    /// event, and the pauses between tool calls. Hidden while assistant text or a
    /// thinking trace is growing (that text is its own progress signal).
    private var showWorkingRow: Bool {
        (awaitingResponse || runState == .working || runState == .starting || status == "Thinking…")
            && !assistantOpen && !thinkingOpen && pendingAsk == nil
    }

    /// The inline picker for a pending `ask` — the in-app twin of the push selector. The
    /// agent's turn is parked until you answer (`/answer` → resolveAsk), so it sits at the
    /// foot of the transcript like a prompt waiting on you.
    @ViewBuilder
    private func askCard(_ ask: AskRequest) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Agent asks", systemImage: "questionmark.bubble.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.accentColor)
            AskView(questions: ask.questions, submitting: askSubmitting) { sels in
                Task { @MainActor in await answerAsk(ask, sels) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.accentColor.opacity(0.25)))
    }

    /// Submit the inline ask's selections. On success clear the card optimistically (the
    /// `ask_resolved` event also clears it); on failure surface the error and leave the
    /// card so the user can retry.
    private func answerAsk(_ ask: AskRequest, _ sels: [AskSelection]) async {
        askSubmitting = true
        defer { askSubmitting = false }
        do {
            _ = try await client.answer(sessionId: ask.sessionId, askId: ask.askId, selections: sels)
            pendingAsk = nil
        } catch {
            bubbles.append(Bubble(role: .error, text: friendly(error)))
        }
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
        VStack(spacing: 8) {
            if !queue.isEmpty { queuedChips }
            HStack(alignment: .bottom, spacing: 10) {
                // Stop sits a thumb-width from Send and killing an in-flight turn is
                // destructive, so it only appears while a turn runs and is two-tap armed.
                if busy { stopButton }
                // Custom soft field (not .roundedBorder) so we control the placeholder contrast
                // and the internal padding. Stays enabled while the agent works so you can
                // type-ahead — the message queues (busy-aware composer).
                ZStack(alignment: .topLeading) {
                    if draft.isEmpty {
                        Text(busy ? "Queue a follow-up…" : "Message the agent…")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 9)
                            .padding(.horizontal, 13)
                            .allowsHitTesting(false)
                    }
                    TextField("", text: $draft, axis: .vertical)
                        .textFieldStyle(.plain)
                        .font(.body)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .disabled(!ready)
                        .padding(.vertical, 9)
                        .padding(.horizontal, 13)
                }
                .background(Color.secondary.opacity(0.14), in: RoundedRectangle(cornerRadius: 18))
                sendButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// Relabels to "Queue" while the agent is busy so the button tells you what a tap does:
    /// land now (idle) vs. wait for the current turn to finish (busy) — matrix #4.
    @ViewBuilder
    private var sendButton: some View {
        let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if busy {
            Button { Task { @MainActor in await send() } } label: {
                Text("Queue")
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Color.accentColor.opacity(empty ? 0.10 : 0.20), in: Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .disabled(!ready || empty)
        } else {
            Button { Task { @MainActor in await send() } } label: {
                Image(systemName: sending ? "ellipsis.circle" : "arrow.up.circle.fill")
                    .font(.title2)
            }
            .padding(.bottom, 3)
            .disabled(sending || !ready || empty)
        }
    }

    /// Two-tap armed Stop: first tap arms (red "Tap to confirm", auto-disarms after ~4s);
    /// a confirming second tap kills the turn. Ported from the web `#dv-stop` pattern.
    @ViewBuilder
    private var stopButton: some View {
        Button { stopTapped() } label: {
            if stopArmed {
                Text("Tap to confirm")
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(Color.red.opacity(0.18), in: Capsule())
                    .foregroundStyle(.red)
            } else {
                Image(systemName: "stop.circle")
                    .font(.title2)
                    .foregroundStyle(.red)
            }
        }
        .buttonStyle(.plain)
        .padding(.bottom, 3)
    }

    /// The pending follow-up chips above the composer — each cancelable before it's
    /// delivered, mirroring the web `renderDriveQueue`.
    private var queuedChips: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Queued · sends when the turn finishes")
                .font(.caption2).foregroundStyle(.secondary)
            ForEach(Array(queue.enumerated()), id: \.offset) { item in
                HStack(spacing: 8) {
                    Image(systemName: "clock").font(.caption2).foregroundStyle(.tertiary)
                    Text(item.element).font(.caption).lineLimit(2)
                    Spacer(minLength: 6)
                    Button {
                        if queue.indices.contains(item.offset) { queue.remove(at: item.offset) }
                    } label: {
                        Image(systemName: "xmark.circle.fill").font(.caption).foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Networking

    private func connect() async {
        do {
            // 0. The + asked for a fresh agent — don't attach or adopt anything. Leave a
            //    blank composer; the first message starts a new session (steps 1–3 would
            //    otherwise drop us back into the agent already running here).
            if forceNew {
                status = "New agent — send a message to start one."
                runState = .idle
                ready = true
                return
            }
            // 1. The cockpit handed us a specific agent — attach straight to it.
            if let id = attachTo {
                sessionId = id
                applyStatus(initialStatus)
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
                runState = .idle
                let adopted = try await client.adopt(claudeSessionId: cid, projectSlug: project.slug)
                sessionId = adopted.id
                store(cid)
                applyStatus(adopted.status)
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
                applyStatus(s.status)
                openStream(s.id)
                ready = true
                return
            }
            // 3. Nothing live — adopt the last session we drove here (survives the
            //    redeploy that push-to-main triggers; transcript is still on disk).
            if let cid = stored() {
                status = "Resuming agent…"
                runState = .idle
                let adopted = try await client.adopt(claudeSessionId: cid, projectSlug: project.slug)
                sessionId = adopted.id
                applyStatus(adopted.status)
                openStream(adopted.id)
                ready = true
                return
            }
            status = "No agent running yet — send a message to start one."
            runState = .idle
        } catch {
            status = friendly(error)
            runState = .idle
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

    /// The nav-bar subtitle: a short agent state + the connection word ("Idle · Stream
    /// connected"). The verbose guidance sentences live in the transcript's empty state,
    /// not the tiny header, so they're collapsed to a token here.
    private var headerSubtitle: String {
        statusShort == connectionLabel ? statusShort : "\(statusShort) · \(connectionLabel)"
    }

    /// Collapse the long status sentences to a header-sized token.
    private var statusShort: String {
        switch status {
        case let s where s.hasPrefix("New agent"): return "New agent"
        case let s where s.hasPrefix("No agent"): return "No agent yet"
        case let s where s.hasPrefix("Stream error"): return "Stream error"
        case let s where s.hasPrefix("Connected, but"): return "No transcript"
        case let s where s.hasPrefix("This project needs"): return "Needs workspace"
        default: return status
        }
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
        // Busy → the server 400s a mid-turn send (the queue is a *client* contract). Hold
        // the message and drain it the moment the turn settles (flushQueue). Don't echo it
        // into the transcript yet; it sits in the queued chips above the composer.
        if busy {
            queue.append(text)
            draft = ""
            return
        }
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
                applyStatus(session.status)
                openStream(session.id)
            }
            runState = .working       // optimistic: a turn is now in flight (gates the queue)
            awaitingResponse = true   // sent; show "Working…" until the stream moves
        } catch {
            // Roll back the optimistic bubble — the send didn't take.
            rollbackOptimistic(text)
            // A fresh project has no checkout yet (`POST /sessions` 409s). Don't strand the
            // user — offer to clone the workspace, then re-send the queued prompt.
            if isWorkspaceNotSetup(error) {
                queuedPrompt = text
                status = "This project needs a workspace before an agent can run."
                runState = .idle
                showSetup = true
                return
            }
            bubbles.append(Bubble(role: .error, text: friendly(error)))
        }
    }

    /// Drain ONE queued follow-up once the turn settles to idle. Each delivery starts a new
    /// turn (→ busy), so the next idle drains the next, in order — the queue empties one
    /// message per turn. A re-entrancy guard plus the `busy` re-check stop a double-send if
    /// `turn_end` and a `status:idle` both fire. Re-queues on failure. (web `driveFlushQueue`.)
    private func flushQueue() async {
        guard !flushing, !busy, !queue.isEmpty, let id = sessionId else { return }
        flushing = true
        defer { flushing = false }
        let prompt = queue.removeFirst()
        bubbles.append(Bubble(role: .user, text: prompt))
        assistantOpen = false
        pendingEcho = prompt
        do {
            try await client.sendMessage(sessionId: id, prompt: prompt)
            runState = .working
            awaitingResponse = true
        } catch {
            rollbackOptimistic(prompt)
            queue.insert(prompt, at: 0)   // delivery failed → keep it queued, retry next idle
            bubbles.append(Bubble(role: .error, text: friendly(error)))
        }
    }

    /// Two-tap armed Stop. First tap arms (auto-disarms after ~4s so a forgotten arm can't
    /// linger); a confirming second tap SIGTERMs the turn via `/stop`. The session survives.
    private func stopTapped() {
        guard busy, let id = sessionId else { return }
        if !stopArmed {
            stopArmed = true
            stopDisarmTask?.cancel()
            stopDisarmTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if !Task.isCancelled { stopArmed = false }
            }
            return
        }
        disarmStop()
        Task { @MainActor in
            do { _ = try await client.stop(sessionId: id) }
            catch { bubbles.append(Bubble(role: .error, text: friendly(error))) }
        }
    }

    private func disarmStop() {
        stopDisarmTask?.cancel()
        stopDisarmTask = nil
        stopArmed = false
    }

    /// Set the header string and the canonical run state together from a raw server status,
    /// so `busy` and the displayed status never drift (§1).
    private func applyStatus(_ raw: String?) {
        status = humanStatus(raw)
        runState = .from(raw)
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
            // One chip per call; the result folds into THIS bubble (paired by id below),
            // so a tool-heavy turn reads as a list of steps, not stacked cards (§3.1a).
            if let n = obj["name"] as? String {
                let input = obj["input"] as? [String: Any]
                bubbles.append(Bubble(role: .tool, text: toolLabel(n, input),
                                      toolUseId: obj["id"] as? String))
                assistantOpen = false
                // Brain⇄chat live link (B8): if this call touches a brain doc, glow its
                // node (BrainView observes BrainActivity) and fire a haptic here. `touch`
                // self-filters to `.md`, so non-doc file ops are ignored. Gate on the
                // event's own timestamp so the backfill replay (every historical tool_use
                // re-arriving on a fresh open / reconnect) doesn't buzz and glow the whole
                // graph on entry — only genuinely live touches do. (`emit` stamps `t`.)
                if let f = (input?["file_path"] as? String) ?? (input?["path"] as? String) {
                    let t = (obj["t"] as? Double) ?? 0
                    let ageMs = Date().timeIntervalSince1970 * 1000 - t
                    if ageMs < 30_000 {
                        BrainActivity.shared.touch(slug: project.slug, file: f, verb: BrainActivity.verb(forTool: n))
                    }
                }
            }
        case "tool_result":
            // Fold the output back into its pending tool chip (matched by toolUseId), keeping
            // the full text behind a tap — no second bubble.
            let raw = (obj["text"] as? String) ?? ""
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            attachToolResult(toolUseId: obj["toolUseId"] as? String,
                             text: trimmed, isError: (obj["isError"] as? Bool) ?? false)
            assistantOpen = false
        case "block_stop":
            assistantOpen = false
        case "turn_end", "result", "stopped":
            // Turn over — drop the ephemeral thinking trace, leaving a clean transcript
            // of prompts, replies, and tool activity (matches the web Drive view).
            let kind = obj["kind"] as? String
            assistantOpen = false
            awaitingResponse = false
            if kind == "stopped" { bubbles.append(Bubble(role: .system, text: "Turn stopped")) }
            markPendingToolsDone()       // any chip still pending resolves quietly (no result coming)
            runState = .idle
            // No status event may follow a turn end; clear a lingering "Working…" so the
            // spinner row doesn't stick when the agent has actually gone idle.
            if ["Working…", "Thinking…", "Starting…"].contains(status) { status = "Idle" }
            disarmStop()
            clearThinking()
            Task { @MainActor in await flushQueue() }   // drain the next queued follow-up
        case "ask":
            // The agent called the MCP ask picker — render the inline selector. Decode the
            // full event (questions) from the raw frame; `sessionId` is our live session,
            // which is what `/answer` posts against.
            if let ev = try? JSONDecoder().decode(AskEvent.self, from: Data(data.utf8)), let sid = sessionId {
                pendingAsk = AskRequest(askId: ev.askId, sessionId: sid, projectSlug: project.slug, questions: ev.questions)
                status = "Waiting for you"
                runState = .waiting        // still an in-flight turn — keeps follow-ups queued
                awaitingResponse = false
                clearThinking()
            }
        case "ask_resolved":
            // Answered (by us, another client, or a timeout) — drop the picker.
            if let aid = obj["askId"] as? String, aid == pendingAsk?.askId { pendingAsk = nil }
            else if obj["askId"] == nil { pendingAsk = nil }
        case "status":
            if let s = obj["status"] as? String {
                applyStatus(s)
                awaitingResponse = false   // a real status now drives the working row
                if !busy { disarmStop(); Task { @MainActor in await flushQueue() } }
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

    /// A compact one-line label for a tool call ("Read app.js", "Bash: npm install"). The
    /// full input/output is reachable behind the chip's tap, so this stays terse.
    private func toolLabel(_ name: String, _ input: [String: Any]?) -> String {
        if let f = (input?["file_path"] as? String) ?? (input?["path"] as? String) {
            return "\(name) \((f as NSString).lastPathComponent)"
        }
        if let cmd = input?["command"] as? String { return "\(name): \(String(cmd.prefix(48)))" }
        if let pat = input?["pattern"] as? String { return "\(name) \(String(pat.prefix(48)))" }
        return name
    }

    /// Pair a `tool_result` into its pending tool chip: by `toolUseId` when present, else the
    /// most recent pending chip (older buffers replay results without ids). Folds the output
    /// into the same bubble instead of stacking a second card. An unmatched result with
    /// content shows as a standalone chip.
    private func attachToolResult(toolUseId: String?, text: String, isError: Bool) {
        var idx: Int? = nil
        if let tid = toolUseId {
            idx = bubbles.lastIndex { $0.role == .tool && $0.toolPending && $0.toolUseId == tid }
        }
        if idx == nil {
            idx = bubbles.lastIndex { $0.role == .tool && $0.toolPending }
        }
        if let i = idx {
            bubbles[i].toolResult = text
            bubbles[i].toolError = isError
            bubbles[i].toolPending = false
        } else if !text.isEmpty || isError {
            var b = Bubble(role: .tool, text: isError ? "tool error" : "tool result")
            b.toolResult = text
            b.toolError = isError
            b.toolPending = false
            bubbles.append(b)
        }
    }

    /// At a turn boundary, settle any chip still showing a spinner — no result is coming.
    private func markPendingToolsDone() {
        for i in bubbles.indices where bubbles[i].role == .tool && bubbles[i].toolPending {
            bubbles[i].toolPending = false
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
    private func friendly(_ error: Error) -> String { apiMessage(error) }
}
