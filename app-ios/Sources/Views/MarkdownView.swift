import SwiftUI

/// Renders assistant Markdown to native SwiftUI views — the native counterpart to the
/// web `renderMarkdown` (`public/app.js`). Why this exists: SwiftUI's `Text(_ String)`
/// renders a *runtime* String verbatim (only string **literals** are parsed as Markdown
/// via `LocalizedStringKey`), so assistant bubbles showed raw `**bold**`, backticked
/// `` `code` ``, and pipe-tables instead of formatting. This parses block-level structure
/// (fenced code, headings, lists, blockquotes, hr, tables) and uses `AttributedString`
/// for inline spans (bold, italic, inline code, links).
///
/// Streamed and backfilled assistant text share this one path — both populate a
/// `.assistant` bubble whose text flows here — so they render identically.
struct MarkdownView: View {
    let text: String

    var body: some View {
        let blocks = MarkdownParser.parse(text)
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { item in
                blockView(item.element)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Assistant body text was rendering at full .body (17pt) — slightly smaller reads
        // better in a phone bubble and lets more words fit per line. Headings override.
        .font(.subheadline)
    }

    @ViewBuilder
    private func blockView(_ block: MDBlock) -> some View {
        switch block {
        case .paragraph(let s):
            Text(MarkdownParser.inline(s))
                .fixedSize(horizontal: false, vertical: true)

        case .heading(let level, let s):
            Text(MarkdownParser.inline(s))
                .font(headingFont(level))
                .bold()
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)

        case .code(let code):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .bullets(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { it in
                    HStack(alignment: .top, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(MarkdownParser.inline(it.element))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .ordered(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { it in
                    HStack(alignment: .top, spacing: 6) {
                        Text("\(it.offset + 1).")
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        Text(MarkdownParser.inline(it.element))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .quote(let s):
            HStack(alignment: .top, spacing: 8) {
                Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3)
                Text(MarkdownParser.inline(s))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        case .rule:
            Divider()

        case .table(let headers, let rows):
            tableView(headers: headers, rows: rows)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3
        case 2: return .headline
        case 3: return .subheadline
        default: return .footnote
        }
    }

    /// Mobile table handler: stack each row into a labelled key/value card. This mirrors
    /// the web's `data-label` CSS that collapses multi-column tables on a narrow viewport
    /// (`public/app.js` md-table) — far more legible on a phone than squeezing N columns.
    @ViewBuilder
    private func tableView(headers: [String], rows: [[String]]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { rowItem in
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(rowItem.element.enumerated()), id: \.offset) { cellItem in
                        HStack(alignment: .top, spacing: 6) {
                            Text(headers.indices.contains(cellItem.offset) ? headers[cellItem.offset] : "")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Text(MarkdownParser.inline(cellItem.element))
                                .font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// MARK: - Parser

/// One block-level Markdown element. Mirrors the cases the web `renderMarkdown` emits.
enum MDBlock {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(String)
    case bullets([String])
    case ordered([String])
    case quote(String)
    case rule
    case table(headers: [String], rows: [[String]])
}

/// Block-level Markdown parser ported from `renderMarkdown` in `public/app.js`, so the
/// native client and the browser agree on what a transcript looks like. Inline spans are
/// delegated to `AttributedString`'s Markdown parser (bold/italic/code/links).
enum MarkdownParser {
    static func parse(_ md: String) -> [MDBlock] {
        let lines = md.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MDBlock] = []
        var i = 0

        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)

            // Fenced code block: ``` … ```
            if t.hasPrefix("```") {
                i += 1
                var code: [String] = []
                while i < lines.count && !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                if i < lines.count { i += 1 } // consume closing fence
                blocks.append(.code(code.joined(separator: "\n")))
                continue
            }

            // Blank line — paragraph/list separator.
            if t.isEmpty { i += 1; continue }

            // Horizontal rule.
            if isRule(t) { blocks.append(.rule); i += 1; continue }

            // Heading (#…######).
            if let h = heading(t) { blocks.append(.heading(level: h.0, text: h.1)); i += 1; continue }

            // Blockquote — merge consecutive `>` lines into one block.
            if t.hasPrefix(">") {
                var quoted: [String] = []
                while i < lines.count {
                    let qt = lines[i].trimmingCharacters(in: .whitespaces)
                    guard qt.hasPrefix(">") else { break }
                    quoted.append(stripQuote(qt))
                    i += 1
                }
                blocks.append(.quote(quoted.joined(separator: " ")))
                continue
            }

            // GitHub-style table: a `| … |` header followed by a `| --- | :--: |` delimiter.
            if t.contains("|"), i + 1 < lines.count,
               isTableDelimiter(lines[i + 1].trimmingCharacters(in: .whitespaces)) {
                let headers = tableCells(t)
                i += 2 // consume header + delimiter
                var rows: [[String]] = []
                while i < lines.count,
                      lines[i].contains("|"),
                      !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(tableCells(lines[i])); i += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            // Unordered list — gather consecutive items.
            if isBullet(line) {
                var items: [String] = []
                while i < lines.count, let item = bulletItem(lines[i]) {
                    items.append(item); i += 1
                }
                blocks.append(.bullets(items))
                continue
            }

            // Ordered list.
            if isOrdered(line) {
                var items: [String] = []
                while i < lines.count, let item = orderedItem(lines[i]) {
                    items.append(item); i += 1
                }
                blocks.append(.ordered(items))
                continue
            }

            // Paragraph — merge soft-wrapped continuation lines (matches the web).
            var para = t
            i += 1
            while i < lines.count {
                let n = lines[i]
                let nt = n.trimmingCharacters(in: .whitespaces)
                if nt.isEmpty || nt.hasPrefix("```") || heading(nt) != nil || nt.hasPrefix(">")
                    || isBullet(n) || isOrdered(n) || isRule(nt) { break }
                para += " " + nt
                i += 1
            }
            blocks.append(.paragraph(para))
        }
        return blocks
    }

    /// Inline spans (bold/italic/inline-code/links) via AttributedString's Markdown
    /// parser, preserving whitespace and not interpreting block syntax. Falls back to
    /// the raw string if parsing fails (e.g. an unbalanced marker).
    static func inline(_ s: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace)
        if let parsed = try? AttributedString(markdown: s, options: options) {
            return parsed
        }
        return AttributedString(s)
    }

    // MARK: line classifiers (regex mirrors the web)

    private static func isRule(_ s: String) -> Bool {
        s.range(of: "^(-{3,}|\\*{3,}|_{3,})$", options: .regularExpression) != nil
    }

    private static func heading(_ s: String) -> (Int, String)? {
        guard let r = s.range(of: "^#{1,6}\\s+", options: .regularExpression) else { return nil }
        let level = s[r].prefix(while: { $0 == "#" }).count
        return (level, String(s[r.upperBound...]))
    }

    private static func stripQuote(_ s: String) -> String {
        String(s.drop(while: { $0 == ">" })).trimmingCharacters(in: .whitespaces)
    }

    private static func isTableDelimiter(_ s: String) -> Bool {
        s.range(of: "^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)+\\|?\\s*$",
                options: .regularExpression) != nil
    }

    private static func tableCells(_ row: String) -> [String] {
        var r = row.trimmingCharacters(in: .whitespaces)
        if r.hasPrefix("|") { r.removeFirst() }
        if r.hasSuffix("|") { r.removeLast() }
        return r.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func bulletItem(_ line: String) -> String? {
        guard let r = line.range(of: "^\\s*[-*+]\\s+", options: .regularExpression) else { return nil }
        return String(line[r.upperBound...])
    }
    private static func isBullet(_ line: String) -> Bool { bulletItem(line) != nil }

    private static func orderedItem(_ line: String) -> String? {
        guard let r = line.range(of: "^\\s*\\d+[.)]\\s+", options: .regularExpression) else { return nil }
        return String(line[r.upperBound...])
    }
    private static func isOrdered(_ line: String) -> Bool { orderedItem(line) != nil }
}
