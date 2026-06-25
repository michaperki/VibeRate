import SwiftUI

/// The brain⇄chat **live link** (PLAN_NATIVE_BRAIN.md B8) — the native equivalent of the
/// web's `brainTouch()` (`public/app.js`). The Drive SSE reports which docs the agent is
/// touching (`tool_use` with a file path); this shared store records recent touches per
/// project so two *separate* screens can react: `DriveSessionView` (which receives the
/// events) fires a haptic and shows a live pulse, and `BrainView` (another screen) glows
/// the touched node. One observable singleton bridges them — no event plumbing between views.
///
/// Reads events the runtime already emits (no new agent tokens — the standing capture rule).
@MainActor
@Observable
final class BrainActivity {
    static let shared = BrainActivity()
    private init() {}

    enum Verb { case read, edit, run }

    struct Touch {
        let verb: Verb
        let at: Date
    }

    /// How long a touch glows before it decays back to rest.
    static let window: TimeInterval = 4

    /// Per project slug → most-recent touch per doc basename (lowercased).
    private(set) var touches: [String: [String: Touch]] = [:]

    /// Classify a tool name into a brain verb, mirroring the web `classifyTool` buckets.
    static func verb(forTool name: String) -> Verb {
        let n = name.lowercased()
        if n.contains("edit") || n.contains("write") { return .edit }   // Edit/Write/MultiEdit/NotebookEdit
        if n.contains("bash") || n.contains("shell") || n.contains("exec") { return .run }
        return .read                                                     // Read/Grep/Glob/…
    }

    /// Record that the agent touched a file. Only `.md` docs land on the brain graph; for
    /// those a haptic fires — the physical live channel (§3): a sharper hit for an edit, a
    /// soft tick for a read/run.
    func touch(slug: String, file: String, verb: Verb) {
        let base = (file as NSString).lastPathComponent.lowercased()
        guard base.hasSuffix(".md") else { return }
        var perDoc = touches[slug] ?? [:]
        perDoc[base] = Touch(verb: verb, at: Date())
        touches[slug] = perDoc
        switch verb {
        case .edit: Haptics.edit()
        case .read, .run: Haptics.tap()
        }
    }

    /// Glow intensity (0…1) for a doc right now, decaying linearly over `window`. 0 = at rest.
    func glow(slug: String, base: String, now: Date) -> Double {
        guard let t = touches[slug]?[base.lowercased()] else { return 0 }
        let age = now.timeIntervalSince(t.at)
        if age >= Self.window || age < 0 { return 0 }
        return 1 - age / Self.window
    }

    /// The verb of the most-recent (still-glowing) touch — drives the glow colour.
    func verb(slug: String, base: String, now: Date) -> Verb? {
        guard let t = touches[slug]?[base.lowercased()],
              now.timeIntervalSince(t.at) < Self.window else { return nil }
        return t.verb
    }

    /// Is anything glowing for this project? Drives the chat's live-pulse badge.
    func isActive(slug: String, now: Date) -> Bool {
        guard let perDoc = touches[slug] else { return false }
        return perDoc.values.contains { now.timeIntervalSince($0.at) < Self.window }
    }
}
