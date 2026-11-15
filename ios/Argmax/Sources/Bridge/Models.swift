import Foundation

// The enums and containers around the dashboard rows. The rows themselves are
// in GeneratedWireResponses.swift, generated from the Rust bindings by
// `scripts/export-swift-contracts.mjs`. Only the fields the phone reads are
// there: everything else on the wire is ignored, which is what keeps a host
// that grows a column from breaking this app.
//
// Two rules make that tolerance real, and both are load-bearing:
//
//   1. Unknown keys are ignored — Codable's default, so nothing to write.
//   2. Unknown enum strings decode to `.unknown(raw)` rather than throwing.
//      A host that adds a session state must not blank the phone's chat list.
//
// Timestamps stay `String`. They are ISO-8601 UTC on the wire and the merge
// and sort rules compare them as strings, exactly as the renderer does; a
// `Date` round-trip would only invite a formatter to disagree with the host.

/// A wire enum that keeps values it does not recognise instead of failing.
///
/// The `unknown` case carries the raw string so a row can still be grouped,
/// logged, and sent back unchanged.
protocol OpenWireEnum: Codable, Hashable, Sendable, CustomStringConvertible {
    init(rawWire: String)
    var rawWire: String { get }
}

extension OpenWireEnum {
    init(from decoder: Decoder) throws {
        self.init(rawWire: try decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawWire)
    }

    var description: String { rawWire }
}

/// `SessionState` in `src/shared/bindings.d.ts`.
enum SessionState: OpenWireEnum {
    case created
    case running
    case waiting
    case blocked
    case complete
    case failed
    case cancelled
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "created": self = .created
        case "running": self = .running
        case "waiting": self = .waiting
        case "blocked": self = .blocked
        case "complete": self = .complete
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .created: return "created"
        case .running: return "running"
        case .waiting: return "waiting"
        case .blocked: return "blocked"
        case .complete: return "complete"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .unknown(let raw): return raw
        }
    }
}

/// `AttentionState` in `src/shared/bindings.d.ts`. `normal` is "nothing to
/// say"; every other value is a claim on the reader that the Priority rules
/// rank (`Sources/Chats/ChatSections.swift`).
enum AttentionState: OpenWireEnum {
    case normal
    case blocked
    case failed
    case reviewReady
    case questionAsked
    case approvalNeeded
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "normal": self = .normal
        case "blocked": self = .blocked
        case "failed": self = .failed
        case "review-ready": self = .reviewReady
        case "question-asked": self = .questionAsked
        case "approval-needed": self = .approvalNeeded
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .normal: return "normal"
        case .blocked: return "blocked"
        case .failed: return "failed"
        case .reviewReady: return "review-ready"
        case .questionAsked: return "question-asked"
        case .approvalNeeded: return "approval-needed"
        case .unknown(let raw): return raw
        }
    }
}

/// `WorkspaceState` in `src/shared/types.ts`. Wider than `SessionState`: a
/// workspace outlives its chats and carries the archive lifecycle.
enum WorkspaceState: OpenWireEnum {
    case created
    case running
    case waiting
    case blocked
    case complete
    case failed
    case cancelled
    case archiving
    case archiveFailed
    case kept
    case archived
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "created": self = .created
        case "running": self = .running
        case "waiting": self = .waiting
        case "blocked": self = .blocked
        case "complete": self = .complete
        case "failed": self = .failed
        case "cancelled": self = .cancelled
        case "archiving": self = .archiving
        case "archive-failed": self = .archiveFailed
        case "kept": self = .kept
        case "archived": self = .archived
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .created: return "created"
        case .running: return "running"
        case .waiting: return "waiting"
        case .blocked: return "blocked"
        case .complete: return "complete"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case .archiving: return "archiving"
        case .archiveFailed: return "archive-failed"
        case .kept: return "kept"
        case .archived: return "archived"
        case .unknown(let raw): return raw
        }
    }
}

/// `WorkspaceKind` in `src/shared/types.ts`. `git` is a real checkout,
/// `scratch` a repo-less side chat, `popup` the ephemeral "More details"
/// workspace the list never shows.
enum WorkspaceKind: OpenWireEnum {
    case git
    case scratch
    case popup
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "git": self = .git
        case "scratch": self = .scratch
        case "popup": self = .popup
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .git: return "git"
        case .scratch: return "scratch"
        case .popup: return "popup"
        case .unknown(let raw): return raw
        }
    }
}

/// Stable id of the hidden singleton project every side chat belongs to.
/// Mirrors `SCRATCH_PROJECT_ID` in `src/shared/types.ts`; the host names it
/// "Chat", which is the label a repo-less chat's row wears.
let scratchProjectID = "scratch-side-chats"

/// The four slices of `DashboardSnapshot` the phone keeps.
///
/// The host also sends `events`, `rawOutputs`, `approvals`, `checks` and
/// `pendingMessages`; the transcript is a web view, so none of them have a
/// native reader yet and all of them decode to nothing here.
struct DashboardSnapshot: Codable, Hashable, Sendable {
    var projects: [ProjectSummary]
    var workspaces: [WorkspaceSummary]
    var sessions: [SessionSummary]
    /// Deltas never carry arc rows. An arc write publishes a
    /// `dashboardChanged` hint instead, and the reload it causes brings them.
    var arcs: [ArcSummary]

    init(
        projects: [ProjectSummary] = [],
        workspaces: [WorkspaceSummary] = [],
        sessions: [SessionSummary] = [],
        arcs: [ArcSummary] = []
    ) {
        self.projects = projects
        self.workspaces = workspaces
        self.sessions = sessions
        self.arcs = arcs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // A slice the host omits is "no rows", not a malformed payload:
        // `workspace:status` and `dashboard:list` differ in which they carry.
        projects = try container.decodeIfPresent([ProjectSummary].self, forKey: .projects) ?? []
        workspaces = try container.decodeIfPresent([WorkspaceSummary].self, forKey: .workspaces) ?? []
        sessions = try container.decodeIfPresent([SessionSummary].self, forKey: .sessions) ?? []
        // Also absent from a snapshot this app cached before it read arcs.
        arcs = try container.decodeIfPresent([ArcSummary].self, forKey: .arcs) ?? []
    }
}
