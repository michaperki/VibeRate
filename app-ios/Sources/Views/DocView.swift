import SwiftUI

/// One brain doc, read on the phone (PLAN_NATIVE_BRAIN.md B11/B12/B14). The web's doc
/// lightbox; here it reuses the same `MarkdownView` the chat uses (one renderer, both
/// surfaces — the web discipline, PROJECT_VIEW_PLAN.md), with a plan **completion-ring
/// header** for checklists and a raw-markdown toggle. Pushed onto the shared stack as a
/// `DocRoute` carrying the already-fetched `BrainDoc`, so there's no re-fetch.
struct DocView: View {
    let doc: BrainDoc
    @State private var showRaw = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let c = doc.completion {
                    HStack(spacing: 12) {
                        CompletionRing(pct: c.pct, size: 52)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(c.done) of \(c.total) done")
                                .font(.subheadline.weight(.semibold))
                            Text("\(c.pct)% complete")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }
                    Divider()
                }

                if showRaw {
                    Text(doc.content ?? "")
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    MarkdownView(text: doc.content ?? "_(empty document)_")
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(doc.base)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showRaw.toggle()
                } label: {
                    // Render ↔ raw markdown (web B13).
                    Image(systemName: showRaw ? "doc.richtext" : "chevron.left.forwardslash.chevron.right")
                }
                .accessibilityLabel(showRaw ? "Rendered" : "Raw markdown")
            }
        }
    }
}
