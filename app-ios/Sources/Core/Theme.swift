import SwiftUI
import UIKit

/// The app's visual language — the one place color, depth, the brand spectrum, and motion
/// are defined, so every surface speaks it consistently (2026-06-26 "fun" pass). The
/// diagnosis: the app was legible but cold — pure-black backgrounds, one SF weight, flat
/// status-only color, no motion ("a settings screen"). The fix, restrained à la
/// Linear/Raycast (characterful, not playful): a *hued* near-black with real layering, the
/// brand color off its leash, a gradient/celebratory ring, and a few cheap animations.
enum Theme {
    // MARK: palette

    /// Base surface — a near-black with a faint blue-violet hue (#0B0B10). Pure #000 reads
    /// flat because every surface sits on one plane; a hint of hue + lighter cards = depth.
    static let base = Color(red: 0.043, green: 0.043, blue: 0.063)
    /// One step up from `base` — cards, the nav bar.
    static let surface = Color(red: 0.082, green: 0.082, blue: 0.122)   // #15151F
    /// Two steps up — a raised tile / pressed state.
    static let surface2 = Color(red: 0.122, green: 0.122, blue: 0.176)  // #1F1F2D

    /// The brand blue — matches the AccentColor asset, so `Color.accentColor` and
    /// `Theme.brand` are the same hue (the brand color used elsewhere keeps reading right).
    static let brand = Color(red: 0.302, green: 0.451, blue: 0.949)
    /// The web brand violet (#7C5CFF) — the warm end of the brand spectrum.
    static let violet = Color(red: 0.486, green: 0.361, blue: 1.0)
    /// A muted lime (#8FD14F) — the "complete / warm" end of the ring spectrum. Confident,
    /// not candy (the caution: this is a power-user dev tool).
    static let lime = Color(red: 0.561, green: 0.820, blue: 0.310)

    // MARK: gradients

    /// The progress-ring spectrum: cool brand-blue at the start, through violet, to lime as
    /// the arc completes — so the *tip* color reads as "how far along". The trailing repeat
    /// of `lime` keeps the wrap seam at 100% on-brand rather than snapping back to blue.
    static var ringGradient: AngularGradient {
        AngularGradient(gradient: Gradient(colors: [brand, violet, lime, lime]), center: .center)
    }

    /// A diagonal brand wash — for accent fills, the constitution anchor, the wordmark.
    static var brandGradient: LinearGradient {
        LinearGradient(colors: [brand, violet], startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    /// The screen background: the hued base plus two faint brand glows, like a soft light
    /// source in the corners. Subtle on purpose — it gives the black depth and fills dead
    /// air without competing with content.
    static var ambient: some View {
        ZStack {
            base
            RadialGradient(colors: [violet.opacity(0.10), .clear],
                           center: .topTrailing, startRadius: 0, endRadius: 440)
            RadialGradient(colors: [brand.opacity(0.07), .clear],
                           center: .bottomLeading, startRadius: 0, endRadius: 500)
        }
    }
}

// MARK: - Screen background

extension View {
    /// Lay the ambient hued background behind a screen and let the scroll content show it
    /// through (so Lists/ScrollViews stop painting pure-black `systemBackground`). Pair with
    /// `.listRowBackground(Color.clear)` on List rows so the rows are transparent too.
    func screenBackground() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background { Theme.ambient.ignoresSafeArea() }
    }
}

// MARK: - Motion

/// Tap feedback for custom (`.plain`-style) buttons: a subtle spring scale + dim on press,
/// the difference between "a document" and "a thing that's alive". Restrained — 0.97, no
/// bounce overshoot.
struct PressableButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.82 : 1)
            .animation(.spring(response: 0.3, dampingFraction: 0.62), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableButtonStyle {
    /// `.buttonStyle(.pressable)` — the app's standard tap feedback for custom buttons.
    static var pressable: PressableButtonStyle { PressableButtonStyle() }
}

/// A status dot that gently pulses while `active` — the cheapest "this is live" signal, used
/// for the agent's connecting/working state. Settles to a steady dot when inactive.
struct PulsingDot: View {
    var color: Color
    var active: Bool = true
    var size: CGFloat = 7
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .scaleEffect(active && pulse ? 1.45 : 1)
            .opacity(active && pulse ? 0.45 : 1)
            .animation(active ? .easeInOut(duration: 0.85).repeatForever(autoreverses: true)
                              : .easeOut(duration: 0.2), value: pulse)
            .onAppear { pulse = true }
    }
}

/// A faint oversized glyph watermark for empty states — the cheapest place to inject
/// character, since nothing else is competing. A brand-tinted brain/sparkle behind the void
/// says "this is a place", not dead air.
struct GlyphWatermark: View {
    var systemName: String = "brain"
    var size: CGFloat = 230

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: .thin))
            .foregroundStyle(Theme.brandGradient)
            .opacity(0.06)
            .allowsHitTesting(false)
    }
}

// MARK: - Global chrome

/// Configure app-wide UIKit chrome that SwiftUI can't reach cleanly: a themed, opaque nav
/// bar (so it sits one layer above the content — the layering that reads as "polished native
/// app") and a heavier, tighter display weight for nav titles (the "Projects"/"Brain" titles
/// get character; mono metadata elsewhere is the second voice). Called once at launch from
/// `App.init` (on the main thread), configuring UIKit appearance proxies.
func configureGlobalAppearance() {
    let bar = UINavigationBarAppearance()
    bar.configureWithOpaqueBackground()
    bar.backgroundColor = UIColor(Theme.surface)
    bar.shadowColor = .clear

    let largeBase = UIFont.systemFont(ofSize: 34, weight: .heavy)
    bar.largeTitleTextAttributes = [
        .font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: largeBase),
        .foregroundColor: UIColor.white,
        .kern: -0.5,
    ]
    let inlineBase = UIFont.systemFont(ofSize: 17, weight: .bold)
    bar.titleTextAttributes = [
        .font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: inlineBase),
        .foregroundColor: UIColor.white,
    ]

    UINavigationBar.appearance().standardAppearance = bar
    UINavigationBar.appearance().scrollEdgeAppearance = bar
    UINavigationBar.appearance().compactAppearance = bar
}
