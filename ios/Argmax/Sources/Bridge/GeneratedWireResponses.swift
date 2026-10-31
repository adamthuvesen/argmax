// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.
// Change the Rust contract, or the response list in that script, and run
// `npm run generate:contracts`. Unlisted keys on the wire are ignored.
import Foundation

/// `ProjectSummary`. `settings` and `counts` are desktop-only and dropped.
struct ProjectSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var repoPath: String
    var currentBranch: String
    var defaultBranch: String?
    var latestActivityAt: String?
}

/// `WorkspaceSummary`: the unit of work a chat list row stands for. The PR and priority
/// columns are here because the Priority section reads them directly: a red check or an
/// open pull request is the workspace's business, not any one session's.
struct WorkspaceSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var projectId: String
    /// The project folder this chat works in. Nil for side chats and for hosts older
    /// than named projects. "New chat here" sends it back so the new chat starts in the
    /// same folder.
    var projectFolderId: String?
    var taskLabel: String
    var branch: String
    var baseRef: String
    var path: String
    var state: WorkspaceState
    var kind: WorkspaceKind
    var sharedWorkspace: Bool
    var dirty: Bool
    var changedFiles: Int
    var lastActivityAt: String
    var pinned: Bool
    var priorityDismissedAt: String?
    var priorityAddedAt: String?
    /// RFC 3339 instant the desktop's snooze shelf holds this row until. Display
    /// metadata only: a snooze never changes the chat's state. The phone decodes it so
    /// the field survives a round trip; it does not shelve rows.
    var snoozedUntil: String?
    var prState: String?
    var prNumber: Int?
    var prCheckState: String?
    var prActivityAt: String?
    /// The glyph the desktop's icon picker put on this row, as a curated Lucide name
    /// (`src/renderer/lib/sessionIcons.ts`).
    var icon: String?
    /// The palette entry paired with `icon`: a name ("violet"), not a colour. Both
    /// clients resolve the token against their own theme, which is how one pick reads
    /// right on paper and on charcoal.
    var iconColor: String?
    /// Shared host acknowledgement of the activity actually shown on a device.
    var lastViewedAt: String?
    var prs: [WorkspacePullRequest]?
}

struct WorkspacePullRequest: Codable, Hashable, Sendable {
    var prNumber: Int
    var url: String?
}

/// `SessionSummary`: one chat with one provider. `launchKind` and `launchedBySessionId`
/// are the multitask linkage: a multitask belongs to the chat that dispatched it and
/// has no row of its own.
struct SessionSummary: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var workspaceId: String
    var provider: String
    var modelLabel: String
    var modelId: String
    var prompt: String
    var state: SessionState
    var attention: AttentionState
    /// When `attention` last changed. Null on rows written before the column existed,
    /// which the Priority rules treat as "not yet a reason".
    var attentionChangedAt: String?
    var startedAt: String
    var completedAt: String?
    var lastActivityAt: String
    var imported: Bool
    var launchKind: String
    var launchedBySessionId: String?
    /// Read on open so the composer's effort chip starts right instead of showing the
    /// first option until the metadata read lands.
    var reasoningEffort: String?
    /// The Arc this chat belongs to, as its coordinator or a member.
    var arcId: String?
    /// The Router tier while the router picks this chat's model; absent once a model is
    /// picked by hand.
    var autoTier: String?
}

/// `DashboardDelta`: whole-object replacement per row, plus the two removal lists,
/// which are the only way the protocol can say "gone". A remote host may omit any
/// slice, so every field is optional here.
struct DashboardDelta: Codable, Hashable, Sendable {
    var projects: [ProjectSummary]?
    var workspaces: [WorkspaceSummary]?
    var sessions: [SessionSummary]?
    var removedSessionIds: [String]?
    var removedWorkspaceIds: [String]?
    /// Hints rather than rows: the host says "the dashboard moved, read it again"
    /// instead of shipping the changed rows, and names the sessions whose transcripts
    /// advanced.
    var dashboardChanged: Bool?
    var changedSessionIds: [String]?
    /// The event stream dropped frames and the whole snapshot must be reloaded.
    var resyncRequired: Bool?
}

struct TranscriptEvent: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var type: String
    var message: String
    var payload: TranscriptJSONValue
    /// Absent from a saved transcript this app wrote before semantics existed.
    var semantic: TimelineSemantics?
    var createdAt: String
    var rowCursor: Int64?
}

struct TranscriptRawOutput: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var stream: String
    var content: String
    var createdAt: String
    var rowCursor: Int64?
}

struct TranscriptPage: Codable, Hashable, Sendable {
    var events: [TranscriptEvent]
    var rawOutputs: [TranscriptRawOutput]
    var eventCursor: Int64
    var rawOutputCursor: Int64
    var changeCursor: Int64?
    var deletedEventIds: [String]
    var deletedRawOutputIds: [String]
    var resetRequired: Bool
    var hasMore: Bool
}

struct TranscriptPendingMessage: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var content: String
    /// The provider this follow-up runs under once it drains. Nil is the chat's
    /// provider at that moment.
    var provider: String?
    var modelLabel: String?
    var modelId: String?
    var reasoningEffort: String?
    var recoveryStatus: String?
    var queuedAt: String
}

struct TranscriptSessionMetadata: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var workspaceId: String
    var provider: String
    var modelLabel: String
    var modelId: String
    var prompt: String
    var state: SessionState
    var attention: AttentionState
    var reasoningEffort: String?
    var contextTokens: Int?
    var contextWindow: Int?
    /// The Router tier while the router picks this chat's model; cleared once a model
    /// is picked by hand.
    var autoTier: String?
}

struct TranscriptWorkspaceMetadata: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var taskLabel: String
    /// Optional for the older hosts this read has always tolerated.
    var path: String?
}
