import Foundation

enum APIError: Error, LocalizedError {
    case http(Int, String)
    case notAuthorized
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .http(let code, let body): return "Server error \(code)\(body.isEmpty ? "" : ": \(body)")"
        case .notAuthorized: return "Your session expired — sign in again."
        case .decoding(let msg): return "Unexpected response: \(msg)"
        }
    }
}

/// A thin async wrapper over the VibeRate JSON API. Stateless apart from the token.
struct APIClient {
    var token: String?

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: APIConfig.url(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as: T.Type) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.http(0, "no response") }
        if http.statusCode == 401 || http.statusCode == 403 { throw APIError.notAuthorized }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, String(data: data, encoding: .utf8) ?? "")
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw APIError.decoding("\(error)") }
    }

    /// Trade the OAuth one-time code for a durable bearer token.
    func exchange(code: String) async throws -> String {
        struct Reply: Decodable { let token: String }
        let body = try JSONEncoder().encode(["code": code])
        let req = request("/api/auth/native/exchange", method: "POST", body: body)
        return try await send(req, as: Reply.self).token
    }

    func me() async throws -> Me {
        try await send(request("/api/me"), as: Me.self)
    }

    func projects() async throws -> [Project] {
        try await send(request("/api/projects"), as: [Project].self)
    }

    /// The Drive agent roster. Admin-guarded — the token resolves to the admin email
    /// (adminEmailFor), so an admin-linked token both signs you in and unlocks Drive.
    func agentSessions() async throws -> [AgentSession] {
        try await send(request("/api/agent/sessions"), as: [AgentSession].self)
    }
}
