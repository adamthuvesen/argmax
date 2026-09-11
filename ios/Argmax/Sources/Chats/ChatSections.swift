import Foundation

// The chat list's three sections, ported from the renderer so the phone and
// the Mac agree on what needs the reader:
//
//   src/renderer/lib/multitask.ts   — which workspaces have no row of their own
//   src/renderer/lib/priority.ts    — why a row is in Priority, and for how long
//   src/renderer/mobile/MobileApp.tsx — Pinned / Priority / Chats, in that order
//
// A row lives in exactly one section. Pinned wins over everything (a pin is a
// standing placement), then Priority, then plain activity order.

// MARK: - Multitask linkage

/// `launchKind` of a chat one chat dispatched from inside another.
let multitaskLaunchKind = "multitask"

func isMultitask(_ session: SessionSummary) -> Bool {
    session.launchKind == multitaskLaunchKind
}

/// Workspaces with no list row: a multitask belongs to the chat that
/// dispatched it, which shows it in its own agent view.
///
/// An orphan is the exception — with its launching chat gone from the
/// snapshot there is nowhere left to reach it from, so it comes back to the
/// list rather than disappearing with its uncommitted work.
func hiddenMultitaskWorkspaceIDs(_ sessions: [SessionSummary]) -> Set<String> {
    let sessionIDs = Set(sessions.map(\.id))
    var hidden: Set<String> = []
    for session in sessions where isMultitask(session) {
        if let launcher = session.launchedBySessionId, sessionIDs.contains(launcher) {
            hidden.insert(session.workspaceId)
        }
    }
    return hidden
}

/// The workspaces of chats that dispatched a multitask still mid-turn.
///
/// Without this the list goes calm the moment the parent's own turn ends,
/// while a sibling agent is still writing to the same checkout.
func workspacesWithRunningMultitask(_ sessions: [SessionSummary]) -> Set<String> {
    var workspaceBySession: [String: String] = [:]
    for session in sessions { workspaceBySession[session.id] = session.workspaceId }
    var working: Set<String> = []
    for session in sessions where isMultitask(session) && session.state == .running {
        if let launcher = session.launchedBySessionId, let workspaceID = workspaceBySession[launcher] {
            working.insert(workspaceID)
        }
    }
    return working
}

/// Workspaces with a turn in flight — their own, or a multitask they
/// dispatched.
func workingWorkspaceIDs(_ sessions: [SessionSummary]) -> Set<String> {
    var working = workspacesWithRunningMultitask(sessions)
    for session in sessions where session.state == .running {
        working.insert(session.workspaceId)
    }
    return working
}

// MARK: - Priority

/// Why a workspace is in the Priority section.
///
/// One value and one clock made the section a recency feed: `review-ready` is
/// what every completed turn earns, and thirty minutes of silence cleared
/// everything, including the things silence does not resolve. A reason
/// carries its own answer to "what makes this go away".
enum PriorityReasonKind: String, Hashable, Sendable {
    case approvalNeeded = "approval-needed"
    case questionAsked = "question-asked"
    case blocked
    case failed
    case ciRed = "ci-red"
    case reviewReady = "review-ready"
    case prOpen = "pr-open"

    /// Triage order. Stalled-on-you beats asked-you beats broken beats
    /// ready-to-look-at, and a pull request merely being open is the weakest
    /// claim on the person there is — it is a state, not a request.
    var rank: Int {
        switch self {
        case .approvalNeeded: return 7
        case .questionAsked: return 6
        case .blocked: return 5
        case .failed: return 4
        case .ciRed: return 3
        case .reviewReady: return 2
        case .prOpen: return 1
        }
    }

    /// The reasons that are also a session attention value, so a row can wear
    /// one. The PR-shaped reasons are not: the row draws those on its marker.
    var attention: AttentionState? {
        switch self {
        case .approvalNeeded: return .approvalNeeded
        case .questionAsked: return .questionAsked
        case .blocked: return .blocked
        case .failed: return .failed
        case .reviewReady: return .reviewReady
        case .ciRed, .prOpen: return nil
        }
    }

    init?(attention: AttentionState) {
        switch attention {
        case .approvalNeeded: self = .approvalNeeded
        case .questionAsked: self = .questionAsked
        case .blocked: self = .blocked
        case .failed: self = .failed
        case .reviewReady: self = .reviewReady
        case .normal, .unknown: return nil
        }
    }
}

struct PriorityReason: Hashable, Sendable {
    var kind: PriorityReasonKind
    /// When this reason became current. A "Done" is spent once a reason newer
    /// than it appears, so every reason has to say when it started.
    var since: String
    /// When it lapses on its own, or nil when only the thing it names can
    /// clear it. An unanswered question does not expire; an unread reply does.
    var idleAt: Date?
}

/// A reply nobody has read yet is history after this long. Only the reasons a
/// clock can resolve use it: an approval, an unanswered question, a red check
/// and an open pull request are all still true half an hour later.
let priorityIdleInterval: TimeInterval = 30 * 60

struct PriorityEntry: Sendable {
    var workspace: WorkspaceSummary
    /// Live, undismissed reasons, strongest first.
    var reasons: [PriorityReason]
    /// The strongest reason, which is what the row says about itself.
    var reason: PriorityReasonKind?
    var working: Bool
}

/// The session whose attention speaks for the workspace, if any does.
private struct LoudestSession {
    var kind: PriorityReasonKind
    var changedAt: String?
    var lastActivityAt: String
}

private func loudestSessions(_ sessions: [SessionSummary]) -> [String: LoudestSession] {
    var byWorkspace: [String: LoudestSession] = [:]
    for session in sessions {
        guard let kind = PriorityReasonKind(attention: session.attention) else { continue }
        if let current = byWorkspace[session.workspaceId],
           current.kind.rank > kind.rank
               || (current.kind.rank == kind.rank && current.lastActivityAt >= session.lastActivityAt) {
            continue
        }
        byWorkspace[session.workspaceId] = LoudestSession(
            kind: kind,
            changedAt: session.attentionChangedAt,
            lastActivityAt: session.lastActivityAt
        )
    }
    return byWorkspace
}

/// A dismissal ("mark as done") covers every reason that was already true
/// when it was made, and nothing since. A reason with no timestamp of its own
/// is treated as older than any dismissal, so stale rows stay dismissible.
private func isDismissed(_ workspace: WorkspaceSummary, since: String?) -> Bool {
    guard let dismissedAt = workspace.priorityDismissedAt else { return false }
    guard let since else { return true }
    return dismissedAt >= since
}

private func isInPlay(_ workspace: WorkspaceSummary) -> Bool {
    workspace.state != .archived && workspace.state != .kept
}

/// Every live, undismissed reason per workspace, strongest first.
///
/// `unreadWorkspaceIDs` is this phone's own reading state and nil means "not
/// tracked yet", which reads every row as unread — the same default the
/// renderer's optional parameter has.
func computeWorkspaceReasons(
    workspaces: [WorkspaceSummary],
    sessions: [SessionSummary],
    now: Date,
    unreadWorkspaceIDs: Set<String>? = nil
) -> [String: [PriorityReason]] {
    let loudest = loudestSessions(sessions)
    let working = workingWorkspaceIDs(sessions)
    var result: [String: [PriorityReason]] = [:]

    for workspace in workspaces where isInPlay(workspace) {
        var reasons: [PriorityReason] = []

        // A nil `changedAt` is a row from before the column existed.
        // Admitting those would flood the section on first launch with every
        // chat that ever failed, so they stay out until attention next moves.
        if let found = loudest[workspace.id], let changedAt = found.changedAt {
            // Once the reply has been read there is nothing left to review,
            // so the weakest reason drops on sight rather than waiting out a
            // clock.
            let stillUnread = unreadWorkspaceIDs?.contains(workspace.id) ?? true
            let wanted = found.kind != .reviewReady || stillUnread
            // Only the reasons a clock resolves carry a deadline.
            let clocked = found.kind != .approvalNeeded && found.kind != .questionAsked
            let ages = clocked && !working.contains(workspace.id)
            let idleAt = ages ? idleDeadline(found.lastActivityAt) : nil
            let lapsed = ages && (idleAt == nil || now > idleAt!)
            if wanted && !lapsed {
                reasons.append(PriorityReason(kind: found.kind, since: changedAt, idleAt: idleAt))
            }
        }

        // A pull request is the workspace's business, not any one session's,
        // and it outlives the turn that opened it. `prActivityAt` is both
        // what a dismissal is measured against and the proof the poller
        // actually saw this state.
        if workspace.prState == "OPEN", let prActivityAt = workspace.prActivityAt {
            if workspace.prCheckState == "failure" {
                reasons.append(PriorityReason(kind: .ciRed, since: prActivityAt, idleAt: nil))
            }
            reasons.append(PriorityReason(kind: .prOpen, since: prActivityAt, idleAt: nil))
        }

        let live = workspace.priorityAddedAt != nil
            ? reasons
            : reasons.filter { !isDismissed(workspace, since: $0.since) }
        guard !live.isEmpty else { continue }
        result[workspace.id] = live.sorted { $0.kind.rank > $1.kind.rank }
    }
    return result
}

/// Fresh, undismissed attention per workspace — the strongest reason a row
/// can wear as its own state.
func computeWorkspaceAttention(
    workspaces: [WorkspaceSummary],
    sessions: [SessionSummary],
    now: Date,
    unreadWorkspaceIDs: Set<String>? = nil
) -> [String: AttentionState] {
    let loudest = loudestSessions(sessions)
    let reasons = computeWorkspaceReasons(
        workspaces: workspaces,
        sessions: sessions,
        now: now,
        unreadWorkspaceIDs: unreadWorkspaceIDs
    )
    var result: [String: AttentionState] = [:]
    for (workspaceID, workspaceReasons) in reasons {
        guard let top = workspaceReasons.first(where: { $0.kind.attention != nil }),
              let attention = top.kind.attention,
              loudest[workspaceID] != nil
        else { continue }
        result[workspaceID] = attention
    }
    return result
}

/// Workspaces that need the reader right now: a live reason, a turn in
/// flight, or a manual add.
///
/// Sorting is working rows first, then by the strength of the strongest
/// reason, then by last message descending, then by id so the order is total.
func computePriorityEntries(
    workspaces: [WorkspaceSummary],
    sessions: [SessionSummary],
    now: Date,
    unreadWorkspaceIDs: Set<String>? = nil
) -> [PriorityEntry] {
    let reasonsByWorkspace = computeWorkspaceReasons(
        workspaces: workspaces,
        sessions: sessions,
        now: now,
        unreadWorkspaceIDs: unreadWorkspaceIDs
    )
    let working = workingWorkspaceIDs(sessions)

    var entries: [PriorityEntry] = []
    for workspace in workspaces {
        // A pin is a standing placement, so it wins over both a reason and a
        // manual add; keeping or archiving is an explicit "I'm done here".
        switch workspace.state {
        case .archived, .kept, .archiving, .archiveFailed: continue
        default: break
        }
        if workspace.pinned { continue }
        let reasons = reasonsByWorkspace[workspace.id] ?? []
        let isWorking = working.contains(workspace.id)
        let manuallyAdded = workspace.priorityAddedAt != nil
        if reasons.isEmpty && !isWorking && !manuallyAdded { continue }
        entries.append(
            PriorityEntry(
                workspace: workspace,
                reasons: reasons,
                reason: reasons.first?.kind,
                working: isWorking
            )
        )
    }

    return entries.sorted { left, right in
        if left.working != right.working { return left.working }
        let byReason = (right.reason?.rank ?? 0) - (left.reason?.rank ?? 0)
        if byReason != 0 { return byReason < 0 }
        if left.workspace.lastActivityAt != right.workspace.lastActivityAt {
            return left.workspace.lastActivityAt > right.workspace.lastActivityAt
        }
        return left.workspace.id < right.workspace.id
    }
}

/// When a quiet reason ages out; nil when its last message is unreadable.
private func idleDeadline(_ lastActivityAt: String) -> Date? {
    parseWireTimestamp(lastActivityAt).map { $0.addingTimeInterval(priorityIdleInterval) }
}

/// Wire timestamps are ISO-8601 UTC, usually with milliseconds and sometimes
/// without — SQLite rows written before the column carried them.
func parseWireTimestamp(_ text: String) -> Date? {
    if let date = ISO8601DateFormatter.withMilliseconds.date(from: text) { return date }
    return ISO8601DateFormatter.wholeSeconds.date(from: text)
}

extension ISO8601DateFormatter {
    static let withMilliseconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let wholeSeconds = ISO8601DateFormatter()
}

// MARK: - Sections

/// One chat, as the list draws it.
struct ChatRow: Identifiable, Hashable, Sendable {
    var workspace: WorkspaceSummary
    /// The chat this row opens. A workspace without one is a dead row and
    /// never reaches here.
    var session: SessionSummary
    /// The project's name, or "Side chats" for a scratch workspace, which is
    /// what the hidden singleton project is called.
    var projectName: String?
    /// The attention the row wears, or nil when it has nothing to say.
    var attention: AttentionState?
    /// A turn is in flight here, or in a multitask this chat dispatched.
    var working: Bool

    var id: String { workspace.id }
}

/// Pinned on top, then Priority, then everything else newest first.
struct ChatSections: Hashable, Sendable {
    var pinned: [ChatRow] = []
    var priority: [ChatRow] = []
    var chats: [ChatRow] = []

    var isEmpty: Bool { pinned.isEmpty && priority.isEmpty && chats.isEmpty }
}

func groupChatRows(
    snapshot: DashboardSnapshot,
    now: Date,
    unreadWorkspaceIDs: Set<String>? = nil
) -> ChatSections {
    // Last writer wins, the same as the renderer's `new Map(...)`: one
    // workspace holds at most one chat in the list.
    var sessionByWorkspace: [String: SessionSummary] = [:]
    for session in snapshot.sessions { sessionByWorkspace[session.workspaceId] = session }
    var projectNameByID: [String: String] = [:]
    for project in snapshot.projects { projectNameByID[project.id] = project.name }

    let hidden = hiddenMultitaskWorkspaceIDs(snapshot.sessions)
    let working = workingWorkspaceIDs(snapshot.sessions)
    let attention = computeWorkspaceAttention(
        workspaces: snapshot.workspaces,
        sessions: snapshot.sessions,
        now: now,
        unreadWorkspaceIDs: unreadWorkspaceIDs
    )

    // A workspace with no chat is a dead row: tapping it resolves nothing.
    // A popup workspace is the "More details" scratch, which never shows.
    let visible = snapshot.workspaces.filter { workspace in
        workspace.state != .archived
            && workspace.kind != .popup
            && !hidden.contains(workspace.id)
            && sessionByWorkspace[workspace.id] != nil
    }

    var rowsByID: [String: ChatRow] = [:]
    var rows: [ChatRow] = []
    for workspace in visible {
        guard let session = sessionByWorkspace[workspace.id] else { continue }
        let row = ChatRow(
            workspace: workspace,
            session: session,
            projectName: projectNameByID[workspace.projectId],
            attention: attention[workspace.id],
            working: working.contains(workspace.id)
        )
        rowsByID[workspace.id] = row
        rows.append(row)
    }

    // Side chats are conversational by nature and never escalate into triage.
    let priority = computePriorityEntries(
        workspaces: visible.filter { $0.kind == .git },
        sessions: snapshot.sessions,
        now: now,
        unreadWorkspaceIDs: unreadWorkspaceIDs
    ).compactMap { rowsByID[$0.workspace.id] }

    let promoted = Set(priority.map(\.id))
    let rest = sortedNewestFirst(rows.filter { !promoted.contains($0.id) }) { $0.session.lastActivityAt }
    return ChatSections(
        pinned: rest.filter { $0.workspace.pinned },
        priority: priority,
        chats: rest.filter { !$0.workspace.pinned }
    )
}
