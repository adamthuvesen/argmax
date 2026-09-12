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

    /// The first line of the reasoning with its markdown emphasis and any
    /// heading marks stripped, or nil for an empty burst. The phone's folded
    /// thought row is titled by it.
    static func title(of text: String) -> String? {
        guard let line = text.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }) else { return nil }
        let stripped = line
            .replacingOccurrences(of: "^#+\\s*", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[*_`]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces.union(.punctuationCharacters))
        return stripped.isEmpty ? nil : stripped
    }
}

enum TranscriptToolStatus: String, Hashable, Sendable {
    case running
    case done
    case failed
}

enum TranscriptToolActivityKind: String, CaseIterable, Hashable, Sendable {
    case read
    case edit
    case image
    case search
    case list
    case webSearch = "web-search"
    case webFetch = "web-fetch"
    case discovery
    case command
    case computer
    case tool
    case agent
    case skill
    case imageCapture = "image-capture"
    case imageGenerate = "image-generate"
    case agentMessage = "agent-message"
    case agentWait = "agent-wait"
    case agentStop = "agent-stop"
    case memoryRecall = "memory-recall"
    case memorySave = "memory-save"
    case git
    case browser
    case plan
}

enum TranscriptToolActivityEvidence: String, Hashable, Sendable {
    case native
    case tool
    case command
}

enum TranscriptToolActivityOperation: String, Hashable, Sendable {
    case create
    case edit
    case delete
    case move
}

/// Provider-neutral evidence describing what a tool call did.
///
/// The host owns classification. The phone keeps unknown future versions out
/// of this model and falls back to ordinary tool presentation instead of
/// guessing at a new contract.
struct TranscriptToolActivity: Hashable, Sendable {
    var version: Int
    var kind: TranscriptToolActivityKind
    var evidence: TranscriptToolActivityEvidence
    var targets: [String]
    var operation: TranscriptToolActivityOperation?
    var toolCount: Int?

    static let generic = TranscriptToolActivity(
        version: 1,
        kind: .tool,
        evidence: .tool,
        targets: [],
        operation: nil,
        toolCount: nil
    )
}

enum TranscriptToolActivityState: Hashable, Sendable {
    case running
    case succeeded
    case failed
    case cancelled
    case unconfirmed
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
    var fileLabel: String?
    var activity: TranscriptToolActivity = .generic
    /// True only when a matching provider completion event was present.
    var completionObserved: Bool = false
    /// Kept separate from the legacy three-state status so a cancelled call
    /// cannot be worded as successful merely because its completion arrived.
    var completionStatus: String? = nil

    /// The review path an edit row opens. Tool inputs retain absolute paths,
    /// while the review surface keys changed files by workspace-relative path.
    /// Reads and other file-bearing tools still open their file preview.
    var diffPath: String? {
        guard activity.kind == .edit, let filePath else { return nil }
        return fileLabel ?? filePath
    }

    var activityState: TranscriptToolActivityState {
        if status == .running { return .running }
        if ["cancelled", "canceled", "interrupted"].contains(completionStatus?.lowercased()) {
            return .cancelled
        }
        if status == .failed { return .failed }
        return completionObserved ? .succeeded : .unconfirmed
    }

    var activitySummary: String {
        let target: String? = activity.targets.count == 1
            ? activity.targets[0].split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
            : nil
        return activity.label(state: activityState, plural: activity.targets.count > 1, target: target)
    }
}

struct TranscriptToolGroup: Hashable, Sendable, Identifiable {
    var id: String
    var tools: [TranscriptTool]
    var createdAt: String

    var activitySummary: String { TranscriptToolActivity.summary(for: tools).headline }
}

extension TranscriptToolActivity {
    func label(state: TranscriptToolActivityState, plural: Bool = false, target: String? = nil) -> String {
        let file = target ?? (plural ? "files" : "a file")
        let image = target ?? (plural ? "images" : "an image")
        let labels: (running: String, succeeded: String, neutral: String)
        switch kind {
        case .read:
            labels = ("Reading \(file)", "Read \(file)", "File read")
        case .edit:
            let verbs: (String, String)
            switch operation {
            case .create: verbs = ("Creating", "Created")
            case .delete: verbs = ("Deleting", "Deleted")
            case .move: verbs = ("Moving", "Moved")
            default: verbs = ("Editing", "Edited")
            }
            labels = ("\(verbs.0) \(file)", "\(verbs.1) \(file)", "File change")
        case .image:
            labels = ("Viewing \(image)", "Viewed \(image)", "Image view")
        case .imageCapture:
            labels = ("Capturing a screenshot", "Captured a screenshot", "Screenshot capture")
        case .imageGenerate:
            labels = ("Generating \(image)", "Generated \(image)", "Image generation")
        case .search:
            labels = ("Searching files", "Searched files", "File search")
        case .list:
            labels = ("Listing files", "Listed files", "File listing")
        case .webSearch:
            labels = ("Searching the web", "Searched the web", "Web search")
        case .webFetch:
            labels = ("Fetching a URL", "Fetched a URL", "Web request")
        case .discovery:
            let loaded = (toolCount ?? 0) > 0
                ? "Loaded \(toolCount == 1 && !plural ? "a tool" : "tools")"
                : "Searched tools"
            labels = ("Searching for tools", loaded, "Tool discovery")
        case .command:
            labels = (plural ? "Running commands" : "Running a command",
                      plural ? "Ran commands" : "Ran a command", "Command")
        case .computer:
            labels = ("Using a computer", "Used a computer", "Computer use")
        case .agent:
            labels = ("Starting an agent", plural ? "Started agents" : "Started an agent", "Agent launch")
        case .agentMessage:
            labels = ("Messaging an agent", plural ? "Messaged agents" : "Messaged an agent", "Agent message")
        case .agentWait:
            labels = ("Waiting for an agent", plural ? "Waited for agents" : "Waited for an agent", "Agent wait")
        case .agentStop:
            labels = ("Stopping an agent", plural ? "Stopped agents" : "Stopped an agent", "Agent stop")
        case .memoryRecall:
            labels = ("Recalling memory", "Recalled memory", "Memory recall")
        case .memorySave:
            labels = ("Saving a memory", plural ? "Saved memories" : "Saved a memory", "Memory save")
        case .git:
            let subcommand = target.map { "git \($0)" } ?? "git commands"
            labels = ("Running \(subcommand)", "Ran \(subcommand)", "Git command")
        case .browser:
            labels = ("Using the browser", "Used the browser", "Browser action")
        case .plan:
            labels = ("Updating the plan", "Updated the plan", "Plan update")
        case .skill:
            labels = ("Activating a skill", "Activated a skill", "Skill activation")
        case .tool:
            labels = (plural ? "Using tools" : "Using a tool",
                      plural ? "Used tools" : "Used a tool", "Tool call")
        }
        switch state {
        case .running: return labels.running
        case .succeeded: return labels.succeeded
        case .failed: return "\(labels.neutral) failed"
        case .cancelled: return "\(labels.neutral) cancelled"
        case .unconfirmed: return labels.neutral
        }
    }

    static func summary(for tools: [TranscriptTool]) -> (headline: String, iconKind: TranscriptToolActivityKind) {
        struct Group: Hashable {
            var activity: TranscriptToolActivity
            var state: TranscriptToolActivityState
            var count: Int
            var targets: Set<String>
        }
        var seen = Set<String>()
        var groups: [Group] = []
        for tool in tools where seen.insert(tool.id).inserted {
            let state = tool.activityState
            let activity = tool.activity
            let key = "\(activity.kind.rawValue):\(activity.operation?.rawValue ?? ""):\(state):"
                + "\(activity.kind == .discovery && (activity.toolCount ?? 0) > 0)"
            if let index = groups.firstIndex(where: { group in
                "\(group.activity.kind.rawValue):\(group.activity.operation?.rawValue ?? ""):\(group.state):"
                    + "\(group.activity.kind == .discovery && (group.activity.toolCount ?? 0) > 0)" == key
            }) {
                groups[index].count += 1
                groups[index].targets.formUnion(activity.targets)
            } else {
                groups.append(Group(activity: activity, state: state, count: 1, targets: Set(activity.targets)))
            }
        }
        let labels = groups.map { group in
            group.activity.label(
                state: group.state,
                plural: group.targets.isEmpty ? group.count > 1 : group.targets.count > 1
            )
        }
        let headline = labels.enumerated().map { index, label in
            guard index > 0, let first = label.first else { return label }
            return first.lowercased() + label.dropFirst()
        }.joined(separator: ", ")
        return (headline, groups.first?.activity.kind ?? .tool)
    }
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
    var responseID: String? = nil
    var allowsOther: Bool = true
    var isSecret: Bool = false

    var id: String { responseID ?? (header.isEmpty ? question : header) }
}

struct TranscriptQuestionCard: Hashable, Sendable, Identifiable {
    var id: String
    var toolUseId: String
    var createdAt: String
    var questions: [TranscriptQuestion]
    var isOutstanding: Bool
    var sessionID: String? = nil
    var requestID: String? = nil
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
