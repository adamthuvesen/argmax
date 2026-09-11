import Foundation

// The channels the phone calls, as Swift.
//
// Every struct here mirrors a generated binding in `src/shared/bindings.d.ts`
// field for field, in the same camelCase the wire uses. The host's input
// structs are `deny_unknown_fields` (src-tauri/src/ipc/inputs.rs), so a key
// this app invents is a rejected request rather than an ignored one, and the
// payloads the renderer sends are the specification: see
// `src/renderer/mobile/NewSessionScreen.tsx` for the launch and
// `MobileApp.tsx` for the row actions.
//
// Operation ids are not set here. `BridgeClient.encodeRequestFrame` attaches
// one to every channel outside `src/shared/remoteReadChannels.json`, which is
// the same manifest the host reads, so the read/mutation split cannot drift
// out of a call site's spelling.
//
// A nullable field is encoded as `null`, never dropped. The renderer sends
// `baseRef: null` and `attachments: null` explicitly; matching it keeps one
// payload shape on the host's side of the socket and one shape to read in a
// log.

extension KeyedEncodingContainer {
    /// Encode an optional as `null` instead of omitting the key.
    mutating func encodeAlways(_ value: (some Encodable)?, forKey key: Key) throws {
        if let value {
            try encode(value, forKey: key)
        } else {
            try encodeNil(forKey: key)
        }
    }
}

// MARK: - Reads

/// `ProjectsListBranchesInput`. Answers `[String]`, newest-first as git lists.
struct ListBranchesInput: Encodable, Sendable {
    var projectId: String
}

/// `ProvidersDiscoverInput`. `refresh` re-probes each CLI instead of reading
/// the host's cached reports, which takes seconds — the sheet asks for the
/// cache.
struct DiscoverProvidersInput: Encodable, Sendable {
    var refresh: Bool = false
}

/// `ProviderCapabilityReport`, trimmed to what the New chat sheet reads.
///
/// `authenticated` is tri-state and advisory: `nil` means not installed or an
/// inconclusive probe, and a launch is never blocked on it — a CLI that
/// changes its status command must not lock a working provider out of the
/// phone.
struct ProviderCapability: Codable, Hashable, Sendable, Identifiable {
    var provider: String
    var displayName: String
    var installed: Bool
    var authenticated: Bool?
    var setupGuidance: String?

    var id: String { provider }

    /// Offer it unless the host is sure it cannot work.
    var usable: Bool { installed && authenticated != false }
}

// MARK: - Creating a workspace

/// `WorkspacesCreateIsolatedInput` — a new worktree. `baseRef` is the branch
/// it forks from; `nil` means the project's current branch.
struct CreateIsolatedWorkspaceInput: Encodable, Sendable {
    var projectId: String
    var taskLabel: String
    var baseRef: String?

    enum CodingKeys: String, CodingKey {
        case projectId, taskLabel, baseRef
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(projectId, forKey: .projectId)
        try container.encode(taskLabel, forKey: .taskLabel)
        try container.encodeAlways(baseRef, forKey: .baseRef)
    }
}

/// `WorkspacesCreateCurrentInput` — the project's own checkout, shared with
/// whatever else is working in it.
struct CreateCurrentWorkspaceInput: Encodable, Sendable {
    var projectId: String
    var taskLabel: String
}

/// `WorkspacesCreateScratchInput` — a side chat: an app-owned directory with
/// one empty commit and no repository. `kind` stays `nil`, which is
/// `scratch`; `popup` is the desktop's ephemeral "More details" workspace.
struct CreateScratchWorkspaceInput: Encodable, Sendable {
    var taskLabel: String
    var kind: String?

    enum CodingKeys: String, CodingKey {
        case taskLabel, kind
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(taskLabel, forKey: .taskLabel)
        try container.encodeAlways(kind, forKey: .kind)
    }
}

/// One workspace, already resolved to the call that makes it. The three
/// channels differ only in their input, so pairing each with its own is what
/// keeps the channel name in one place.
enum WorkspaceCreation: Sendable {
    case isolated(CreateIsolatedWorkspaceInput)
    case current(CreateCurrentWorkspaceInput)
    case scratch(CreateScratchWorkspaceInput)

    var channel: String {
        switch self {
        case .isolated: return "workspaces:create-isolated"
        case .current: return "workspaces:create-current"
        case .scratch: return "workspaces:create-scratch"
        }
    }
}

// MARK: - Starting a chat

/// `ProvidersLaunchInput`, in the shape `NewSessionScreen` sends.
///
/// The binding also carries `permissionMode`, `goalCondition` and
/// `goalMaxTurns`; the renderer omits all three and the host defaults them,
/// so this omits them too — the two launchers put the same eleven keys on the
/// wire. `cols` and `rows` are the terminal geometry a phone has no opinion
/// about, and 120×32 is what every Argmax launcher sends.
struct LaunchSessionInput: Encodable, Sendable {
    var workspaceId: String
    var provider: String
    var prompt: String
    var modelLabel: String
    var modelId: String
    var reasoningEffort: String?
    /// Off. Fast mode is a Codex-only control the phone does not surface.
    var fastMode: Bool = false
    /// Auto, not plan: the desktop and the web launcher both start in auto.
    var agentMode: String = "auto"
    var cols = 120
    var rows = 32
    /// Images the launcher picked, stored on the Mac before this call.
    var attachments: [ComposerAttachment] = []

    enum CodingKeys: String, CodingKey {
        case workspaceId, provider, prompt, modelLabel, modelId, reasoningEffort
        case fastMode, agentMode, cols, rows, attachments
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(workspaceId, forKey: .workspaceId)
        try container.encode(provider, forKey: .provider)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(modelLabel, forKey: .modelLabel)
        try container.encode(modelId, forKey: .modelId)
        try container.encodeAlways(reasoningEffort, forKey: .reasoningEffort)
        try container.encode(fastMode, forKey: .fastMode)
        try container.encode(agentMode, forKey: .agentMode)
        try container.encode(cols, forKey: .cols)
        try container.encode(rows, forKey: .rows)
        // An empty pick still sends the key: the renderer sends it, so the
        // two launchers write the same object.
        if attachments.isEmpty {
            try container.encodeNil(forKey: .attachments)
        } else {
            try container.encode(attachments, forKey: .attachments)
        }
    }
}

/// `WorkspacesAutotitleInput` — a second, toolless CLI call that renames the
/// workspace from the prompt. Best-effort: a failure leaves the first line of
/// the prompt as the chat's name, which is what it was called all along.
struct AutoTitleWorkspaceInput: Encodable, Sendable {
    var workspaceId: String
    var provider: String
    var modelId: String
    var prompt: String
}

// MARK: - Sending a follow-up

/// One image already stored on the Mac, in `ComposerAttachmentInput`'s shape.
/// The prompt carries an `@path` reference to the same file, the way the
/// desktop composer sends both.
struct ComposerAttachment: Encodable, Sendable, Equatable {
    var filePath: String
    var mimeType: String
    var sizeBytes: Int
}

/// `AttachmentsSaveImageInput` — picked photo bytes, written to the host's
/// attachment store under the chat they belong to. The answer's `filePath` is
/// what the send then references; the bytes never travel a second time.
struct SaveAttachmentImageInput: Encodable, Sendable {
    var sessionId: String
    var mimeType: String
    var dataBase64: String
}

/// `SaveImageResult`.
struct SaveAttachmentImageResult: Decodable, Sendable {
    var filePath: String
    var sizeBytes: Int
}

/// `ProvidersSendInput`, in the shape `SessionComposer`'s `deliverDraft` sends
/// through `useSessionCommands.ts`'s `sendSessionInput`.
///
/// The native composer (`TranscriptComposer`) sends images the same way the
/// desktop composer does — stored first, then named by path in the prompt and
/// listed here — and carries no `/file` references, so `agentReferences` is
/// left off the key set entirely: the renderer only adds that key when it has
/// at least one reference to send. An empty pick still sends `attachments:
/// null`, on the wire, never dropped.
struct SendInputInput: Encodable, Sendable {
    var sessionId: String
    var input: String
    /// Carries the picked provider unconditionally, the way the composer
    /// does; the host only acts on it when it differs from the session's
    /// current provider, and only on an idle follow-up.
    var provider: String
    var modelLabel: String
    var modelId: String
    var reasoningEffort: String?
    var agentMode: String
    var attachments: [ComposerAttachment] = []

    enum CodingKeys: String, CodingKey {
        case sessionId, input, provider, modelLabel, modelId, reasoningEffort
        case fastMode, agentMode, attachments
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(input, forKey: .input)
        try container.encode(provider, forKey: .provider)
        try container.encode(modelLabel, forKey: .modelLabel)
        try container.encode(modelId, forKey: .modelId)
        try container.encodeAlways(reasoningEffort, forKey: .reasoningEffort)
        // Off, same as `LaunchSessionInput`: fast mode is a Codex-only
        // control the phone does not surface.
        try container.encode(false, forKey: .fastMode)
        try container.encode(agentMode, forKey: .agentMode)
        if attachments.isEmpty {
            try container.encodeNil(forKey: .attachments)
        } else {
            try container.encode(attachments, forKey: .attachments)
        }
    }
}

/// `SendInputResult` — whether the host ran the turn now or queued it behind
/// one already running.
struct SendInputResult: Decodable, Sendable {
    var ok: Bool
    var queued: Bool
}

/// `ProvidersTerminateInput`.
struct TerminateSessionInput: Encodable, Sendable {
    var sessionId: String
}

/// `ProvidersCancelQueuedMessageInput`.
struct CancelQueuedMessageInput: Encodable, Sendable {
    var sessionId: String
    var messageId: String
}

/// `ProvidersSendQueuedMessageNowInput`. `delivery` always goes out —
/// `useSessionCommands.ts` defaults it to `"interrupt"` rather than omitting
/// it. `"steer"` puts the row into the running turn without stopping it, and
/// the page says per row whether that is on offer (`NativeQueuedMessage`).
struct SendQueuedMessageNowInput: Encodable, Sendable {
    var sessionId: String
    var messageId: String
    var delivery = "interrupt"
}

/// `SessionMultitaskInput` — run a queued follow-up now as its own chat in
/// this checkout, leaving the turn that is running alone. Naming the row
/// claims it in the same operation, so it cannot also drain as a turn.
struct MultitaskInput: Encodable, Sendable {
    var sessionId: String
    var prompt: String
    var pendingMessageId: String?

    enum CodingKeys: String, CodingKey {
        case sessionId, prompt, pendingMessageId, taskLabel
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(prompt, forKey: .prompt)
        try container.encodeAlways(pendingMessageId, forKey: .pendingMessageId)
        // The host falls back to the prompt's first line, and the auto-title
        // call that follows renames the chat — the same order the desktop
        // dispatches a multitask in. `worktree` is left off: it defaults to
        // false, which is the whole point of a multitask.
        try container.encodeNil(forKey: .taskLabel)
    }
}

/// `MultitaskLaunched`.
struct MultitaskLaunched: Decodable, Sendable {
    var sessionId: String
    var workspaceId: String
    var taskLabel: String
}

// MARK: - Row actions

/// `WorkspacesSetPinnedInput`.
struct SetPinnedInput: Encodable, Sendable {
    var workspaceId: String
    var pinned: Bool
}

/// `WorkspacesSetLabelInput`. `taskLabel` is the chat's name.
struct SetLabelInput: Encodable, Sendable {
    var workspaceId: String
    var taskLabel: String
}

/// `WorkspacesArchiveInput`. `force` moves a dirty worktree to recovery
/// storage; without it the host answers `kept` and changes nothing.
struct ArchiveWorkspaceInput: Encodable, Sendable {
    var workspaceId: String
    var force: Bool
}

/// `WorkspaceArchiveResult`. A `kept` workspace is the host saying it found
/// uncommitted changes the caller's snapshot had not.
struct WorkspaceArchiveResult: Decodable, Sendable {
    var workspace: WorkspaceSummary
    var recoveryPath: String?
}

/// `SessionForkInput`. The host refuses a running or waiting session.
struct ForkSessionInput: Encodable, Sendable {
    var sessionId: String
}

/// `SessionForkResult` — the copy, in its own workspace.
struct SessionForkResult: Decodable, Sendable {
    var workspace: WorkspaceSummary
    var session: SessionSummary
}

/// `SystemOk`, the host's answer to a call with nothing to return.
struct HostOk: Decodable, Sendable {
    var ok: Bool
}

// MARK: - Push notifications

/// `RemotePushCapability`. Whether the Mac holds an APNs auth key at all,
/// which is the one thing worth knowing before iOS is asked for permission:
/// asking and then never sending anything is worse than not asking.
///
/// A read, and the only one of the four push channels that is
/// (`src/shared/remoteReadChannels.json`).
struct PushCapability: Decodable, Sendable {
    var configured: Bool
}

/// `RemotePushDevice` — one phone as `remote.json` lists it.
struct PushDevice: Decodable, Sendable, Identifiable {
    var token: String
    var name: String
    var registeredAt: String

    var id: String { token }
}

/// `RemoteRegisterPushDeviceInput`. The host lowercases the token and treats
/// one it already holds as a rename plus a fresher timestamp, never a second
/// row, which is what lets the app re-register on every launch.
struct RegisterPushDeviceInput: Encodable, Sendable {
    var token: String
    var name: String
}

/// `RemoteUnregisterPushDeviceInput`.
struct UnregisterPushDeviceInput: Encodable, Sendable {
    var token: String
}

/// `RemotePushTestResult` — one row per paired phone, so a single retired
/// token does not read as a broken auth key.
struct PushTestResult: Decodable, Sendable {
    var token: String
    var name: String
    var ok: Bool
    var error: String?
}

// MARK: - Calls

extension BridgeClient {
    // Reads. No operation record, per src/shared/remoteReadChannels.json.

    func listProjects() async throws -> [ProjectSummary] {
        try await request("projects:list", as: [ProjectSummary].self)
    }

    func listBranches(projectID: String) async throws -> [String] {
        try await request(
            "projects:list-branches",
            input: ListBranchesInput(projectId: projectID),
            as: [String].self
        )
    }

    func discoverProviders(refresh: Bool = false) async throws -> [ProviderCapability] {
        try await request(
            "providers:discover",
            input: DiscoverProvidersInput(refresh: refresh),
            as: [ProviderCapability].self
        )
    }

    func pushCapability() async throws -> PushCapability {
        try await request("remote:push-capability", as: PushCapability.self)
    }

    /// What each provider login says is left of its included usage. The Mac
    /// calls five provider endpoints behind a 10-second timeout, so this is
    /// a screen-opens read, never a poll. See Settings/PlanLimits.swift.
    func planLimits() async throws -> PlanLimits {
        try await request("usage:remaining", as: PlanLimits.self)
    }

    // Mutations. Each carries a fresh `operation`, and none is retried.

    func createWorkspace(_ creation: WorkspaceCreation) async throws -> WorkspaceSummary {
        switch creation {
        case .isolated(let input):
            return try await request(creation.channel, input: input, as: WorkspaceSummary.self)
        case .current(let input):
            return try await request(creation.channel, input: input, as: WorkspaceSummary.self)
        case .scratch(let input):
            return try await request(creation.channel, input: input, as: WorkspaceSummary.self)
        }
    }

    func launchSession(_ input: LaunchSessionInput) async throws -> SessionSummary {
        try await request("providers:launch", input: input, as: SessionSummary.self)
    }

    @discardableResult
    func autoTitleWorkspace(_ input: AutoTitleWorkspaceInput) async throws -> HostOk {
        try await request("workspaces:autotitle", input: input, as: HostOk.self)
    }

    @discardableResult
    func setPinned(workspaceID: String, pinned: Bool) async throws -> WorkspaceSummary {
        try await request(
            "workspaces:set-pinned",
            input: SetPinnedInput(workspaceId: workspaceID, pinned: pinned),
            as: WorkspaceSummary.self
        )
    }

    @discardableResult
    func setLabel(workspaceID: String, taskLabel: String) async throws -> WorkspaceSummary {
        try await request(
            "workspaces:set-label",
            input: SetLabelInput(workspaceId: workspaceID, taskLabel: taskLabel),
            as: WorkspaceSummary.self
        )
    }

    func archiveWorkspace(workspaceID: String, force: Bool) async throws -> WorkspaceArchiveResult {
        try await request(
            "workspaces:archive",
            input: ArchiveWorkspaceInput(workspaceId: workspaceID, force: force),
            as: WorkspaceArchiveResult.self
        )
    }

    func forkSession(sessionID: String) async throws -> SessionForkResult {
        try await request(
            "session:fork",
            input: ForkSessionInput(sessionId: sessionID),
            as: SessionForkResult.self
        )
    }

    /// Send (or queue, if the turn is running) a follow-up from the native
    /// composer.
    @discardableResult
    func sendInput(_ input: SendInputInput) async throws -> SendInputResult {
        try await request("providers:send-input", input: input, as: SendInputResult.self)
    }

    /// Store one picked image on the Mac, answering with the path the send
    /// then references. A mutation: it writes a file under the host's
    /// attachment root.
    func saveAttachmentImage(_ input: SaveAttachmentImageInput) async throws -> SaveAttachmentImageResult {
        try await request("attachments:save-image", input: input, as: SaveAttachmentImageResult.self)
    }

    @discardableResult
    func terminateSession(sessionID: String) async throws -> HostOk {
        try await request(
            "providers:terminate",
            input: TerminateSessionInput(sessionId: sessionID),
            as: HostOk.self
        )
    }

    @discardableResult
    func cancelQueuedMessage(sessionID: String, messageID: String) async throws -> HostOk {
        try await request(
            "providers:cancel-queued-message",
            input: CancelQueuedMessageInput(sessionId: sessionID, messageId: messageID),
            as: HostOk.self
        )
    }

    @discardableResult
    func sendQueuedMessageNow(
        sessionID: String,
        messageID: String,
        delivery: String = "interrupt"
    ) async throws -> SendInputResult {
        try await request(
            "providers:send-queued-message-now",
            input: SendQueuedMessageNowInput(
                sessionId: sessionID,
                messageId: messageID,
                delivery: delivery
            ),
            as: SendInputResult.self
        )
    }

    /// Dispatch a queued follow-up as a multitask.
    func multitask(sessionID: String, prompt: String, pendingMessageID: String?) async throws -> MultitaskLaunched {
        try await request(
            "session:multitask",
            input: MultitaskInput(
                sessionId: sessionID,
                prompt: prompt,
                pendingMessageId: pendingMessageID
            ),
            as: MultitaskLaunched.self
        )
    }

    /// Register this phone for push, answering with every phone the Mac now
    /// holds. A mutation because it writes `remote.json`.
    @discardableResult
    func registerPushDevice(token: String, name: String) async throws -> [PushDevice] {
        try await request(
            "remote:register-push-device",
            input: RegisterPushDeviceInput(token: token, name: name),
            as: [PushDevice].self
        )
    }

    @discardableResult
    func unregisterPushDevice(token: String) async throws -> [PushDevice] {
        try await request(
            "remote:unregister-push-device",
            input: UnregisterPushDeviceInput(token: token),
            as: [PushDevice].self
        )
    }

    /// Push one notification to every phone the Mac lists. The answer is per
    /// device, and this phone reads its own row.
    func sendTestPush() async throws -> [PushTestResult] {
        try await request("remote:push-test", as: [PushTestResult].self)
    }
}

// MARK: - Failure copy

/// One line for a failed call, in the host's own words when it has any.
///
/// The design brief's rule for an error state: one line of copy, one action.
/// A `BridgeError.host` message is written for a person and says what the
/// backend actually refused, so it is used verbatim rather than flattened
/// into a category.
func hostFailureMessage(_ error: Error) -> String {
    guard let bridge = error as? BridgeError else { return "That didn't work." }
    switch bridge {
    case .host(_, _, let message): return message
    case .disconnected: return "Can't reach your Mac."
    case .authenticationFailed, .unusablePairingLink: return "Pair with your Mac again."
    case .malformedResponse: return "Your Mac sent something this app can't read."
    }
}
