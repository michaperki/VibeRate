import Foundation

/// Where the native client points and how the OAuth deep-link returns.
enum APIConfig {
    /// The VibeRate backend. Defaults to the live Fly instance — the same server the
    /// web app and Drive talk to. Override here to aim at a local/staging server.
    static let baseURL = URL(string: "https://vbrt.fly.dev")!

    /// The custom URL scheme registered in Info.plist (project.yml). The server bounces
    /// the OAuth one-time code back to `<scheme>://auth?code=…`.
    static let callbackScheme = "viberate"
    static let callbackURL = "viberate://auth"

    static func url(_ path: String) -> URL {
        URL(string: baseURL.absoluteString + path)!
    }
}
