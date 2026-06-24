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

/// A live/known Drive agent session (`GET /api/agent/sessions`).
struct AgentSession: Codable, Identifiable {
    let id: String
    let claudeSessionId: String?
    let projectSlug: String?
    let cwd: String?
    let status: String?
}
