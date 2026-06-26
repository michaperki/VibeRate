import SwiftUI

/// The project **brain** on the phone — the doc network the agent steers through. This is
/// the first native render of the brain (PLAN_NATIVE_BRAIN.md B1/B2/B3): the web shipped a
/// force-sim SVG, but the 2026-06-24 "nodes at rest" rethink (PROJECT_VIEW_PLAN.md) says at
/// rest the brain shows only the **working set** — the constitution **anchor** + the
/// **plans-with-rings** — with the ~N quiet reference docs behind a `+N docs` toggle, and no
/// ambient motion. So this is a calm, structured layout, not a spinning field: anchor on
/// top, a plan shelf with completion rings, quiet docs on demand. Tap a node → the doc;
/// long-press → a peek (the touch home for the desktop hover-peek). Real drag-to-fling
/// force physics is the next batch (PLAN_NATIVE_BRAIN.md Phase 3).
struct BrainView: View {
    let project: Project
    @Environment(NavRouter.self) private var router

    @State private var docs: [BrainDoc] = []
    @State private var loading = true
    @State private var error: String?
    @State private var showQuiet = false
    // The live link (B8): observe touches, and tick `now` so a glow decays smoothly even
    // when nothing else changes the view. The tick only matters while this screen is up.
    @State private var brain = BrainActivity.shared
    @State private var now = Date()

    private var client: APIClient { APIClient(token: TokenStore.load()) }

    // The "nodes at rest" partition — disjoint, so no doc shows twice.
    private var anchors: [BrainDoc] { docs.filter { $0.role == .constitution } }
    private var plans: [BrainDoc] { docs.filter { $0.isPlan && $0.role != .constitution } }
    private var quiet: [BrainDoc] { docs.filter { !$0.isPlan && $0.role != .constitution } }

    private let columns = [GridItem(.adaptive(minimum: 96), spacing: 18)]

    var body: some View {
        ScrollView {
            if loading && docs.isEmpty {
                ProgressView().padding(.top, 60)
            } else if let error {
                stateCard(icon: "exclamationmark.triangle", title: "Couldn't load the brain",
                          message: error, action: "Try again") { Task { await load() } }
            } else if docs.isEmpty {
                stateCard(icon: "brain", title: "No brain docs yet",
                          message: "This project has no .md docs captured yet. The brain fills in as the agent reads and writes docs.")
                    .background { GlyphWatermark().offset(y: 20) }
            } else {
                VStack(alignment: .leading, spacing: 28) {
                    anchorSection
                    plansSection
                    quietSection
                }
                .padding(20)
            }
        }
        .navigationTitle("Brain")
        .navigationBarTitleDisplayMode(.inline)
        .screenBackground()
        .task { await load() }
        .refreshable { await load() }
        // Drive the glow decay (B8). 0.3s steps over the 4s window read as a smooth fade.
        .onReceive(Timer.publish(every: 0.3, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    // MARK: sections

    @ViewBuilder
    private var anchorSection: some View {
        if !anchors.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                sectionLabel("Anchor")
                HStack(spacing: 18) {
                    ForEach(anchors) { node($0, prominent: true) }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    @ViewBuilder
    private var plansSection: some View {
        if !plans.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                // The "PLAN_" prefix lives here, in the header — stripped off every tile
                // below — and the ring legend decodes the bare number ("% of the plan's
                // checklist done"), so a first-timer isn't left guessing "percent of what".
                VStack(alignment: .leading, spacing: 4) {
                    sectionLabel(plans.count == 1 ? "1 plan" : "\(plans.count) plans")
                    Text("ring = % of checklist done")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                LazyVGrid(columns: columns, alignment: .leading, spacing: 22) {
                    ForEach(plans) { node($0) }
                }
            }
        }
    }

    @ViewBuilder
    private var quietSection: some View {
        if !quiet.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                Button {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) { showQuiet.toggle() }
                } label: {
                    Label(showQuiet ? "Hide docs" : "+\(quiet.count) docs",
                          systemImage: showQuiet ? "chevron.down" : "chevron.right")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                }
                .buttonStyle(.plain)

                if showQuiet {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 22) {
                        ForEach(quiet) { node($0) }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    // MARK: a single node — tap to open (haptic), long-press to peek

    private func node(_ doc: BrainDoc, prominent: Bool = false) -> some View {
        let g = brain.glow(slug: project.slug, base: doc.base, now: now)
        let v = brain.verb(slug: project.slug, base: doc.base, now: now)
        return Button {
            Haptics.tap()
            router.path.append(DocRoute(doc: doc))
        } label: {
            BrainNodeView(doc: doc, prominent: prominent, glow: g, glowVerb: v)
        }
        .buttonStyle(.pressable)
        .contextMenu {
            Button {
                Haptics.tap()
                router.path.append(DocRoute(doc: doc))
            } label: { Label("Open", systemImage: "doc.text") }
        } preview: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if let c = doc.completion { CompletionRing(pct: c.pct, size: 34) }
                    Text(doc.displayLabel).font(.headline)
                }
                Text(doc.peekText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(8)
            }
            .padding(16)
            .frame(width: 300, alignment: .leading)
        }
    }

    private func sectionLabel(_ s: String) -> some View {
        // Brand-tinted, slightly off full strength — lets the identity color carry the
        // section structure instead of yet another grey (2026-06-26 "fun" pass).
        Text(s.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Color.accentColor.opacity(0.85))
            .tracking(0.5)
    }

    @ViewBuilder
    private func stateCard(icon: String, title: String, message: String,
                           action: String? = nil, run: (() -> Void)? = nil) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let action, let run {
                Button(action, action: run).buttonStyle(.bordered).padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(40)
    }

    private func load() async {
        loading = true
        error = nil
        do { docs = try await client.docs(slug: project.slug) }
        catch { self.error = apiMessage(error) }
        loading = false
    }
}

/// A brain node: a completion ring for plans, a quiet glyph otherwise, with the basename
/// under it. The anchor (constitution) renders prominent.
struct BrainNodeView: View {
    let doc: BrainDoc
    var prominent: Bool = false
    /// Live-link glow 0…1 (B8), decaying since the agent last touched this doc.
    var glow: Double = 0
    var glowVerb: BrainActivity.Verb? = nil

    private var diameter: CGFloat { prominent ? 62 : 50 }

    // Glow colour by verb, mirroring the web brainTouch tints: read = blue pulse,
    // edit = warm flare, run = green ripple.
    private var glowColor: Color {
        switch glowVerb {
        case .edit: return .orange
        case .run: return .green
        default: return .blue
        }
    }

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                // A soft halo behind the node that fades as the touch decays.
                if glow > 0 {
                    Circle()
                        .fill(glowColor.opacity(0.40 * glow))
                        .frame(width: diameter + 26, height: diameter + 26)
                        .blur(radius: 7)
                }
                core
                    .scaleEffect(1 + 0.06 * glow)
            }
            // Stripped of `.md`/`PLAN_` and de-snaked so it wraps on spaces, never
            // hyphenates mid-word in this narrow tile (UI review 2026-06-26).
            Text(doc.displayLabel)
                .font(.caption2.weight(prominent ? .semibold : .regular))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 92)
        }
        .animation(.easeOut(duration: 0.3), value: glow)
    }

    @ViewBuilder
    private var core: some View {
        if let c = doc.completion {
            CompletionRing(pct: c.pct, size: diameter)
        } else {
            ZStack {
                // The constitution anchor wears the brand gradient (the brand color off its
                // leash on the brain's most important node); quiet docs stay a flat grey.
                if prominent {
                    Circle().fill(Theme.brandGradient.opacity(0.22))
                    Circle().strokeBorder(Theme.brandGradient.opacity(0.5), lineWidth: 1)
                } else {
                    Circle().fill(Color.secondary.opacity(0.12))
                }
                Image(systemName: prominent ? "circle.hexagongrid.fill" : "doc.text")
                    .font(prominent ? .title3 : .subheadline)
                    .foregroundStyle(prominent ? Color.accentColor : .secondary)
            }
            .frame(width: diameter, height: diameter)
        }
    }
}

/// The completion ring — the app's signature element (the most distinctive thing on screen,
/// so the 2026-06-26 "fun" pass leans into it). It now: sweeps its fill from 0 to value on
/// appear (~0.7s); strokes with the brand spectrum (blue→violet→lime) so the *tip* color
/// reads as "how far along"; and a finished plan gets a celebratory state — a solid lime
/// ring with a soft glow and a checkmark, so reaching 100% *feels* like something instead of
/// just changing a number. The keeper signal: "plans with a completion ring read as strong"
/// (Mike, PROJECT_VIEW_PLAN.md).
struct CompletionRing: View {
    let pct: Int
    var size: CGFloat = 50
    var line: CGFloat = 4

    /// Flipped true on appear to drive the sweep + the celebratory pop.
    @State private var animate = false

    private var complete: Bool { pct >= 100 }
    private var target: CGFloat { max(0.001, CGFloat(min(pct, 100)) / 100) }

    var body: some View {
        ZStack {
            // Track — a faint hairline so the unfilled portion still reads as a ring.
            Circle().stroke(Color.white.opacity(0.10), lineWidth: line)

            if complete {
                // Celebratory: a full lime ring with a soft glow that blooms as it lands.
                Circle()
                    .stroke(Theme.lime, style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .shadow(color: Theme.lime.opacity(0.6), radius: animate ? 6 : 0)
            } else {
                Circle()
                    .trim(from: 0, to: animate ? target : 0)
                    .stroke(Theme.ringGradient, style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }

            center
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.7), value: animate)
        .onAppear { animate = true }
    }

    @ViewBuilder
    private var center: some View {
        if complete {
            // A checkmark instead of "100%" — completion as a state, not a count.
            Image(systemName: "checkmark")
                .font(.system(size: size * 0.36, weight: .bold))
                .foregroundStyle(Theme.lime)
                .scaleEffect(animate ? 1 : 0.4)
                .opacity(animate ? 1 : 0)
        } else {
            // A "%" unit on the number so a bare "63" reads as a percentage, not a count
            // (UI review 2026-06-26). The unit is smaller + muted so the figure still leads.
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("\(pct)")
                    .font(.system(size: size * 0.28, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("%")
                    .font(.system(size: size * 0.18, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}
