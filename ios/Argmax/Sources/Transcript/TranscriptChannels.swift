import Foundation

struct TranscriptEventsSinceInput: Encodable, Sendable {
    var sessionId: String
    var eventCursor: Int64?
    var rawOutputCursor: Int64?
    var changeCursor: Int64?
}

struct TranscriptAgentEventsInput: Encodable, Sendable {
    var sessionId: String
    var parentToolUseId: String
    var providerParentConversationId: String?
    var providerChildSessionId: String?
}

struct TranscriptPendingMessage: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var content: String
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
    var contextTokens: Int? = nil
    var contextWindow: Int? = nil
}

struct TranscriptWorkspaceMetadata: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var taskLabel: String
    var path: String?
}

struct TranscriptDashboardSnapshot: Decodable, Hashable, Sendable {
    var sessions: [TranscriptSessionMetadata]
    var workspaces: [TranscriptWorkspaceMetadata]
    var pendingMessages: [String: [TranscriptPendingMessage]]

    private enum CodingKeys: String, CodingKey {
        case sessions
        case workspaces
        case pendingMessages
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decodeIfPresent([TranscriptSessionMetadata].self, forKey: .sessions) ?? []
        workspaces = try container.decodeIfPresent([TranscriptWorkspaceMetadata].self, forKey: .workspaces) ?? []
        pendingMessages = try container.decodeIfPresent(
            [String: [TranscriptPendingMessage]].self,
            forKey: .pendingMessages
        ) ?? [:]
    }
}

private struct TranscriptPendingApproval: Decodable, Sendable {
    var id: String
    var sessionId: String
    var command: String
    var cwd: String
    var provider: String
    var riskLevel: String
    var status: String
    var createdAt: String
}

extension BridgeClient {
    func transcriptEvents(
        sessionID: String,
        eventCursor: Int64? = nil,
        rawOutputCursor: Int64? = nil,
        changeCursor: Int64? = nil
    ) async throws -> TranscriptPage {
        try await request(
            "session:events-since",
            input: TranscriptEventsSinceInput(
                sessionId: sessionID,
                eventCursor: eventCursor,
                rawOutputCursor: rawOutputCursor,
                changeCursor: changeCursor
            ),
            as: TranscriptPage.self
        )
    }

    func transcriptAgentEvents(_ agent: TranscriptAgent) async throws -> TranscriptPage {
        try await request(
            "session:agent-events",
            input: TranscriptAgentEventsInput(
                sessionId: agent.parentSessionId,
                parentToolUseId: agent.toolUseId,
                providerParentConversationId: agent.providerParentConversationId,
                providerChildSessionId: agent.providerChildSessionId
            ),
            as: TranscriptPage.self
        )
    }

    func transcriptDashboard() async throws -> TranscriptDashboardSnapshot {
        try await request("dashboard:list", as: TranscriptDashboardSnapshot.self)
    }

    func transcriptPendingApprovals(sessionID: String) async throws -> [TranscriptApproval] {
        let pending = try await request("approvals:pending", as: [TranscriptPendingApproval].self)
        return pending.compactMap { approval in
            guard approval.sessionId == sessionID else { return nil }
            return TranscriptApproval(
                id: approval.id,
                provider: approval.provider,
                command: approval.command,
                workingDirectory: approval.cwd,
                riskLevel: approval.riskLevel,
                status: TranscriptApprovalStatus(rawValue: approval.status) ?? .pending,
                createdAt: approval.createdAt
            )
        }
    }
}
