import SwiftUI
import Combine

/// The project **cockpit** — the calm home that shows what your agents are doing *right
/// now*. This is the "Now" zone of PLAN_COCKPIT.md, on the phone: one live row per Drive
/// agent (status, current action, plan, elapsed, context fill), fed by the aggregate
/// roster SSE. It sits between the projects list and Drive — tap a row to jump into that
/// specific agent's Drive, or ✦ to start a fresh one. (The "Latest" / "Next" zones are
/// the next slice; this ships the heart first.)
struct CockpitView: View {
    let project: Project
    @Environment(AuthModel.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @Environment(NavRouter.self) private var router

    @State private var store: RosterStore?
    @State private var past: [WorkspaceSession] = []
    @State private var tick = Date()
    /// False until the first roster paint completes, so the loading state actually shows
    /// (the store is created synchronously, so without this it'd flash straight to "empty").
    @State private var didLoad = false

    private var token: String? { TokenStore.load() }
    private var client: APIClient { APIClient(token: token) }

    /// Past conversations not represented by a row already in the live "Now" roster —
    /// the ones a redeploy left offline, plus any never-live history. Resuming one adopts
    /// it; a still-live one routes straight to its running agent.
    private var offlineConversations: [WorkspaceSession] {
        let liveIds = Set(store?.agents.map(\.id) ?? [])
        return past.filter { s in
            if let lid = s.liveId { return !liveIds.contains(lid) }
            return true
        }
    }

    var body: some View {
        List {
            if let store, didLoad {
                // A transient stream drop *while we already have rows* is a thin inline
                // banner, not the full error state — the roster stays readable underneath.
                if let err = store.error, !store.agents.isEmpty {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .listRowInsets(rowInsets)
                        .listRowSeparator(.hidden)
                }

                if store.agents.isEmpty && offlineConversations.isEmpty {
                    // Nothing to show: distinguish a load *failure* (offer retry) from a
                    // genuinely empty project (offer to start the first agent).
                    if store.error != nil { errorState(store.error!) } else { emptyState }
                } else {
                    if store.agents.isEmpty { noAgentsRow } else { agentsSection(store) }
                    conversationsSection
                }
            } else {
                loadingState
            }
        }
        // Plain rows on the page background (matching the Projects list) instead of one big
        // rounded "card inside page" — the grouped style read as a heavy floating container.
        .listStyle(.plain)
        // A clear gap between the "Agents" (Now) and "Conversations" zones so they read as
        // two sections, not one run of rows.
        .listSectionSpacing(28)
        .navigationTitle(project.name ?? project.slug)
        .navigationBarTitleDisplayMode(.inline)
        .appBackButton { dismiss() }
        .toolbar {
            // Open the project's brain — the doc network the agent steers through. The
            // cockpit shows what the agent is *doing*; the brain shows what it's steering
            // *through* (PLAN_NATIVE_BRAIN.md). Quiet accent icon, left of "New agent".
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.path.append(BrainRoute(project: project))
                } label: {
                    Image(systemName: "brain")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
                .accessibilityLabel("Brain")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    router.path.append(DriveRoute(project: project, forceNew: true))
                } label: {
                    // A quiet accent text+icon button (plain style → no iOS 26 glass capsule)
                    // so "start a new agent" reads as a normal nav action, not a heavy circle.
                    Label("New agent", systemImage: "plus")
                        .labelStyle(.titleAndIcon)
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
        }
        // The DriveRoute destination is registered once at the stack root (ProjectsView) so
        // a push deep-link can push Cockpit + Drive together; here we just append to it.
        .refreshable {
            if let store { await store.refresh(client: client) }
            await loadPast()
        }
        .task {
            let s = store ?? RosterStore(project: project.slug, token: token)
            store = s
            await s.refresh(client: client)   // instant paint from the list endpoint…
            didLoad = true                    // first paint done — leave the loading state.
            s.start()                         // …then go live on the stream.
            await loadPast()                  // durable past conversations (survive redeploy)
        }
        .onDisappear { store?.stop() }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { tick = $0 }
    }

    // MARK: - Agents (the live "Now" roster)

    /// Shared row insets so every row — agent, conversation, banner — lines up with the
    /// screen margins, and crucially *stays* aligned when a row is swiped open (the default
    /// insets shift the content under the revealed action). 16pt matches the nav title.
    private var rowInsets: EdgeInsets { EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16) }

    @ViewBuilder
    private func agentsSection(_ store: RosterStore) -> some View {
        Section {
            ForEach(store.agents) { agent in
                Button {
                    router.path.append(DriveRoute(project: project, sessionId: agent.id, agentType: agent.type, status: agent.status))
                } label: {
                    AgentRow(agent: agent, now: tick)
                }
                .buttonStyle(.plain)
                .listRowInsets(rowInsets)
                // Swipe to end an agent — there's no terminal ctrl-c on a phone,
                // so without this idle agents accrue on the roster (matrix #18).
                // Non-destructive: the transcript survives and stays resumable.
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await endAgent(agent.id, agentType: agent.type) }
                    } label: {
                        // Just the glyph — the destructive red already says "end", and a
                        // bare ✕ reads as native (Mail/Messages) instead of a squeezed
                        // "End" word. VoiceOver still gets the verb.
                        Image(systemName: "xmark")
                    }
                    .tint(.red)
                    .accessibilityLabel("End agent")
                }
            }
        } header: {
            // The noun is the label ("Agents" / "2 agents"); the status mix
            // ("1 working · 1 idle") is detail in the footer, not the heading.
            Text(agentCountLabel(store.agents))
        } footer: {
            // Lead with what an agent IS — "running now" — so it reads in deliberate
            // contrast to the "Conversations" (paused, past) section below it. The
            // two-section split looked arbitrary without this (UI review 2026-06-26).
            Text(agentsFooter(store.agents)).font(.caption2)
        }
    }

    // MARK: - Conversations (durable past sessions)

    /// Past conversations to resume, separate from "Now". This is what makes a fresh
    /// agent unmistakable: tapping + starts a NEW one; resuming an old one is a deliberate
    /// tap here — not a silent auto-adopt. It also survives a redeploy (which empties the
    /// live roster), so the project never looks empty when it has history.
    @ViewBuilder
    private var conversationsSection: some View {
        Section {
            if offlineConversations.isEmpty {
                Text("No past conversations yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowInsets(rowInsets)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(offlineConversations) { s in
                    Button {
                        if let lid = s.liveId {
                            router.path.append(DriveRoute(project: project, sessionId: lid, status: s.status))
                        } else {
                            router.path.append(DriveRoute(project: project, resumeCid: s.claudeSessionId, status: "idle"))
                        }
                    } label: {
                        ConversationRow(session: s, now: tick)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(rowInsets)
                }
            }
        } header: {
            Text("Conversations")
        } footer: {
            if !offlineConversations.isEmpty {
                // "Paused, from before" is the distinction from the live "Agents" above —
                // both are tappable, so the UI has to say which is running (UI review 2026-06-26).
                Text("Paused sessions from before. Tap to resume one, or + above to start a new agent.")
                    .font(.caption2)
            }
        }
    }

    private func loadPast() async {
        if let s = try? await client.workspaceSessions(slug: project.slug) { past = s }
    }

    /// End a live agent (swipe): drop it from the roster immediately, then tell the server.
    /// The transcript stays on disk and re-adoptable from the Conversations section.
    private func endAgent(_ id: String, agentType: String?) async {
        store?.removeLocally(id: id)
        try? await client.endSession(id: id, agentType: agentType)
        await loadPast()   // it may reappear as a resumable past conversation
    }

    // MARK: - Whole-screen states (loading / empty / error)

    /// Project still loading — before the first roster paint. Centered so it doesn't read
    /// as a stray row.
    private var loadingState: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("Loading project…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 60)
        .listRowSeparator(.hidden)
    }

    /// Both the live roster and the past list are empty *and there's no error* — a genuinely
    /// empty project. Invite the first agent.
    private var emptyState: some View {
        stateCard(
            icon: "wind",
            title: "No agents running.",
            message: "Start one to drive this project from your phone."
        ) {
            Button {
                router.path.append(DriveRoute(project: project, forceNew: true))
            } label: {
                Label("New agent", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    /// Roster + past list both failed to load — show the error and a retry, rather than a
    /// bare red string with no way forward.
    private func errorState(_ message: String) -> some View {
        stateCard(
            icon: "exclamationmark.triangle",
            iconColor: .orange,
            title: "Couldn't load this project.",
            message: message
        ) {
            Button {
                Task { await retry() }
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
        }
    }

    /// Compact agents empty state used when there *are* past conversations below — a slim
    /// inline note rather than the full-screen card, so the conversations still lead.
    private var noAgentsRow: some View {
        Section {
            HStack(spacing: 10) {
                Image(systemName: "wind").foregroundStyle(.secondary)
                Text("No agents running right now.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button("New") {
                    router.path.append(DriveRoute(project: project, forceNew: true))
                }
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
            .listRowInsets(rowInsets)
            .listRowSeparator(.hidden)
        } header: {
            Text("Agents")
        }
    }

    /// Shared layout for the full-screen loading/empty/error cards — one icon, a title, a
    /// muted message, and an action — so they read as a family.
    private func stateCard<Action: View>(
        icon: String,
        iconColor: Color = .secondary,
        title: String,
        message: String,
        @ViewBuilder action: () -> Action
    ) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.largeTitle)
                .foregroundStyle(iconColor)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            action().padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .padding(.horizontal, 24)
        .listRowSeparator(.hidden)
    }

    /// Retry a failed load (error-state button): clear the error, repaint from the list
    /// endpoint, and make sure the live stream is running.
    private func retry() async {
        guard let store else { return }
        await store.refresh(client: client)
        store.start()
        await loadPast()
    }

    /// "Agent" / "2 agents" — the section's noun label (replaces the bare "2 idle").
    private func agentCountLabel(_ agents: [RosterAgent]) -> String {
        agents.count == 1 ? "Agent" : "\(agents.count) agents"
    }

    /// The status breakdown ("1 working · 1 idle") plus the distinction-teaching hint, as
    /// footer detail. "Running now" is the contrast that explains why these are *agents*
    /// and the section below is *conversations* (paused, resumable).
    private func agentsFooter(_ agents: [RosterAgent]) -> String {
        func count(_ pred: (String?) -> Bool) -> Int { agents.filter { pred($0.status) }.count }
        let working = count { ["working", "running", "starting"].contains($0 ?? "") }
        let waiting = count { ["waiting", "waiting_for_input", "blocked"].contains($0 ?? "") }
        let idle = agents.count - working - waiting
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if waiting > 0 { parts.append("\(waiting) needs input") }
        if idle > 0 { parts.append("\(idle) idle") }
        let mix = parts.joined(separator: " · ")
        let lead = "Running now — tap to drive."
        return mix.isEmpty ? lead : "\(mix) · \(lead)"
    }
}

/// One agent on the roster: status dot + current action, plan chip, ticking elapsed
/// timer, and a context-fill meter.
private struct AgentRow: View {
    let agent: RosterAgent
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Line 1 — title first. The dot + title own the flexible width and truncate
            // tail-first; the elapsed timer is fixed and never compresses the title (and
            // there's no meter on this line, so the title can't be pushed off-screen).
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text(primaryLine)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                if let elapsed {
                    Text(elapsed)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
            }
            // Line 2 — secondary. Status word + (truncating) plan chip on the left; the
            // context meter holds its intrinsic width on the right (`fixedSize`), so a
            // long plan name truncates instead of clipping the meter's "%".
            HStack(spacing: 8) {
                // Explicit status word — not just the colored dot — so "what state is
                // this agent in" never has to be inferred.
                StatusPill(text: statusLabel, color: statusColor)
                    .fixedSize()
                if let plan = agent.plan {
                    Label(plan, systemImage: "diamond.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if let pct = agent.ctxPct, pct > 0 {
                    CtxMeter(label: "Context", pct: pct).fixedSize()
                }
            }
        }
        .contentShape(Rectangle())
    }

    /// The agent's current action ("edit agent.js"), else its title, else a neutral line
    /// (the status itself is carried by the pill below, so we don't repeat it here).
    private var primaryLine: String {
        if let a = agent.lastAction, let label = a.label, !label.isEmpty {
            let verb = (a.verb ?? "").isEmpty ? "" : "\(a.verb!) "
            return "\(verb)\(label)"
        }
        if let title = agent.title, !title.isEmpty { return title }
        return "No recent activity"
    }

    /// The status as a short label for the pill: "Working" / "Needs input" / "Error" / "Idle".
    /// One canonical mapping (`AgentRunState`, §1) shared with Drive and the roster sort.
    private var statusLabel: String { AgentRunState.from(agent.status).pill }

    private var statusColor: Color { AgentRunState.from(agent.status).color }

    /// Elapsed on the current turn — only while actively working (idle agents have no
    /// running turn to time). `promptStartedAt` is ms-epoch.
    private var elapsed: String? {
        let state = AgentRunState.from(agent.status)
        guard let start = agent.promptStartedAt,
              state == .working || state == .starting else { return nil }
        let secs = max(0, Int(now.timeIntervalSince1970 - start / 1000))
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m" }
        return "\(secs / 3600)h \((secs % 3600) / 60)m"
    }
}

/// One past conversation: title-first, with a single quiet metadata line (state ·
/// message count · last-active) that disambiguates same-prefix truncated titles. Kept
/// deliberately lighter than a live agent row (no status pill, meters, or icons) so the
/// "Now" and "Conversations" sections read differently at a glance.
private struct ConversationRow: View {
    let session: WorkspaceSession
    let now: Date

    private var isLive: Bool { session.liveId != nil }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                // Title is primary (medium weight) and owns the flexible width; everything
                // else collapses to one quiet metadata line ("Resumable · 3 messages · 55m
                // ago") so the row scans cleanly and truncates tail-first.
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                metadataText
                    .font(.caption2)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            // Aligned, fixed chevron — a quiet "tap to open" affordance that never compresses.
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .fixedSize()
        }
        .contentShape(Rectangle())
    }

    private var title: String {
        if let t = session.title, !t.isEmpty { return t }
        return "Untitled conversation"
    }

    /// One muted metadata line, with only the *status word* tinted by state (green/orange
    /// for a live convo; secondary for a resumable one) and the rest — message count,
    /// last-active — kept quietly muted. Disambiguates same-prefix truncated titles without
    /// an icon per field.
    private var metadataText: Text {
        let status = Text(statusLabel).foregroundColor(statusColor)
        let detail = detailParts.joined(separator: " · ")
        guard !detail.isEmpty else { return status }
        return status + Text(" · " + detail).foregroundColor(.secondary)
    }

    /// The non-status metadata fields (message count, last-active), kept muted.
    private var detailParts: [String] {
        var parts: [String] = []
        if let t = session.userTurns, t > 0 { parts.append("\(t) message\(t == 1 ? "" : "s")") }
        if let rel = relative { parts.append(rel) }
        return parts
    }

    /// A live convo shows its running state; an offline one is explicitly "Resumable".
    private var statusLabel: String {
        guard isLive else { return "Resumable" }
        switch session.status {
        case "waiting", "waiting_for_input", "blocked": return "Needs input"
        case "working", "running", "starting": return "Working"
        default: return "Running"
        }
    }

    private var statusColor: Color {
        guard isLive else { return .secondary }
        switch session.status {
        case "waiting", "waiting_for_input", "blocked": return .orange
        default: return .green
        }
    }

    /// "5m ago" from the ms-epoch `lastAt`. Ticks off the cockpit's shared `now`.
    private var relative: String? {
        guard let ms = session.lastAt else { return nil }
        let secs = max(0, Int(now.timeIntervalSince1970 - ms / 1000))
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(secs / 60)m ago" }
        if secs < 86400 { return "\(secs / 3600)h ago" }
        return "\(secs / 86400)d ago"
    }
}

/// A small status word in a tinted capsule — gives every agent row an explicit state
/// label, not just a colored dot.
private struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.16), in: Capsule())
            .foregroundStyle(color)
    }
}

/// A labeled context-window fill bar (green → orange → red as the window fills). The
/// label is required — a bare "100%" is meaningless, "Context 100%" is not. And in the
/// red zone the meter says "full", so the alarm-color and the number agree on meaning: a
/// full window is *bad* (the agent's about to compact), not "almost done" (UI review
/// 2026-06-26 — "the number and the alarm-color point in opposite directions").
private struct CtxMeter: View {
    var label: String = "Context"
    let pct: Int
    private let width: CGFloat = 40

    var body: some View {
        HStack(spacing: 5) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2)).frame(width: width, height: 5)
                Capsule().fill(color).frame(width: width * CGFloat(min(pct, 100)) / 100, height: 5)
            }
            Text(readout)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(pct >= 85 ? color : .secondary)
        }
    }

    /// In the danger zone, pair the % with "full" so it can't read as "almost done".
    private var readout: String { pct >= 85 ? "\(pct)% full" : "\(pct)%" }

    private var color: Color { pct >= 85 ? .red : pct >= 60 ? .orange : .green }
}
