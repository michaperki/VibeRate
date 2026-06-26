import SwiftUI
import UIKit

/// A natively-selectable text view backed by a non-scrolling `UITextView`.
///
/// Why this exists: SwiftUI's `Text(…).textSelection(.enabled)` on iOS selects the *whole*
/// `Text` element at once and offers only a Copy/Share menu — it gives **no** draggable
/// grab-handles to pick an arbitrary sub-range. Reading a transcript needs real partial copy
/// (long-press → blue selection → drag the handles → copy exactly that span), and only UIKit's
/// `UITextView` provides it. We render message bodies through this shim instead.
///
/// Gesture coexistence: the text view is `isScrollEnabled = false`, so it owns *no* pan
/// recognizer — the enclosing SwiftUI `ScrollView` keeps vertical panning, while the text
/// view's long-press starts a selection. A drag scrolls the list; a long-press selects text.
/// No conflict with the peek/copy/brain interactions, which live on other views.
struct SelectableText: UIViewRepresentable {
    let attributed: NSAttributedString

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.isEditable = false
        tv.isSelectable = true            // long-press selection + grab-handles + edit menu
        tv.isScrollEnabled = false        // size to content; the outer ScrollView scrolls
        tv.backgroundColor = .clear
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        tv.dataDetectorTypes = [.link]    // tappable links survive; selection still works
        tv.adjustsFontForContentSizeCategory = true
        // Hug the content vertically so the SwiftUI row is exactly as tall as the text.
        tv.setContentCompressionResistancePriority(.required, for: .vertical)
        tv.setContentHuggingPriority(.required, for: .vertical)
        tv.attributedText = attributed
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        // Reassigning attributedText drops any in-progress selection, so only touch it on a
        // real change. (Streaming bubbles never reach here — they stay plain `Text` until the
        // block settles — so a live selection is never yanked out from under the user.)
        if tv.attributedText != attributed { tv.attributedText = attributed }
    }

    /// Self-size to the proposed width (iOS 16+). Without this a non-scrolling `UITextView`
    /// embedded in SwiftUI can report a zero/wrong height and truncate. Returning the *fitting*
    /// width (≤ the proposal) lets a short bubble hug its text instead of stretching full-width.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let maxW = proposal.width ?? UIScreen.main.bounds.width
        let fit = uiView.sizeThatFits(CGSize(width: maxW, height: .greatestFiniteMagnitude))
        return CGSize(width: min(ceil(fit.width), maxW), height: ceil(fit.height))
    }
}

// MARK: - Markdown → NSAttributedString

/// Renders parsed Markdown blocks to a flat `NSAttributedString` for `SelectableText`, so a
/// whole assistant reply selects *contiguously* (the headline requirement: drag a selection
/// across paragraphs and copy exactly that span). The SwiftUI `MarkdownView` block renderer
/// stays the source of block structure (`MarkdownParser.parse`) — this just flattens it.
///
/// Limitation by design: code blocks and tables carry chrome (mobile table cards, code
/// background) that a flat attributed string can't express, so a message containing either
/// takes `MarkdownView`'s per-block SwiftUI path instead (see `hasBlockChrome`). Plain prose,
/// headings, lists, and quotes — the common case — flatten here and get full partial-copy.
enum MarkdownNS {
    /// True when the message has a block that needs SwiftUI chrome (code fence or table) and
    /// therefore can't use the single-text-view contiguous-selection path.
    static func hasBlockChrome(_ blocks: [MDBlock]) -> Bool {
        blocks.contains {
            if case .code = $0 { return true }
            if case .table = $0 { return true }
            return false
        }
    }

    /// A plain (non-markdown) selectable run — used for user prompts, which the chat shows
    /// verbatim rather than formatted.
    static func plain(_ s: String, font: UIFont, color: UIColor) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
    }

    /// Flatten a no-chrome assistant message into one attributed string. Mirrors
    /// `MarkdownView`'s subheadline body sizing and bullet/number prefixes.
    static func whole(_ blocks: [MDBlock]) -> NSAttributedString {
        let body = UIFont.preferredFont(forTextStyle: .subheadline)
        let label = UIColor.label
        let secondary = UIColor.secondaryLabel
        let out = NSMutableAttributedString()

        for (i, block) in blocks.enumerated() {
            if i > 0 { out.append(NSAttributedString(string: "\n\n")) }
            switch block {
            case .paragraph(let s):
                out.append(inline(s, font: body, color: label))

            case .heading(let level, let s):
                out.append(inline(s, font: headingFont(level), color: label))

            case .bullets(let items):
                for (j, it) in items.enumerated() {
                    if j > 0 { out.append(NSAttributedString(string: "\n")) }
                    out.append(NSAttributedString(string: "•  ",
                                                  attributes: [.font: body, .foregroundColor: secondary]))
                    out.append(inline(it, font: body, color: label))
                }

            case .ordered(let items):
                for (j, it) in items.enumerated() {
                    if j > 0 { out.append(NSAttributedString(string: "\n")) }
                    out.append(NSAttributedString(string: "\(j + 1).  ",
                                                  attributes: [.font: body, .foregroundColor: secondary]))
                    out.append(inline(it, font: body, color: label))
                }

            case .quote(let s):
                let para = NSMutableParagraphStyle()
                para.firstLineHeadIndent = 8
                para.headIndent = 8
                // Quote text was `secondaryLabel` — a mid-gray that read noticeably harder
                // than the body in the lower half of a doc (UI review 2026-06-26). Bump it
                // a few steps: a softened label, not a muted gray. The indent stays the cue.
                let quoteColor = UIColor.label.withAlphaComponent(0.82)
                let q = NSMutableAttributedString(attributedString: inline(s, font: body, color: quoteColor))
                q.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: q.length))
                out.append(q)

            case .rule:
                out.append(NSAttributedString(string: "─────",
                                              attributes: [.font: body, .foregroundColor: UIColor.tertiaryLabel]))

            case .code, .table:
                break   // unreachable: hasBlockChrome routes these to the SwiftUI path
            }
        }
        return out
    }

    /// Inline spans (bold/italic/inline-code/links) via Foundation's Markdown parser, resolved
    /// to concrete UIKit font traits so they render — and stay selectable — in a `UITextView`.
    /// (`AttributedString(markdown:)` tags `inlinePresentationIntent`, which SwiftUI's `Text`
    /// interprets but `NSAttributedString` does not, so we apply the traits ourselves.)
    static func inline(_ s: String, font baseFont: UIFont, color: UIColor) -> NSAttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        guard let attr = try? AttributedString(markdown: s, options: opts) else {
            return NSAttributedString(string: s, attributes: [.font: baseFont, .foregroundColor: color])
        }
        let out = NSMutableAttributedString()
        for run in attr.runs {
            let text = String(attr[run.range].characters)
            var font = baseFont
            if let intent = run.inlinePresentationIntent {
                if intent.contains(.stronglyEmphasized) { font = font.addingTraits(.traitBold) }
                if intent.contains(.emphasized) { font = font.addingTraits(.traitItalic) }
                if intent.contains(.code) {
                    font = UIFont.monospacedSystemFont(ofSize: baseFont.pointSize * 0.94, weight: .regular)
                }
            }
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
            if let link = run.link {
                attrs[.link] = link
                attrs[.foregroundColor] = UIColor.link
            }
            out.append(NSAttributedString(string: text, attributes: attrs))
        }
        return out
    }

    /// Bold heading font matching `MarkdownView.headingFont`'s modest phone scale.
    private static func headingFont(_ level: Int) -> UIFont {
        let style: UIFont.TextStyle = level <= 1 ? .headline : (level == 2 ? .subheadline : .footnote)
        let f = UIFont.preferredFont(forTextStyle: style)
        guard let d = f.fontDescriptor.withSymbolicTraits(.traitBold) else { return f }
        return UIFont(descriptor: d, size: 0)
    }
}

private extension UIFont {
    /// Return this font with extra symbolic traits merged in (keeps the existing ones).
    func addingTraits(_ traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
        let merged = fontDescriptor.symbolicTraits.union(traits)
        guard let d = fontDescriptor.withSymbolicTraits(merged) else { return self }
        return UIFont(descriptor: d, size: 0)
    }
}
