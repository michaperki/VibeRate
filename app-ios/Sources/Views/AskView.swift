import SwiftUI

/// The native rebuild of the web inline picker (public/app.js `driveRenderAsk`): the
/// agent called our MCP `ask` tool and its turn is blocked until you choose. Renders
/// each question with single- or multi-select options plus a free-text "Other", and
/// hands back the aligned selections. Used in two places: inline in the transcript
/// (`DriveSessionView`) when the `ask` event streams in, and in `AskSheet` when you tap
/// the push notification that fires the moment the agent asks.
struct AskView: View {
    let questions: [AskQuestion]
    var submitting: Bool = false
    let onSubmit: ([AskSelection]) -> Void

    // Picked option labels per question index, and any free-text answer per question.
    @State private var picks: [Int: Set<String>] = [:]
    @State private var customs: [Int: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(questions.enumerated()), id: \.offset) { idx, q in
                questionBlock(idx, q)
            }
            Button(action: submit) {
                HStack(spacing: 8) {
                    if submitting { ProgressView().controlSize(.small) }
                    Text(submitting ? "Sending…" : "Send answer").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .disabled(submitting || !hasAnyAnswer)
        }
    }

    @ViewBuilder
    private func questionBlock(_ idx: Int, _ q: AskQuestion) -> some View {
        let multi = q.multiSelect ?? false
        VStack(alignment: .leading, spacing: 8) {
            if let h = q.header, !h.isEmpty {
                Text(h.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(q.question).font(.subheadline.weight(.medium))
            if multi {
                Text("Choose any that apply").font(.caption2).foregroundStyle(.tertiary)
            }
            ForEach(q.options ?? [], id: \.label) { opt in
                optionRow(idx, opt, multi: multi)
            }
            TextField("Other… (type your own answer)", text: customBinding(idx), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.footnote)
                .lineLimit(1...4)
        }
    }

    private func optionRow(_ idx: Int, _ opt: AskOption, multi: Bool) -> some View {
        let selected = picks[idx]?.contains(opt.label) ?? false
        let symbol = selected
            ? (multi ? "checkmark.square.fill" : "largecircle.fill.circle")
            : (multi ? "square" : "circle")
        return Button {
            toggle(idx, opt.label, multi: multi)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(opt.label).font(.subheadline)
                    if let d = opt.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }

    private func customBinding(_ idx: Int) -> Binding<String> {
        Binding(get: { customs[idx] ?? "" }, set: { customs[idx] = $0 })
    }

    private func toggle(_ idx: Int, _ label: String, multi: Bool) {
        var set = picks[idx] ?? []
        if multi {
            if set.contains(label) { set.remove(label) } else { set.insert(label) }
        } else {
            set = set.contains(label) ? [] : [label]   // tap-again clears a radio choice
        }
        picks[idx] = set
    }

    private var hasAnyAnswer: Bool {
        questions.indices.contains { idx in
            (picks[idx]?.isEmpty == false) ||
            !(customs[idx] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func submit() {
        let sels = questions.enumerated().map { idx, q -> AskSelection in
            let custom = (customs[idx] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return AskSelection(
                header: q.header,
                question: q.question,
                selectedLabels: Array(picks[idx] ?? []),
                customText: custom.isEmpty ? nil : custom
            )
        }
        onSubmit(sels)
    }
}

/// A modal selector presented when you tap the "your agent needs you" push notification
/// (the out-of-app path). Works from a cold launch / background — it doesn't depend on
/// the navigation stack: answer the question and the parked agent turn resumes.
struct AskSheet: View {
    let ask: AskRequest
    let onDone: () -> Void

    @State private var submitting = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private var token: String? { TokenStore.load() }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Label("Your agent needs you", systemImage: "questionmark.bubble.fill")
                        .font(.headline)
                    if let p = ask.projectSlug, !p.isEmpty {
                        Text(p).font(.caption).foregroundStyle(.secondary)
                    }
                    AskView(questions: ask.questions, submitting: submitting) { sels in
                        Task { await submit(sels) }
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
                .padding()
            }
            .navigationTitle("Choose")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Dismiss") { onDone(); dismiss() }
                }
            }
        }
    }

    private func submit(_ sels: [AskSelection]) async {
        submitting = true
        defer { submitting = false }
        do {
            _ = try await APIClient(token: token).answer(sessionId: ask.sessionId, askId: ask.askId, selections: sels)
            onDone()
            dismiss()
        } catch {
            self.error = apiMessage(error)
        }
    }
}
