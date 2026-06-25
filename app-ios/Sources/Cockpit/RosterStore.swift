import Foundation
import Observation

/// The live cockpit roster for one project — the data behind the "Now" zone
/// (PLAN_COCKPIT.md §3.1). Subscribes to the aggregate agent stream
/// (`/api/agent/roster/stream?project=…`, §3.1c): a `snapshot` frame paints the whole
/// roster at once, then `agent`/`removed` frames keep it current, so timers and context
/// meters tick live without re-polling the list. The native `SSEClient` can set the
/// bearer header, so it hits the admin-guarded stream directly — no `?access_token=` in
/// the URL like the web app needs.
@MainActor
@Observable
final class RosterStore {
    private(set) var agents: [RosterAgent] = []
    private(set) var connected = false
    var error: String?

    private let project: String
    private let token: String?
    private var task: Task<Void, Never>?

    init(project: String, token: String?) {
        self.project = project
        self.token = token
    }

    /// The shape of all three roster frames (`snapshot` carries `sessions`, `agent`
    /// carries one `session`, `removed` carries an `id`).
    private struct Frame: Decodable {
        let kind: String
        let sessions: [RosterAgent]?
        let session: RosterAgent?
        let id: String?
    }

    /// Open the live stream. Safe to call repeatedly — it tears down any prior stream. The
    /// stream auto-reconnects with backoff (matrix #8): a backgrounded/idle/deploy-dropped
    /// socket self-heals instead of demanding a pull-to-refresh.
    func start() {
        stop()
        let encoded = project.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? project
        task = Task { @MainActor in
            var attempt = 0
            while !Task.isCancelled {
                let sse = SSEClient(url: APIConfig.url("/api/agent/roster/stream?project=\(encoded)"), token: token)
                do {
                    for try await event in sse.events() {
                        guard let frame = try? JSONDecoder().decode(Frame.self, from: Data(event.data.utf8)) else { continue }
                        apply(frame)
                        connected = true
                        error = nil
                        attempt = 0   // a live event clears the backoff
                    }
                    // Server closed the stream (idle/deploy) — fall through and reconnect.
                } catch is CancellationError {
                    return          // we left the view / re-opened — not an error
                } catch {
                    connected = false
                    self.error = "Live roster reconnecting…"
                }
                if Task.isCancelled { return }
                let secs = min(8, 1 << min(attempt, 3))   // 1 → 2 → 4 → 8s
                attempt += 1
                try? await Task.sleep(nanoseconds: UInt64(secs) * 1_000_000_000)
            }
        }
    }

    /// Optimistically drop an agent the user just ended (swipe-to-end), so the row leaves
    /// immediately; the stream's `removed` frame confirms it.
    func removeLocally(id: String) {
        agents.removeAll { $0.id == id }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// One-shot paint (instant load + pull-to-refresh). The list endpoint returns the
    /// same records the stream sends, so we can show the roster before the stream — or
    /// when it can't connect.
    func refresh(client: APIClient) async {
        do {
            agents = sorted(try await client.roster(project: project))
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func apply(_ frame: Frame) {
        switch frame.kind {
        case "snapshot":
            agents = sorted(frame.sessions ?? [])
        case "agent":
            if let s = frame.session {
                var next = agents.filter { $0.id != s.id }
                next.append(s)
                agents = sorted(next)
            }
        case "removed":
            if let id = frame.id { agents.removeAll { $0.id == id } }
        default:
            break
        }
    }

    /// Needs-you first: waiting → working → error → idle; within a tier, the
    /// longest-running turn (earliest `promptStartedAt`) sorts first.
    private func sorted(_ list: [RosterAgent]) -> [RosterAgent] {
        list.sorted { a, b in
            let ra = rank(a.status), rb = rank(b.status)
            if ra != rb { return ra < rb }
            return (a.promptStartedAt ?? .greatestFiniteMagnitude) < (b.promptStartedAt ?? .greatestFiniteMagnitude)
        }
    }

    private func rank(_ status: String?) -> Int {
        switch status {
        case "waiting", "waiting_for_input", "blocked": return 0
        case "working", "running", "starting": return 1
        case "error", "failed": return 2
        default: return 3
        }
    }
}
