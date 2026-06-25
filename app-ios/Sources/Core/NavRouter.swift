import SwiftUI

/// A Drive-session navigation target, pushed onto the shared signed-in NavigationStack
/// path. It carries its own `project` (unlike the old CockpitView-local `DriveTarget`) so
/// the destination can be registered **once at the stack root** — which is exactly what
/// lets a tapped push notification deep-link two levels deep (Projects → Cockpit → here)
/// in a single `path` assignment. Mirrors the variants the cockpit already supports.
struct DriveRoute: Hashable {
    let project: Project
    var sessionId: String? = nil   // attach to a live agent (a Now-roster row, or a push)
    var resumeCid: String? = nil   // adopt a durable past conversation (a Conversations row)
    var status: String? = nil      // roster's last-known status, so the entry bar reads right
    var forceNew: Bool = false      // start a brand-new agent (the + button)
}

/// Owns the signed-in navigation stack's `path` so both **in-app taps** (CockpitView rows)
/// and an **out-of-app push deep-link** (ProjectsView consuming `PushManager.pendingRoute`)
/// drive the same stack. One path, every destination registered via
/// `navigationDestination(for:)` — no `navigationDestination(item:)` mixed in, which would
/// misbehave when the path is also assigned programmatically. This is the navigation half
/// of PLAN_NATIVE_PARITY §13: the agent reaches out (push), you reach back in one tap.
@MainActor
@Observable
final class NavRouter {
    var path = NavigationPath()
}
