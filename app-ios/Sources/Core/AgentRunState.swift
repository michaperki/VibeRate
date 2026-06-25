import SwiftUI

/// The one canonical "what is this agent doing right now" state, replacing the 5+ scattered
/// string switches the parity audit flagged (`PLAN_NATIVE_PARITY.md` §1). Every control that
/// depends on "is a turn in flight" — the busy-aware composer, the mid-turn queue, the Stop
/// button, the working row — keys off `busy` here, exactly as the web Drive keys off
/// `driveBusy()` (`public/app.js`). Mapping the raw server `status` string lives in exactly
/// one place now, so the cockpit row, the conversation row, and the Drive header can't drift.
enum AgentRunState {
    case starting   // process spawned, first event not yet streamed
    case working    // a turn is actively running
    case waiting    // the agent called the MCP ask picker and is blocked on you (still in-turn)
    case idle       // no turn in flight; ready for a message
    case error      // the last turn failed
    case done       // finished/ended

    /// Bucket the raw server status into the canonical state. Mirrors the web's
    /// `driveBusy()` plus the roster's status buckets — one source of truth.
    static func from(_ raw: String?) -> AgentRunState {
        switch raw {
        case "working", "running":                       return .working
        case "starting":                                 return .starting
        case "waiting", "waiting_for_input", "blocked":  return .waiting
        case "error", "failed":                          return .error
        case "done", "completed", "ended":               return .done
        default:                                         return .idle
        }
    }

    /// The single "is a turn in flight" predicate. `waiting` counts as busy — the child is
    /// alive and parked on an ask, so a follow-up should queue, not start a second turn
    /// (matches the web: `busy = working || starting || waiting`).
    var busy: Bool {
        switch self {
        case .working, .starting, .waiting: return true
        case .idle, .error, .done:          return false
        }
    }

    /// Short pill word for a roster/conversation row ("Working" / "Needs input" / …).
    var pill: String {
        switch self {
        case .working, .starting: return "Working"
        case .waiting:            return "Needs input"
        case .error:              return "Error"
        case .done:               return "Done"
        case .idle:               return "Idle"
        }
    }

    /// Plain-language label for the Drive header / working row — no operator jargon
    /// (memory: ui-copy-general-audience). The "…" signals an in-progress state.
    var human: String {
        switch self {
        case .working:  return "Working…"
        case .starting: return "Starting…"
        case .waiting:  return "Waiting for you"
        case .error:    return "Error"
        case .done:     return "Done"
        case .idle:     return "Idle"
        }
    }

    /// Status dot / pill tint, shared by every surface so the colour language is consistent.
    var color: Color {
        switch self {
        case .working, .starting: return .green
        case .waiting:            return .orange
        case .error:              return .red
        case .done, .idle:        return .secondary
        }
    }
}
