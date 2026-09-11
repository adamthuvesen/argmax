import Foundation

/// JSON carried by a provider-normalized timeline event.
///
/// The wire remains open so a newer host can add fields without making an
/// older phone lose the whole transcript. Projection turns the fields the UI
/// needs into the concrete models below; views never inspect this value.
enum TranscriptJSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: TranscriptJSONValue])
    case array([TranscriptJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([String: TranscriptJSONValue].self) {
            self = .object(value)
        } else if let value = try? container.decode([TranscriptJSONValue].self) {
            self = .array(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON value")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

extension TranscriptJSONValue {
    var string: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var bool: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var object: [String: TranscriptJSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var array: [TranscriptJSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }
}

struct TranscriptEvent: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var sessionId: String
    var type: String
    var message: String
    var payload: TranscriptJSONValue
    var createdAt: String
    var rowCursor: Int64?

    var payloadObject: [String: TranscriptJSONValue] { payload.object ?? [:] }
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

enum TranscriptMessageRole: String, Hashable, Sendable {
    case user
    case assistant
}

struct TranscriptMessage: Hashable, Sendable, Identifiable {
    var id: String
    var role: TranscriptMessageRole
    var text: String
    var createdAt: String
    var isStreaming: Bool
    var isSteering: Bool
    var originLabel: String?
    var attachments: [TranscriptAttachment]
}

struct TranscriptThought: Hashable, Sendable, Identifiable {
    var id: String
    var text: String
    var createdAt: String
    var isStreaming: Bool
}

enum TranscriptToolStatus: String, Hashable, Sendable {
    case running
    case done
    case failed
}

struct TranscriptTool: Hashable, Sendable, Identifiable {
    var id: String
    var toolUseId: String
    var name: String
    var summary: String
    var input: String?
    var output: String?
    var error: String?
    var status: TranscriptToolStatus
    var createdAt: String
    var completedAt: String?
    var filePath: String?
}

struct TranscriptToolGroup: Hashable, Sendable, Identifiable {
    var id: String
    var tools: [TranscriptTool]
    var createdAt: String
}

struct TranscriptQuestionOption: Hashable, Sendable, Identifiable {
    var label: String
    var detail: String?

    var id: String { label }
}

struct TranscriptQuestion: Hashable, Sendable, Identifiable {
    var question: String
    var header: String
    var options: [TranscriptQuestionOption]
    var allowsMultiple: Bool

    var id: String { header.isEmpty ? question : header }
}

struct TranscriptQuestionCard: Hashable, Sendable, Identifiable {
    var id: String
    var toolUseId: String
    var createdAt: String
    var questions: [TranscriptQuestion]
    var isOutstanding: Bool
}

struct TranscriptPlan: Hashable, Sendable, Identifiable {
    var id: String
    var toolUseId: String
    var markdown: String
    var createdAt: String
    var isOutstanding: Bool
}

enum TranscriptTodoStatus: String, Hashable, Sendable {
    case pending
    case active
    case done
    case cancelled
}

struct TranscriptTodoItem: Hashable, Sendable, Identifiable {
    var id: String
    var text: String?
    var status: TranscriptTodoStatus
}

struct TranscriptTodoList: Hashable, Sendable, Identifiable {
    var id: String
    var items: [TranscriptTodoItem]
    var createdAt: String
}

enum TranscriptApprovalStatus: String, Hashable, Sendable {
    case pending
    case approved
    case rejected
    case cancelled
    case blocked
}

struct TranscriptApproval: Hashable, Sendable, Identifiable {
    var id: String
    var provider: String?
    var command: String
    var workingDirectory: String?
    var riskLevel: String?
    var status: TranscriptApprovalStatus
    var createdAt: String
}

struct TranscriptAgent: Hashable, Sendable, Identifiable {
    var id: String
    var parentSessionId: String
    var toolUseId: String
    var name: String
    var prompt: String?
    var status: TranscriptToolStatus
    var createdAt: String
    var completedAt: String?
    var providerChildSessionId: String?
    var providerParentConversationId: String?
    var agentCodename: String?
    var children: [TranscriptTool]
}

struct TranscriptAgentGroup: Hashable, Sendable, Identifiable {
    var id: String
    var agents: [TranscriptAgent]
    var createdAt: String
}

struct TranscriptMultitask: Hashable, Sendable, Identifiable {
    var id: String
    var childSessionId: String?
    var taskLabel: String
    var prompt: String?
    var answer: String?
    var state: String?
    var createdAt: String
}

enum TranscriptNoticeKind: Hashable, Sendable {
    case compacting(preTokens: Int?, postTokens: Int?)
    case providerChanged(from: String?, to: String, modelLabel: String?)
    case moved(destinationProject: String?, checkoutMode: String?)
    case note(operation: String?)
}

struct TranscriptNotice: Hashable, Sendable, Identifiable {
    var id: String
    var text: String
    var kind: TranscriptNoticeKind
    var createdAt: String
}

struct TranscriptError: Hashable, Sendable, Identifiable {
    var id: String
    var message: String
    var code: String?
    var operation: String?
    var createdAt: String
}

enum TranscriptItem: Hashable, Sendable, Identifiable {
    case user(TranscriptMessage)
    case assistant(TranscriptMessage)
    case thought(TranscriptThought)
    case tools(TranscriptToolGroup)
    case plan(TranscriptPlan)
    case question(TranscriptQuestionCard)
    case todo(TranscriptTodoList)
    case approval(TranscriptApproval)
    case agents(TranscriptAgentGroup)
    case multitask(TranscriptMultitask)
    case notice(TranscriptNotice)
    case error(TranscriptError)

    var id: String {
        switch self {
        case .user(let value): return value.id
        case .assistant(let value): return value.id
        case .thought(let value): return value.id
        case .tools(let value): return value.id
        case .plan(let value): return value.id
        case .question(let value): return value.id
        case .todo(let value): return value.id
        case .approval(let value): return "approval-\(value.id)"
        case .agents(let value): return value.id
        case .multitask(let value): return value.id
        case .notice(let value): return value.id
        case .error(let value): return value.id
        }
    }

    var createdAt: String {
        switch self {
        case .user(let value), .assistant(let value): return value.createdAt
        case .thought(let value): return value.createdAt
        case .tools(let value): return value.createdAt
        case .plan(let value): return value.createdAt
        case .question(let value): return value.createdAt
        case .todo(let value): return value.createdAt
        case .approval(let value): return value.createdAt
        case .agents(let value): return value.createdAt
        case .multitask(let value): return value.createdAt
        case .notice(let value): return value.createdAt
        case .error(let value): return value.createdAt
        }
    }
}

enum TranscriptLoadPhase: Hashable, Sendable {
    case idle
    case loading
    case ready
    case failed(String)
}
