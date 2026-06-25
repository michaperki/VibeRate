import Foundation
import Observation
import UIKit
import UserNotifications

/// Owns the device's push lifecycle: ask permission, register the APNs token with the
/// server, and turn a tapped "your agent needs you" notification into a selector. The
/// reason the native app earns its place over the web view (PLAN_NATIVE_REWRITE.md) — a
/// Drive turn runs for minutes then blocks on you, and push is how it reaches out.
///
/// A shared singleton because the `AppDelegate` (which receives the system callbacks)
/// and the SwiftUI view tree (which presents the sheet) both need the same instance.
@MainActor
@Observable
final class PushManager {
    static let shared = PushManager()

    /// Set when a tapped `ask` notification carried renderable questions but couldn't be
    /// deep-linked (no project to route to) — drives the global `AskSheet` over the root as
    /// a fallback. Cleared when the sheet is dismissed/answered.
    var pendingAsk: AskRequest?

    /// Set when a tapped notification identifies a conversation to open (project + session).
    /// Consumed by `ProjectsView`, which drives the nav stack into that `DriveSessionView`.
    /// This is §13: a `finished`/`error`/`ask` tap lands you *in the conversation*, not just
    /// foregrounded — and the session's own SSE backfill re-surfaces a still-pending ask as
    /// the inline picker, so you answer in context. Cleared once consumed.
    var pendingRoute: PushRoute?

    /// The APNs device token (hex), once iOS hands it to us. Persisted so we can
    /// re-register after a sign-in that happens later than registration.
    private(set) var deviceTokenHex: String?

    private let tokenKey = "push.deviceTokenHex"

    private init() {
        deviceTokenHex = UserDefaults.standard.string(forKey: tokenKey)
    }

    /// Call once the user is signed in: request authorization (idempotent — iOS only
    /// prompts the first time) and, if we already hold a token, (re)register it.
    func onSignedIn() {
        requestAuthorization()
        registerWithServer()
    }

    private func requestAuthorization() {
        let center = UNUserNotificationCenter.current()
        // A category so iOS tags the "needs you" alerts; the options are dynamic so we
        // don't attach fixed action buttons — a tap opens the in-app selector instead.
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "AGENT_ASK", actions: [], intentIdentifiers: [], options: [])
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// The `AppDelegate` forwards the freshly-issued APNs token here.
    func didRegister(tokenHex: String) {
        deviceTokenHex = tokenHex
        UserDefaults.standard.set(tokenHex, forKey: tokenKey)
        registerWithServer()
    }

    private func registerWithServer() {
        guard let hex = deviceTokenHex, let token = TokenStore.load() else { return }
        Task { try? await APIClient(token: token).registerPush(deviceToken: hex) }
    }

    /// On sign-out: tell the server to stop pushing this device.
    func onSignedOut() {
        guard let hex = deviceTokenHex, let token = TokenStore.load() else { return }
        Task { try? await APIClient(token: token).unregisterPush(deviceToken: hex) }
    }

    /// Handle a delivered notification. `fromTap` distinguishes the user tapping the
    /// banner (open the conversation) from a foreground delivery (just let iOS show it).
    func handle(userInfo: [AnyHashable: Any], fromTap: Bool) {
        guard fromTap else { return }
        guard let vbrt = userInfo["vbrt"] as? [String: Any] else { return }
        let kind = (vbrt["kind"] as? String) ?? ""
        let sessionId = vbrt["sessionId"] as? String
        let projectSlug = vbrt["projectSlug"] as? String

        // Prefer deep-linking into the actual conversation for ANY tap that identifies a
        // session + project (finished / error / ask). Once the DriveSessionView opens, its
        // SSE replay re-surfaces a still-pending ask as the inline picker — so we answer in
        // context, and this also fixes the case where the `ask` questions were stripped for
        // the 4KB cap (a tap used to route nowhere). PLAN_NATIVE_PARITY §13.
        if let sessionId, let projectSlug, !projectSlug.isEmpty {
            pendingRoute = PushRoute(projectSlug: projectSlug, sessionId: sessionId, kind: kind)
            return
        }

        // Fallback: the payload can't route (no project) — if it's an `ask` with renderable
        // questions, open the global selector so you can still answer from anywhere.
        if kind == "ask", let askId = vbrt["askId"] as? String, let sessionId {
            let questions = Self.parseQuestions(vbrt["questions"])
            guard !questions.isEmpty else { return }
            pendingAsk = AskRequest(
                askId: askId,
                sessionId: sessionId,
                projectSlug: projectSlug,
                questions: questions
            )
        }
    }

    /// Decode the loosely-typed `vbrt.questions` array from a notification payload into
    /// our `AskQuestion` models (the payload is JSON-ish `[[String: Any]]`).
    static func parseQuestions(_ raw: Any?) -> [AskQuestion] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { q in
            guard let question = q["question"] as? String else { return nil }
            let options = (q["options"] as? [[String: Any]])?.compactMap { o -> AskOption? in
                guard let label = o["label"] as? String else { return nil }
                return AskOption(label: label, description: o["description"] as? String)
            }
            return AskQuestion(
                question: question,
                header: q["header"] as? String,
                multiSelect: q["multiSelect"] as? Bool,
                options: options
            )
        }
    }
}

/// A pending deep-link from a tapped notification: open this project's conversation.
/// `kind` (finished/error/ask) is carried only so a future entry could tune the landing;
/// today every kind routes the same — straight into the session's `DriveSessionView`.
struct PushRoute: Identifiable, Hashable {
    let projectSlug: String
    let sessionId: String
    let kind: String
    var id: String { kind + "|" + projectSlug + "|" + sessionId }
}

/// The UIKit delegate that receives the push callbacks SwiftUI doesn't surface, and
/// forwards them to `PushManager.shared`. Wired in via `@UIApplicationDelegateAdaptor`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in PushManager.shared.didRegister(tokenHex: hex) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[push] APNs registration failed: \(error.localizedDescription)")
    }

    // Foreground delivery: show the banner for an `ask` (it's blocking — you want to see
    // it even mid-use), but suppress `finished`/`error` banners while the app is active
    // (you're already watching; the transcript shows it).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let vbrt = notification.request.content.userInfo["vbrt"] as? [String: Any]
        if (vbrt?["kind"] as? String) == "ask" {
            completionHandler([.banner, .sound, .list])
        } else {
            completionHandler([])
        }
    }

    // The user tapped the notification → route into the selector.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        Task { @MainActor in PushManager.shared.handle(userInfo: info, fromTap: true) }
        completionHandler()
    }
}
