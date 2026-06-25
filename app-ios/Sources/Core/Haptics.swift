import UIKit

/// Thin wrapper over UIKit haptics — the physical "live-activity channel" native unlocks
/// over the web brain (PLAN_NATIVE_BRAIN.md §3). Today: a soft tick when you open a brain
/// doc/node. Reserved for the brain⇄chat live link (a tick when the agent *reads* a doc, a
/// sharper one when it *edits*, a success buzz when a plan ring completes) in a later batch.
enum Haptics {
    /// A light tap — node/doc open.
    static func tap() {
        let g = UIImpactFeedbackGenerator(style: .light)
        g.prepare()
        g.impactOccurred()
    }

    /// A sharper hit — an edit landed.
    static func edit() {
        let g = UIImpactFeedbackGenerator(style: .medium)
        g.prepare()
        g.impactOccurred()
    }

    /// Success — e.g. a plan ring reached 100%.
    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }
}
