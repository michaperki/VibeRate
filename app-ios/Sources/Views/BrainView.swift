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
        .buttonStyle(.plain)
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
        Text(s.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
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
                Circle()
                    .fill(prominent ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.12))
                Image(systemName: prominent ? "circle.hexagongrid.fill" : "doc.text")
                    .font(prominent ? .title3 : .subheadline)
                    .foregroundStyle(prominent ? Color.accentColor : .secondary)
            }
            .frame(width: diameter, height: diameter)
        }
    }
}

/// An arc completion ring — amber→green by %, mirroring the web brain-node ring. The keeper
/// signal: "plans with a completion ring read as strong" (Mike, PROJECT_VIEW_PLAN.md).
struct CompletionRing: View {
    let pct: Int
    var size: CGFloat = 50
    var line: CGFloat = 4

    private var color: Color {
        if pct >= 100 { return .green }
        if pct >= 50 { return Color(red: 0.55, green: 0.78, blue: 0.25) }
        return .orange
    }

    var body: some View {
        ZStack {
            Circle().stroke(Color.secondary.opacity(0.18), lineWidth: line)
            Circle()
                .trim(from: 0, to: max(0.001, CGFloat(pct) / 100))
                .stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
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
        .frame(width: size, height: size)
    }
}
