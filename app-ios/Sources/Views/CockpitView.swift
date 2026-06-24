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
                        Text(summary(store.agents))
                    } footer: {
                        Text("Tap an agent to drive it.").font(.caption2)
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
                    Label("New agent", systemImage: "plus.circle.fill")
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

    /// "2 working · 1 waiting · 3 idle" — the Now header line.
    private func summary(_ agents: [RosterAgent]) -> String {
        func count(_ pred: (String?) -> Bool) -> Int { agents.filter { pred($0.status) }.count }
        let working = count { $0 == "working" || $0 == "running" || $0 == "starting" }
        let waiting = count { $0 == "waiting" || $0 == "waiting_for_input" || $0 == "blocked" }
        let idle = agents.count - working - waiting
        var parts: [String] = []
        if working > 0 { parts.append("\(working) working") }
        if waiting > 0 { parts.append("\(waiting) waiting") }
        if idle > 0 { parts.append("\(idle) idle") }
        return parts.isEmpty ? "Now" : parts.joined(separator: " · ")
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
            if agent.plan != nil || (agent.ctxPct ?? 0) > 0 {
                HStack(spacing: 8) {
                    if let plan = agent.plan {
                        Label(plan, systemImage: "diamond.fill")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 8)
                    if let pct = agent.ctxPct, pct > 0 { CtxMeter(pct: pct) }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    /// The agent's current action ("edit agent.js"), else its title, else a status word.
    private var primaryLine: String {
        if let a = agent.lastAction, let label = a.label, !label.isEmpty {
            let verb = (a.verb ?? "").isEmpty ? "" : "\(a.verb!) "
            return "\(verb)\(label)"
        }
        if let title = agent.title, !title.isEmpty { return title }
        return humanStatus
    }

    private var humanStatus: String {
        switch agent.status {
        case "working", "running", "starting": return "Working…"
        case "waiting", "waiting_for_input", "blocked": return "Waiting for you"
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

/// One past conversation: preview title, a "running" tag if it's still live, message
/// count, and how long ago it was last active.
private struct ConversationRow: View {
    let session: WorkspaceSession
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.subheadline)
                .lineLimit(1)
            HStack(spacing: 8) {
                if session.liveId != nil {
                    Label("running", systemImage: "circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.green)
                        .labelStyle(.titleAndIcon)
                }
                if let t = session.userTurns, t > 0 {
                    Text("\(t) message\(t == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let rel = relative {
                    Text(rel).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var title: String {
        if let t = session.title, !t.isEmpty { return t }
        return "Untitled conversation"
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

/// A compact context-window fill bar (green → orange → red as the window fills).
private struct CtxMeter: View {
    let pct: Int
    private let width: CGFloat = 44

    var body: some View {
        HStack(spacing: 5) {
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2)).frame(width: width, height: 5)
                Capsule().fill(color).frame(width: width * CGFloat(min(pct, 100)) / 100, height: 5)
            }
            Text("\(pct)%").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
    }

    private var color: Color { pct >= 85 ? .red : pct >= 60 ? .orange : .green }
}
