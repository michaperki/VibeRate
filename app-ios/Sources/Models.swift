import Foundation

/// The signed-in account (`GET /api/me`).
struct Me: Codable, Identifiable {
    let id: String
    let email: String?
    let name: String?
    let provider: String?
    let projectCount: Int?
}

/// A project in the owner's list (`GET /api/projects`). Only the fields the starter
/// renders are decoded — the server sends more, and unknown keys are ignored.
struct Project: Codable, Identifiable, Hashable {
    let slug: String
    let name: String?
    /// The server sends `sessions` as an ARRAY of captured sessions, not a count.
    /// (Decoding it as Int was the "[0].sessions expected Int, found array" error.)
    let sessions: [ProjectSession]?
    let visibility: String?
    let updatedAt: String?
    let streaming: Bool?

    var id: String { slug }
    var sessionCount: Int { sessions?.count ?? 0 }
}

/// One captured session in a project's `sessions` list. The native client only needs
/// the count for the list badge; live Drive streaming uses `/api/agent/sessions`
/// instead, so the rest is decoded leniently (all optional).
struct ProjectSession: Codable, Hashable {
    let id: String?
    let title: String?
    let lastUserText: String?
    let startedAt: String?
    let endedAt: String?
}

/// A project's Drive workspace binding (`GET /api/agent/workspace/:slug`). A driven
/// session needs a checkout on the host; until one exists, `POST /api/agent/sessions`
/// 409s. `suggestedRepo` prefills the setup form (the repo the project was created from).
struct WorkspaceInfo: Codable {
    let workspace: WorkspaceState?
    let suggestedRepo: String?
    let name: String?
}

/// The clone state of a project's workspace. `status` walks `cloning → ready | error`;
/// the setup form polls `GET` until it leaves `cloning`. All optional — the server sends
/// more (`dir`, `head`, `updatedAt`) and unknown keys are ignored.
struct WorkspaceState: Codable {
    let status: String?
    let repo: String?
    let branch: String?
    let error: String?
}

/// A live/known Drive agent session (`GET /api/agent/sessions`).
struct AgentSession: Codable, Identifiable {
    let id: String
    let claudeSessionId: String?
    let projectSlug: String?
    let cwd: String?
    let status: String?
}

/// One live agent on the cockpit "Now" roster. This is the enriched `publicView`
/// payload (PLAN_COCKPIT.md §3.1) — the same record the roster stream pushes in its
/// `snapshot`/`agent` frames and that `/api/agent/sessions` returns. Only the fields the
/// roster row renders are decoded; the server sends more and unknown keys are ignored.
struct RosterAgent: Codable, Identifiable, Hashable {
    let id: String
    let projectSlug: String?
    let status: String?
    let title: String?
    let type: String?
    let model: String?
    /// ms-epoch start of the current turn — the roster's elapsed timer ticks from this.
    let promptStartedAt: Double?
    let lastAction: LastAction?
    let currentPlan: String?   // inferred from touched files (tier 1)
    let declaredPlan: String?  // self-reported via the MCP `report` tool (ground truth)
    let ctxPct: Int?

    struct LastAction: Codable, Hashable {
        let verb: String?
        let label: String?
        let file: String?
    }

    /// Declared (self-reported) plan wins over the inferred one.
    var plan: String? { declaredPlan ?? currentPlan }
}
