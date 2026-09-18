import Foundation

// Arcs over the bridge: the dashboard's `ArcSummary` rows, and the three
// `arc:*` channels the Arc screen calls. Mirrors of `src/shared/bindings.d.ts`,
// in the same camelCase, trimmed to what the phone reads.
//
// `arc:list`, `arc:get` and `arc:timeline` are reads
// (`src/shared/remoteReadChannels.json`). A Mac running a build from before
// they were listed refuses them for want of an operation id, which the
// screen shows as the host's own message.

/// `ArcState`.
enum ArcState: OpenWireEnum {
    case active
    case paused
    case done
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "active": self = .active
        case "paused": self = .paused
        case "done": self = .done
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .active: return "active"
        case .paused: return "paused"
        case .done: return "done"
        case .unknown(let raw): return raw
        }
    }

    var label: String {
        switch self {
        case .active: return "Active"
        case .paused: return "Paused"
        case .done: return "Done"
        case .unknown(let raw): return raw.capitalized
        }
    }
}

/// `ArcSummary` — the dashboard's row for one Arc.
struct ArcSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var state: ArcState
    var homeProjectId: String
    var coordinatorSessionId: String?
    var memberCount: Int
    var updatedAt: String
    /// When the newest timeline row was recorded.
    var lastEventAt: String?
}

/// `ArcRecord`, without `dir`: the phone has no Finder to reveal it in.
struct ArcRecord: Decodable, Hashable, Sendable {
    var id: String
    var name: String
    var brief: String
    var state: ArcState
    var homeProjectId: String
    var coordinatorSessionId: String?
    var createdAt: String
    var updatedAt: String
}

/// `ArcMemberSummary`.
struct ArcMemberSummary: Decodable, Hashable, Sendable, Identifiable {
    var sessionId: String
    var taskLabel: String
    var projectName: String
    var workspaceId: String
    var state: SessionState
    var provider: String
    var modelLabel: String?
    var isCoordinator: Bool
    var prNumber: Int?
    var prState: String?

    var id: String { sessionId }
}

/// `ArcLimits`.
struct ArcLimits: Decodable, Hashable, Sendable {
    var maxActiveMembers: Int
    var maxLaunchesPerDay: Int
}

/// `ArcDetail` — `arc:get`'s answer.
struct ArcDetail: Decodable, Hashable, Sendable {
    var arc: ArcRecord
    var members: [ArcMemberSummary]
    var membersTruncated: Bool
    var launchesLast24h: Int
    var limits: ArcLimits
}

/// `ArcEventKind`.
enum ArcEventKind: OpenWireEnum {
    case created
    case coordinatorStarted
    case memberLaunched
    case memberFinished
    case prChecksFailing
    case prChecksPassing
    case prMerged
    case notesUpdated
    case briefUpdated
    case stateChanged
    case scheduledRun
    case unknown(String)

    private static let known: [(ArcEventKind, String)] = [
        (.created, "created"),
        (.coordinatorStarted, "coordinator_started"),
        (.memberLaunched, "member_launched"),
        (.memberFinished, "member_finished"),
        (.prChecksFailing, "pr_checks_failing"),
        (.prChecksPassing, "pr_checks_passing"),
        (.prMerged, "pr_merged"),
        (.notesUpdated, "notes_updated"),
        (.briefUpdated, "brief_updated"),
        (.stateChanged, "state_changed"),
        (.scheduledRun, "scheduled_run")
    ]

    init(rawWire: String) {
        self = Self.known.first { $0.1 == rawWire }?.0 ?? .unknown(rawWire)
    }

    var rawWire: String {
        if case .unknown(let raw) = self { return raw }
        return Self.known.first { $0.0 == self }?.1 ?? ""
    }
}

/// `ArcTimelineEvent`.
struct ArcTimelineEvent: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var seq: Int
    var kind: ArcEventKind
    var occurredAt: String
    var sessionId: String?
    /// Whether the session still exists on the Mac.
    var sessionAvailable: Bool
    var projectName: String?
    var title: String
    var detail: String?
    var status: String?
    var prNumber: Int?
    var prUrl: String?
}

/// `ArcTimelineCursor` — the last row of the previous page.
struct ArcTimelineCursor: Codable, Hashable, Sendable {
    var occurredAt: String
    var seq: Int
}

/// `ArcTimelinePage`.
struct ArcTimelinePage: Decodable, Hashable, Sendable {
    var events: [ArcTimelineEvent]
    var nextCursor: ArcTimelineCursor?
}

// MARK: - Inputs

/// `ArcGetInput`.
struct ArcGetInput: Encodable, Sendable {
    var id: String
}

/// `ArcTimelineInput`. `before` is nil for the newest page, and goes out as
/// `null` the way the desktop sends it.
struct ArcTimelineInput: Encodable, Sendable {
    var arcId: String
    var before: ArcTimelineCursor?
    var limit: Int

    enum CodingKeys: String, CodingKey {
        case arcId, before, limit
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(arcId, forKey: .arcId)
        try container.encodeAlways(before, forKey: .before)
        try container.encode(limit, forKey: .limit)
    }
}

/// `ArcSetStateInput`.
struct ArcSetStateInput: Encodable, Sendable {
    var id: String
    var state: ArcState
}

// MARK: - Calls

extension BridgeClient {
    func arcDetail(id: String) async throws -> ArcDetail {
        try await request("arc:get", input: ArcGetInput(id: id), as: ArcDetail.self)
    }

    func arcTimeline(arcID: String, before: ArcTimelineCursor?, limit: Int) async throws -> ArcTimelinePage {
        try await request(
            "arc:timeline",
            input: ArcTimelineInput(arcId: arcID, before: before, limit: limit),
            as: ArcTimelinePage.self
        )
    }

    /// A mutation: it carries an operation id and is never retried.
    func setArcState(id: String, state: ArcState) async throws -> ArcRecord {
        try await request("arc:set-state", input: ArcSetStateInput(id: id, state: state), as: ArcRecord.self)
    }
}

// MARK: - Which arcs the phone lists

/// The arcs the chat list shows: live ones only, active ahead of paused, most
/// recently touched first within each — the desktop sidebar's order, minus
/// the done arcs a phone has nothing to do with.
func liveArcs(_ arcs: [ArcSummary]) -> [ArcSummary] {
    func rank(_ state: ArcState) -> Int? {
        switch state {
        case .active: return 0
        case .paused: return 1
        case .done, .unknown: return nil
        }
    }
    return arcs
        .filter { rank($0.state) != nil }
        .sorted { left, right in
            let leftRank = rank(left.state) ?? 0, rightRank = rank(right.state) ?? 0
            return leftRank != rightRank ? leftRank < rightRank : left.updatedAt > right.updatedAt
        }
}

/// A session that is not going anywhere without a new turn. The desktop Arc
/// page's `SETTLED_STATES`.
func isSettled(_ state: SessionState) -> Bool {
    switch state {
    case .complete, .failed, .cancelled: return true
    default: return false
    }
}
