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
    let sessions: Int?
    let visibility: String?
    let updatedAt: String?
    let streaming: Bool?

    var id: String { slug }
}

/// A live/known Drive agent session (`GET /api/agent/sessions`).
struct AgentSession: Codable, Identifiable {
    let id: String
    let claudeSessionId: String?
    let projectSlug: String?
    let cwd: String?
    let status: String?
}
