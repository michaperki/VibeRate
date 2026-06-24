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

    @State private var store: RosterStore?
    @State private var driveTarget: DriveTarget?
    @State private var past: [WorkspaceSession] = []
    @State private var tick = Date()

    private var token: String? { TokenStore.load() }
    private var client: APIClient { APIClient(token: token) }

    /// Where a tap goes. All-nil = start a fresh agent (the ✦ button). `sessionId` = a
    /// live in-memory agent (a Now-roster row). `resumeCid` = a durable past conversation
    /// to adopt (a Conversations row).
    struct DriveTarget: Hashable, Identifiable {
        var sessionId: String? = nil
        var resumeCid: String? = nil
        var status: String? = nil
        var id: String { sessionId ?? resumeCid ?? "new" }
        var isNew: Bool { sessionId == nil && resumeCid == nil }
    }

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
            if let store {
                if let err = store.error {
                    Text(err).font(.footnote).foregroundStyle(.red)
                }
                if store.agents.isEmpty {
                    emptyState
                } else {
                    Section {
                        ForEach(store.agents) { agent in
                            Button {
                                driveTarget = DriveTarget(sessionId: agent.id, status: agent.status)
                            } label: {
                                AgentRow(agent: agent, now: tick)
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        // The noun is the label ("Agents" / "2 agents"); the status mix
                        // ("1 working · 1 idle") is detail in the footer, not the heading.
                        Text(agentCountLabel(store.agents))
                    } footer: {
                        Text(agentsFooter(store.agents)).font(.caption2)
                    }
                }
                conversationsSection
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(project.name ?? project.slug)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    driveTarget = DriveTarget()   // all-nil → forceNew
                } label: {
                    // Title + a thin plus (not a heavy filled circle) so the action is
                    // unmistakably "start a new agent" without dominating the bar.
                    Label("New agent", systemImage: "plus")
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .navigationDestination(item: $driveTarget) { t in
            DriveSessionView(project: project, attachTo: t.sessionId, resumeCid: t.resumeCid,
                             initialStatus: t.status, forceNew: t.isNew)
        }
        .refreshable {
            if let store { await store.refresh(client: client) }
            await loadPast()
        }
        .task {
            let s = store ?? RosterStore(project: project.slug, token: token)
            store = s
            await s.refresh(client: client)   // instant paint from the list endpoint…
            s.start()                         // …then go live on the stream.
            await loadPast()                  // durable past conversations (survive redeploy)
        }
        .onDisappear { store?.stop() }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { tick = $0 }
    }

    // MARK: - Conversations (durable past sessions)

    /// Past conversations to resume, separate from "Now". This is what makes a fresh
    /// agent unmistakable: tapping + starts a NEW one; resuming an old one is a deliberate
    /// tap here — not a silent auto-adopt. It also survives a redeploy (which empties the
    /// live roster), so the project never looks empty when it has history.
    @ViewBuilder
    private var conversationsSection: some View {
        if !offlineConversations.isEmpty {
            Section {
                ForEach(offlineConversations) { s in
                    Button {
                        if let lid = s.liveId {
                            driveTarget = DriveTarget(sessionId: lid, status: s.status)
                        } else {
                            driveTarget = DriveTarget(resumeCid: s.claudeSessionId, status: "idle")
                        }
                    } label: {
                        ConversationRow(session: s, now: tick)
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("Conversations")
            } footer: {
                Text("Tap to resume a past conversation, or + above to start a new agent.").font(.caption2)
            }
        }
    }

    private func loadPast() async {
        if let s = try? await client.workspaceSessions(slug: project.slug) { past = s }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "wind")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No agents running.")
                .font(.headline)
            Text("Start one to drive this project from your phone.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                driveTarget = DriveTarget()   // all-nil → forceNew
            } label: {
                Label("New agent", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowSeparator(.hidden)
    }

    /// "Agent" / "2 agents" — the section's noun label (replaces the bare "2 idle").
    private func agentCountLabel(_ agents: [RosterAgent]) -> String {
        agents.count == 1 ? "Agent" : "\(agents.count) agents"
    }

    /// The status breakdown ("1 working · 1 idle") plus the tap hint, as footer detail.
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
        return mix.isEmpty ? "Tap an agent to drive it." : "\(mix) · Tap an agent to drive it."
    }
}

/// One agent on the roster: status dot + current action, plan chip, ticking elapsed
/// timer, and a context-fill meter.
private struct AgentRow: View {
    let agent: RosterAgent
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text(primaryLine)
                    .font(.subheadline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let elapsed { Text(elapsed).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            HStack(spacing: 8) {
                // Explicit status word — not just the colored dot — so "what state is
                // this agent in" never has to be inferred.
                StatusPill(text: statusLabel, color: statusColor)
                if let plan = agent.plan {
                    Label(plan, systemImage: "diamond.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let pct = agent.ctxPct, pct > 0 { CtxMeter(label: "Context", pct: pct) }
            }
        }
        .padding(.vertical, 4)
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
    private var statusLabel: String {
        switch agent.status {
        case "working", "running", "starting": return "Working"
        case "waiting", "waiting_for_input", "blocked": return "Needs input"
        case "error", "failed": return "Error"
        default: return "Idle"
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case "working", "running", "starting": return .green
        case "waiting", "waiting_for_input", "blocked": return .orange
        case "error", "failed": return .red
        default: return .secondary
        }
    }

    /// Elapsed on the current turn — only while actively working (idle agents have no
    /// running turn to time). `promptStartedAt` is ms-epoch.
    private var elapsed: String? {
        guard let start = agent.promptStartedAt,
              ["working", "running", "starting"].contains(agent.status ?? "") else { return nil }
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
                // Title is primary; everything else collapses to one quiet metadata line
                // ("Resumable · 3 messages · 55m ago") so the row scans cleanly.
                Text(title)
                    .font(.subheadline)
                    .lineLimit(1)
                Text(metadataLine)
                    .font(.caption2)
                    .foregroundStyle(statusColor)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
    }

    private var title: String {
        if let t = session.title, !t.isEmpty { return t }
        return "Untitled conversation"
    }

    /// One line: the state, then message count and last-active — the metadata that tells
    /// apart same-prefix truncated titles, without an icon per field.
    private var metadataLine: String {
        var parts = [statusLabel]
        if let t = session.userTurns, t > 0 { parts.append("\(t) message\(t == 1 ? "" : "s")") }
        if let rel = relative { parts.append(rel) }
        return parts.joined(separator: " · ")
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
/// label is required — a bare "100%" is meaningless, "Context 100%" is not.
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
            Text("\(pct)%").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    private var color: Color { pct >= 85 ? .red : pct >= 60 ? .orange : .green }
}
