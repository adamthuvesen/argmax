// Generated from src/shared/bindings.d.ts by scripts/export-swift-contracts.mjs.
// Change the Rust contract and run `npm run generate:contracts`.
import Foundation

enum WireField<Value: Encodable & Sendable>: Sendable {
    case absent
    case null
    case value(Value)

    func encode<Key: CodingKey>(into container: inout KeyedEncodingContainer<Key>, forKey key: Key) throws {
        switch self {
        case .absent: break
        case .null: try container.encodeNil(forKey: key)
        case .value(let value): try container.encode(value, forKey: key)
        }
    }
}

func wireEnum<Value: RawRepresentable>(_ raw: String, as type: Value.Type) throws -> Value
where Value.RawValue == String {
    guard let value = Value(rawValue: raw) else {
        throw EncodingError.invalidValue(raw, .init(codingPath: [], debugDescription: "Unsupported wire enum value: \(raw)"))
    }
    return value
}

enum WireAgentMode: String, Codable, Sendable {
    case auto = "auto"
}

enum WireAttachmentMimeType: String, Codable, Sendable {
    case imagePng = "image/png"
    case imageJpeg = "image/jpeg"
    case imageGif = "image/gif"
    case imageWebp = "image/webp"
}

enum WireAutoTier: String, Codable, Sendable {
    case cost = "cost"
    case economy = "economy"
    case balanced = "balanced"
    case intelligence = "intelligence"
}

enum WireForkWorkspaceMode: String, Codable, Sendable {
    case shared = "shared"
    case isolated = "isolated"
}

enum WirePermissionMode: String, Codable, Sendable {
    case providerDefaults = "provider-defaults"
    case autoApprove = "auto-approve"
    case askEachTime = "ask-each-time"
}

enum WireProviderId: String, Codable, Sendable {
    case claude = "claude"
    case codex = "codex"
    case cursor = "cursor"
    case opencode = "opencode"
    case grok = "grok"
}

enum WireQueuedMessageDelivery: String, Codable, Sendable {
    case interrupt = "interrupt"
    case steer = "steer"
}

enum WireReasoningEffort: String, Codable, Sendable {
    case low = "low"
    case medium = "medium"
    case high = "high"
    case xhigh = "xhigh"
    case max = "max"
    case ultra = "ultra"
}

enum WireScratchWorkspaceKind: String, Codable, Sendable {
    case scratch = "scratch"
    case popup = "popup"
}

struct WireAgentReference: Encodable, Sendable {
    var name: String
    var providerChildSessionId: String
    var providerParentConversationId: String

    enum CodingKeys: String, CodingKey {
        case name
        case providerChildSessionId
        case providerParentConversationId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(providerChildSessionId, forKey: .providerChildSessionId)
        try container.encode(providerParentConversationId, forKey: .providerParentConversationId)
    }
}

struct WireProjectsListBranchesInput: Encodable, Sendable {
    var projectId: String

    enum CodingKeys: String, CodingKey {
        case projectId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
    }
}

struct WireProvidersDiscoverInput: Encodable, Sendable {
    var refresh: WireField<Bool> = .absent

    enum CodingKeys: String, CodingKey {
        case refresh
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try refresh.encode(into: &container, forKey: .refresh)
    }
}

struct WireWorkspacesCreateIsolatedInput: Encodable, Sendable {
    var projectId: String
    var taskLabel: String
    var baseRef: WireField<String> = .absent

    enum CodingKeys: String, CodingKey {
        case projectId
        case taskLabel
        case baseRef
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
        try container.encode(taskLabel, forKey: .taskLabel)
        try baseRef.encode(into: &container, forKey: .baseRef)
    }
}

struct WireWorkspacesCreateCurrentInput: Encodable, Sendable {
    var projectId: String
    var taskLabel: String

    enum CodingKeys: String, CodingKey {
        case projectId
        case taskLabel
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
        try container.encode(taskLabel, forKey: .taskLabel)
    }
}

struct WireWorkspacesCreateScratchInput: Encodable, Sendable {
    var taskLabel: String
    var kind: WireField<WireScratchWorkspaceKind> = .absent

    enum CodingKeys: String, CodingKey {
        case taskLabel
        case kind
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(taskLabel, forKey: .taskLabel)
        try kind.encode(into: &container, forKey: .kind)
    }
}

struct WireProvidersLaunchInput: Encodable, Sendable {
    var workspaceId: String
    var provider: WireProviderId
    var prompt: String
    var modelLabel: String
    var modelId: String
    var reasoningEffort: WireField<WireReasoningEffort> = .absent
    var fastMode: WireField<Bool> = .absent
    var agentMode: WireField<WireAgentMode> = .absent
    var permissionMode: WireField<WirePermissionMode> = .absent
    var cols: Int
    var rows: Int
    var attachments: WireField<[WireComposerAttachmentInput]> = .absent
    var goalCondition: WireField<String> = .absent
    var goalMaxTurns: WireField<Int> = .absent
    var arcId: WireField<String> = .absent
    var arcIsCoordinatorLaunch: WireField<Bool> = .absent
    var autoTier: WireField<WireAutoTier> = .absent

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case provider
        case prompt
        case modelLabel
        case modelId
        case reasoningEffort
        case fastMode
        case agentMode
        case permissionMode
        case cols
        case rows
        case attachments
        case goalCondition
        case goalMaxTurns
        case arcId
        case arcIsCoordinatorLaunch
        case autoTier
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(provider, forKey: .provider)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(modelLabel, forKey: .modelLabel)
        try container.encode(modelId, forKey: .modelId)
        try reasoningEffort.encode(into: &container, forKey: .reasoningEffort)
        try fastMode.encode(into: &container, forKey: .fastMode)
        try agentMode.encode(into: &container, forKey: .agentMode)
        try permissionMode.encode(into: &container, forKey: .permissionMode)
        try container.encode(cols, forKey: .cols)
        try container.encode(rows, forKey: .rows)
        try attachments.encode(into: &container, forKey: .attachments)
        try goalCondition.encode(into: &container, forKey: .goalCondition)
        try goalMaxTurns.encode(into: &container, forKey: .goalMaxTurns)
        try arcId.encode(into: &container, forKey: .arcId)
        try arcIsCoordinatorLaunch.encode(into: &container, forKey: .arcIsCoordinatorLaunch)
        try autoTier.encode(into: &container, forKey: .autoTier)
    }
}

struct WireWorkspacesAutotitleInput: Encodable, Sendable {
    var workspaceId: String
    var provider: WireProviderId
    var modelId: String
    var prompt: String

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case provider
        case modelId
        case prompt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(provider, forKey: .provider)
        try container.encode(modelId, forKey: .modelId)
        try container.encode(prompt, forKey: .prompt)
    }
}

struct WireComposerAttachmentInput: Encodable, Sendable {
    var filePath: String
    var mimeType: WireAttachmentMimeType
    var sizeBytes: Int

    enum CodingKeys: String, CodingKey {
        case filePath
        case mimeType
        case sizeBytes
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(filePath, forKey: .filePath)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encode(sizeBytes, forKey: .sizeBytes)
    }
}

struct WireAttachmentsSaveImageInput: Encodable, Sendable {
    var sessionId: String
    var mimeType: WireAttachmentMimeType
    var dataBase64: String

    enum CodingKeys: String, CodingKey {
        case sessionId
        case mimeType
        case dataBase64
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encode(dataBase64, forKey: .dataBase64)
    }
}

struct WireProvidersSendInput: Encodable, Sendable {
    var sessionId: String
    var input: String
    var provider: WireField<WireProviderId> = .absent
    var modelLabel: WireField<String> = .absent
    var modelId: WireField<String> = .absent
    var reasoningEffort: WireField<WireReasoningEffort> = .absent
    var fastMode: WireField<Bool> = .absent
    var agentMode: WireField<WireAgentMode> = .absent
    var attachments: WireField<[WireComposerAttachmentInput]> = .absent
    var agentReferences: WireField<[WireAgentReference]> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case input
        case provider
        case modelLabel
        case modelId
        case reasoningEffort
        case fastMode
        case agentMode
        case attachments
        case agentReferences
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(input, forKey: .input)
        try provider.encode(into: &container, forKey: .provider)
        try modelLabel.encode(into: &container, forKey: .modelLabel)
        try modelId.encode(into: &container, forKey: .modelId)
        try reasoningEffort.encode(into: &container, forKey: .reasoningEffort)
        try fastMode.encode(into: &container, forKey: .fastMode)
        try agentMode.encode(into: &container, forKey: .agentMode)
        try attachments.encode(into: &container, forKey: .attachments)
        try agentReferences.encode(into: &container, forKey: .agentReferences)
    }
}

struct WireQuestionsResolveInput: Encodable, Sendable {
    var sessionId: String
    var requestId: String
    var answers: [String: [String]]
    var dismissed: WireField<Bool> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case requestId
        case answers
        case dismissed
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(requestId, forKey: .requestId)
        try container.encode(answers, forKey: .answers)
        try dismissed.encode(into: &container, forKey: .dismissed)
    }
}

struct WireProvidersTerminateInput: Encodable, Sendable {
    var sessionId: String

    enum CodingKeys: String, CodingKey {
        case sessionId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
    }
}

struct WireProvidersCancelQueuedMessageInput: Encodable, Sendable {
    var sessionId: String
    var messageId: String

    enum CodingKeys: String, CodingKey {
        case sessionId
        case messageId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(messageId, forKey: .messageId)
    }
}

struct WireProvidersSendQueuedMessageNowInput: Encodable, Sendable {
    var sessionId: String
    var messageId: String
    var delivery: WireField<WireQueuedMessageDelivery> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case messageId
        case delivery
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(messageId, forKey: .messageId)
        try delivery.encode(into: &container, forKey: .delivery)
    }
}

struct WireSessionMultitaskInput: Encodable, Sendable {
    var sessionId: String
    var prompt: String
    var pendingMessageId: WireField<String> = .absent
    var worktree: WireField<Bool> = .absent
    var taskLabel: WireField<String> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case prompt
        case pendingMessageId
        case worktree
        case taskLabel
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(prompt, forKey: .prompt)
        try pendingMessageId.encode(into: &container, forKey: .pendingMessageId)
        try worktree.encode(into: &container, forKey: .worktree)
        try taskLabel.encode(into: &container, forKey: .taskLabel)
    }
}

struct WireWorkspacesSetPinnedInput: Encodable, Sendable {
    var workspaceId: String
    var pinned: Bool

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case pinned
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(pinned, forKey: .pinned)
    }
}

struct WireWorkspacesSetLabelInput: Encodable, Sendable {
    var workspaceId: String
    var taskLabel: String

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case taskLabel
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(taskLabel, forKey: .taskLabel)
    }
}

struct WireWorkspacesArchiveInput: Encodable, Sendable {
    var workspaceId: String
    var force: WireField<Bool> = .absent

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case force
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try force.encode(into: &container, forKey: .force)
    }
}

struct WireSessionForkInput: Encodable, Sendable {
    var sessionId: String
    var boundaryEventId: WireField<String> = .absent
    var workspace: WireField<WireForkWorkspaceMode> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case boundaryEventId
        case workspace
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try boundaryEventId.encode(into: &container, forKey: .boundaryEventId)
        try workspace.encode(into: &container, forKey: .workspace)
    }
}

struct WireGitViewOrCreatePrInput: Encodable, Sendable {
    var sessionId: String
    var expectedBranch: WireField<String> = .absent

    enum CodingKeys: String, CodingKey {
        case sessionId
        case expectedBranch
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try expectedBranch.encode(into: &container, forKey: .expectedBranch)
    }
}

struct WireRemoteRegisterPushDeviceInput: Encodable, Sendable {
    var token: String
    var name: String

    enum CodingKeys: String, CodingKey {
        case token
        case name
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
        try container.encode(name, forKey: .name)
    }
}

struct WireRemoteUnregisterPushDeviceInput: Encodable, Sendable {
    var token: String

    enum CodingKeys: String, CodingKey {
        case token
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(token, forKey: .token)
    }
}
