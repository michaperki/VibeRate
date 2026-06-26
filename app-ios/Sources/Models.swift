import Foundation

/// The signed-in account (`GET /api/me`).
struct Me: Codable, Identifiable {
    let id: String
    let email: String?
    let name: String?
    let provider: String?
    let projectCount: Int?
}

/// A project in the owner's list (`GET /api/projects`). Only the fields the starter
/// renders are decoded — the server sends more, and unknown keys are ignored.
struct Project: Codable, Identifiable, Hashable {
    let slug: String
    let name: String?
    /// The server sends `sessions` as an ARRAY of captured sessions, not a count.
    /// (Decoding it as Int was the "[0].sessions expected Int, found array" error.)
    let sessions: [ProjectSession]?
    let visibility: String?
    let updatedAt: String?
    let streaming: Bool?

    var id: String { slug }
    var sessionCount: Int { sessions?.count ?? 0 }

    /// "3h ago" from the ISO `updatedAt` — the list's "when did I last touch this"
    /// answer (UI review 2026-06-26). nil when the server didn't send a parseable date.
    var updatedAgo: String? {
        guard let updatedAt, let date = Self.isoDate(updatedAt) else { return nil }
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .abbreviated
        return fmt.localizedString(for: date, relativeTo: Date())
    }

    /// Parse the server's ISO-8601 timestamp, with or without fractional seconds.
    private static func isoDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}

/// One captured session in a project's `sessions` list. The native client only needs
/// the count for the list badge; live Drive streaming uses `/api/agent/sessions`
/// instead, so the rest is decoded leniently (all optional).
struct ProjectSession: Codable, Hashable {
    let id: String?
    let title: String?
    let lastUserText: String?
    let startedAt: String?
    let endedAt: String?
}

/// A project's Drive workspace binding (`GET /api/agent/workspace/:slug`). A driven
/// session needs a checkout on the host; until one exists, `POST /api/agent/sessions`
/// 409s. `suggestedRepo` prefills the setup form (the repo the project was created from).
struct WorkspaceInfo: Codable {
    let workspace: WorkspaceState?
    let suggestedRepo: String?
    let name: String?
}

/// The clone state of a project's workspace. `status` walks `cloning → ready | error`;
/// the setup form polls `GET` until it leaves `cloning`. All optional — the server sends
/// more (`dir`, `head`, `updatedAt`) and unknown keys are ignored.
struct WorkspaceState: Codable {
    let status: String?
    let repo: String?
    let branch: String?
    let error: String?
}

/// A durable past Drive conversation in a project's workspace
/// (`GET /api/agent/workspace/:slug/sessions`), read from the on-disk claude
/// transcripts — so it survives the server redeploy that wipes the live in-memory
/// roster. `liveId`/`status` are present only when the conversation is *also* still
/// running in this process; otherwise it's resumed by `claudeSessionId` (adopt).
struct WorkspaceSession: Codable, Identifiable, Hashable {
    let claudeSessionId: String
    let title: String?
    let userTurns: Int?
    let startedAt: Double?
    let lastAt: Double?
    let liveId: String?
    let status: String?

    var id: String { claudeSessionId }
}

// MARK: - Ask (the MCP picker)

/// One choice in an `ask` question. The user can also answer with free text.
struct AskOption: Codable, Hashable {
    let label: String
    let description: String?
}

/// One question the agent put to you via the MCP `ask` tool (mirrors the web picker,
/// public/app.js `driveRenderAsk`). `options` may be empty/absent for a free-text-only
/// prompt; `multiSelect` allows picking more than one.
struct AskQuestion: Codable, Hashable, Identifiable {
    let question: String
    let header: String?
    let multiSelect: Bool?
    let options: [AskOption]?

    var id: String { (header ?? "") + "|" + question }
}

/// The `ask` SSE event payload (`{ kind:"ask", askId, questions:[…] }`). Extra frame
/// keys (`seq`, `t`, `kind`) are ignored on decode.
struct AskEvent: Codable {
    let askId: String
    let questions: [AskQuestion]
}

/// A pending question to answer — assembled from either the SSE `ask` event (in-app) or
/// a tapped push notification's `vbrt` payload (out-of-app). `sessionId` is the agent
/// session the answer POSTs to; `askId` is what `resolveAsk` keys on server-side.
struct AskRequest: Identifiable, Hashable {
    let askId: String
    let sessionId: String
    let projectSlug: String?
    let questions: [AskQuestion]

    var id: String { askId }
}

/// One answer, aligned to a question, in the shape the server's `formatAnswer` expects:
/// the picked option label(s) and/or a free-text note kept distinct.
struct AskSelection: Codable {
    let header: String?
    let question: String?
    let selectedLabels: [String]
    let customText: String?
}

/// A live/known Drive agent session (`GET /api/agent/sessions`).
struct AgentSession: Codable, Identifiable {
    let id: String
    let claudeSessionId: String?
    let codexSessionId: String?
    let type: String?
    let projectSlug: String?
    let cwd: String?
    let status: String?
}

/// One live agent on the cockpit "Now" roster. This is the enriched `publicView`
/// payload (PLAN_COCKPIT.md §3.1) — the same record the roster stream pushes in its
/// `snapshot`/`agent` frames and that `/api/agent/sessions` returns. Only the fields the
/// roster row renders are decoded; the server sends more and unknown keys are ignored.
struct RosterAgent: Codable, Identifiable, Hashable {
    let id: String
    let projectSlug: String?
    let status: String?
    let title: String?
    let type: String?
    let model: String?
    /// ms-epoch start of the current turn — the roster's elapsed timer ticks from this.
    let promptStartedAt: Double?
    let lastAction: LastAction?
    let currentPlan: String?   // inferred from touched files (tier 1)
    let declaredPlan: String?  // self-reported via the MCP `report` tool (ground truth)
    let ctxPct: Int?

    struct LastAction: Codable, Hashable {
        let verb: String?
        let label: String?
        let file: String?
    }

    /// Declared (self-reported) plan wins over the inferred one.
    var plan: String? { declaredPlan ?? currentPlan }
}

// MARK: - Brain docs (the .md network the agent steers through)

/// Coarse doc role, mirroring the web `docRole` (`public/app.js`): the constitution is
/// the brain's anchor; plans (checklists) get a completion ring; everything else is a
/// quiet reference node behind the `+N docs` toggle. PLAN_NATIVE_BRAIN.md B1/B3.
enum DocRole { case constitution, reference, memory }

/// A plan/checklist completion, mirroring the web `completionOf`. Non-monotonic by
/// design — discovery work legitimately pushes % down (PROJECT_VIEW_PLAN.md) — so it's
/// a per-doc ring, never a single headline bar.
struct DocCompletion: Hashable {
    let done: Int
    let total: Int
    var pct: Int { total == 0 ? 0 : Int((Double(done) / Double(total) * 100).rounded()) }
}

/// One brain doc (`GET /api/projects/:slug/docs`). The server returns
/// `{ capturedAt, docs: [{name, content, bytes, mtime}] }`; we decode the docs array and
/// compute the graph/rings/role client-side, exactly as the web centerpiece does — the
/// backend already serves this, so the brain is a pure client gap (PLAN_NATIVE_BRAIN.md).
struct BrainDoc: Codable, Identifiable, Hashable {
    let name: String
    let content: String?
    let bytes: Int?
    let mtime: Double?

    var id: String { name }

    /// Display basename — the repo-relative name's last path component.
    var base: String { name.split(separator: "/").last.map(String.init) ?? name }

    /// A clean, scannable node label (UI review 2026-06-26): drop the `.md` extension,
    /// strip the redundant `PLAN_` prefix (it's on every plan tile, eating the most
    /// legible space — promoted to the section header instead), and turn the
    /// SCREAMING_SNAKE name into spaced words so a long label wraps on spaces, never
    /// hyphenates mid-word ("PLAN_AGEN-T_RUNTIME.md"). "PLAN_AGENT_RUNTIME.md" → "AGENT RUNTIME".
    var displayLabel: String {
        var s = base
        if s.lowercased().hasSuffix(".md") { s = String(s.dropLast(3)) }
        if s.uppercased().hasPrefix("PLAN_") { s = String(s.dropFirst(5)) }
        s = s.replacingOccurrences(of: "_", with: " ")
        return s.isEmpty ? base : s
    }

    /// Checkbox completion — nil when the doc has no checklist (so it isn't a "plan").
    /// Mirrors the web regex `^[ \t>*+-]*\[([ xX])\]` over each line.
    var completion: DocCompletion? {
        guard let text = content,
              let re = try? NSRegularExpression(pattern: "(?m)^[ \\t>*+-]*\\[([ xX])\\]")
        else { return nil }
        let ns = text as NSString
        let matches = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return nil }
        let done = matches.filter {
            ns.substring(with: $0.range).range(of: "[xX]", options: .regularExpression) != nil
        }.count
        return DocCompletion(done: done, total: matches.count)
    }

    /// A doc with a checklist reads as a plan (gets a ring on the shelf).
    var isPlan: Bool { completion != nil }

    /// Coarse role, mirroring the web `docRole`.
    var role: DocRole {
        let b = base.uppercased()
        if b == "MEMORY.MD" { return .memory }
        if b.contains("SOUL")
            || ["AGENTS.MD", "AGENT.MD", "CLAUDE.MD", "CLAUDE.LOCAL.MD", "SEED.MD", "SEED_V2.MD"].contains(b) {
            return .constitution
        }
        return .reference
    }

    /// First heading / non-empty line, stripped of `#` — the summary shown under a node
    /// and at the top of a long-press peek.
    var summaryLine: String {
        guard let content else { return base }
        for raw in content.components(separatedBy: "\n") {
            let l = raw.trimmingCharacters(in: .whitespaces)
            if l.isEmpty { continue }
            return l.replacingOccurrences(of: "^#{1,6}\\s+", with: "", options: .regularExpression)
        }
        return base
    }

    /// A few lines for the long-press peek card (PLAN_NATIVE_BRAIN.md §3 — the touch home
    /// for the desktop hover-peek that can't exist on a phone).
    var peekText: String {
        guard let content else { return base }
        let lines = content.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.prefix(6).joined(separator: "\n")
    }
}
