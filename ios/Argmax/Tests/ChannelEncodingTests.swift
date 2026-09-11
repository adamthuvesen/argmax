import XCTest
@testable import Argmax

/// What each channel actually puts on the socket.
///
/// The host's input structs are `deny_unknown_fields` and its dispatcher
/// refuses a mutation that arrives without an operation record, so the two
/// things worth pinning are the exact key set and whether `operation` is
/// there. Both are read out of the encoded frame rather than asserted about
/// the Swift struct, because the frame is what the Mac sees.
final class ChannelEncodingTests: XCTestCase {
    /// A defaults suite of its own: `RemoteOperation.mint` writes an install
    /// id, and a test must not adopt or clobber the app's.
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        let suite = "argmax.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: defaults.description)
        defaults = nil
    }

    /// One request, as a dictionary.
    private func frame(_ channel: String, _ input: some Encodable & Sendable) throws -> [String: Any] {
        let data = try BridgeClient.encodeRequestFrame(id: 7, channel: channel, input: input, defaults: defaults)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func input(_ channel: String, _ input: some Encodable & Sendable) throws -> [String: Any] {
        try XCTUnwrap(try frame(channel, input)["input"] as? [String: Any])
    }

    private func operation(_ frame: [String: Any]) -> [String: Any]? {
        frame["operation"] as? [String: Any]
    }

    // MARK: - The read/mutation split

    func testReadsCarryNoOperation() throws {
        for channel in [
            "projects:list",
            "projects:list-branches",
            "providers:discover",
            "remote:push-capability"
        ] {
            let sent = try frame(channel, EmptyInput())
            XCTAssertNil(operation(sent), "\(channel) is a read and must not open an operation record")
        }
    }

    func testEveryMutationCarriesAFreshOperation() throws {
        let channels = [
            "workspaces:create-isolated",
            "workspaces:create-current",
            "workspaces:create-scratch",
            "providers:launch",
            "workspaces:autotitle",
            "workspaces:set-pinned",
            "workspaces:set-label",
            "workspaces:archive",
            "session:fork",
            "remote:register-push-device",
            "remote:unregister-push-device",
            "remote:push-test",
            "providers:send-input",
            "providers:terminate",
            "providers:cancel-queued-message",
            "providers:send-queued-message-now"
        ]
        var operationIDs = Set<String>()
        var clientIDs = Set<String>()
        for channel in channels {
            let sent = try frame(channel, EmptyInput())
            let operation = try XCTUnwrap(self.operation(sent), "\(channel) is a mutation and needs an operation")
            let operationID = try XCTUnwrap(operation["operationId"] as? String)
            let clientID = try XCTUnwrap(operation["clientId"] as? String)
            XCTAssertNotNil(UUID(uuidString: operationID), "operationId must be a UUID the host can key on")
            XCTAssertNotNil(UUID(uuidString: clientID))
            operationIDs.insert(operationID)
            clientIDs.insert(clientID)
        }
        XCTAssertEqual(operationIDs.count, channels.count, "each attempt is its own operation")
        XCTAssertEqual(clientIDs.count, 1, "one install, one client id")
    }

    func testTheFrameNamesTheChannelAndTheRequest() throws {
        let sent = try frame("projects:list", EmptyInput())
        XCTAssertEqual(sent["type"] as? String, "request")
        XCTAssertEqual(sent["id"] as? Int, 7)
        XCTAssertEqual(sent["channel"] as? String, "projects:list")
    }

    // MARK: - Input shapes

    func testCreateIsolatedWorkspace() throws {
        let body = try input(
            "workspaces:create-isolated",
            CreateIsolatedWorkspaceInput(projectId: "p-1", taskLabel: "Tidy the list", baseRef: "main")
        )
        XCTAssertEqual(Set(body.keys), ["projectId", "taskLabel", "baseRef"])
        XCTAssertEqual(body["projectId"] as? String, "p-1")
        XCTAssertEqual(body["taskLabel"] as? String, "Tidy the list")
        XCTAssertEqual(body["baseRef"] as? String, "main")
    }

    /// A nullable field is sent as `null`, not dropped — the renderer sends
    /// `baseRef: null`, and one payload shape is easier to read in a log.
    func testANilBaseRefIsSentAsNull() throws {
        let body = try input(
            "workspaces:create-isolated",
            CreateIsolatedWorkspaceInput(projectId: "p-1", taskLabel: "Tidy", baseRef: nil)
        )
        XCTAssertTrue(body.keys.contains("baseRef"))
        XCTAssertTrue(body["baseRef"] is NSNull)
    }

    func testCreateCurrentWorkspace() throws {
        let body = try input(
            "workspaces:create-current",
            CreateCurrentWorkspaceInput(projectId: "p-1", taskLabel: "Tidy")
        )
        XCTAssertEqual(Set(body.keys), ["projectId", "taskLabel"])
    }

    func testCreateScratchWorkspace() throws {
        let body = try input(
            "workspaces:create-scratch",
            CreateScratchWorkspaceInput(taskLabel: "Ask something", kind: nil)
        )
        XCTAssertEqual(Set(body.keys), ["taskLabel", "kind"])
        XCTAssertTrue(body["kind"] is NSNull, "null is `scratch`; `popup` is the desktop's own workspace")
    }

    func testSetPinned() throws {
        let body = try input("workspaces:set-pinned", SetPinnedInput(workspaceId: "w-1", pinned: true))
        XCTAssertEqual(Set(body.keys), ["workspaceId", "pinned"])
        XCTAssertEqual(body["pinned"] as? Bool, true)
    }

    func testSetLabel() throws {
        let body = try input("workspaces:set-label", SetLabelInput(workspaceId: "w-1", taskLabel: "Renamed"))
        XCTAssertEqual(Set(body.keys), ["workspaceId", "taskLabel"])
        XCTAssertEqual(body["taskLabel"] as? String, "Renamed")
    }

    func testArchive() throws {
        let body = try input("workspaces:archive", ArchiveWorkspaceInput(workspaceId: "w-1", force: true))
        XCTAssertEqual(Set(body.keys), ["workspaceId", "force"])
        XCTAssertEqual(body["force"] as? Bool, true)
    }

    func testFork() throws {
        let body = try input("session:fork", ForkSessionInput(sessionId: "s-1"))
        XCTAssertEqual(Set(body.keys), ["sessionId"])
    }

    func testAutoTitle() throws {
        let body = try input(
            "workspaces:autotitle",
            AutoTitleWorkspaceInput(
                workspaceId: "w-1",
                provider: "claude",
                modelId: "claude-sonnet-5",
                prompt: "Tidy the list"
            )
        )
        XCTAssertEqual(Set(body.keys), ["workspaceId", "provider", "modelId", "prompt"])
        XCTAssertEqual(body["modelId"] as? String, "claude-sonnet-5", "titles ride the cheap model, not the chat's")
    }

    func testListBranches() throws {
        let body = try input("projects:list-branches", ListBranchesInput(projectId: "p-1"))
        XCTAssertEqual(Set(body.keys), ["projectId"])
    }

    func testRegisterPushDevice() throws {
        let body = try input(
            "remote:register-push-device",
            RegisterPushDeviceInput(token: "a1b2c3", name: "Adam’s iPhone")
        )
        XCTAssertEqual(Set(body.keys), ["token", "name"])
        XCTAssertEqual(body["token"] as? String, "a1b2c3")
        XCTAssertEqual(body["name"] as? String, "Adam’s iPhone")
    }

    func testUnregisterPushDevice() throws {
        let body = try input("remote:unregister-push-device", UnregisterPushDeviceInput(token: "a1b2c3"))
        XCTAssertEqual(Set(body.keys), ["token"])
    }

        func testDiscoverProvidersAsksForTheCache() throws {
        let body = try input("providers:discover", DiscoverProvidersInput())
        XCTAssertEqual(body["refresh"] as? Bool, false, "re-probing every CLI takes seconds; the sheet reads the cache")
    }

    // MARK: - The native composer

    /// `ProvidersSendInput`'s field names, pinned to `src/shared/bindings.d.ts`
    /// — `input`, not `prompt`, and `provider` goes out unconditionally, the
    /// way `SessionComposer`'s `deliverDraft` sends it.
    func testSendInput() throws {
        let body = try input(
            "providers:send-input",
            SendInputInput(
                sessionId: "s-1",
                input: "and the tests",
                provider: "codex",
                modelLabel: "GPT-5.6 Terra",
                modelId: "gpt-5.6-terra",
                reasoningEffort: "high",
                agentMode: "auto"
            )
        )
        XCTAssertEqual(
            Set(body.keys),
            ["sessionId", "input", "provider", "modelLabel", "modelId", "reasoningEffort", "fastMode", "agentMode", "attachments"]
        )
        XCTAssertEqual(body["input"] as? String, "and the tests")
        XCTAssertEqual(body["provider"] as? String, "codex")
        XCTAssertEqual(body["fastMode"] as? Bool, false, "a Codex-only control the phone does not surface")
        XCTAssertTrue(body["attachments"] is NSNull, "an empty pick still sends the key")
    }

    /// A send carrying picked images lists them the way the desktop composer
    /// does, beside the `@path` references in the prompt itself.
    func testSendInputWithAttachments() throws {
        let body = try input(
            "providers:send-input",
            SendInputInput(
                sessionId: "s-1",
                input: "look at this @/data/attachments/s-1/a.png",
                provider: "claude",
                modelLabel: "Opus 5",
                modelId: "claude-opus-5",
                reasoningEffort: "medium",
                agentMode: "auto",
                attachments: [
                    ComposerAttachment(filePath: "/data/attachments/s-1/a.png", mimeType: "image/png", sizeBytes: 2048)
                ]
            )
        )
        let attachments = try XCTUnwrap(body["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(Set(attachments[0].keys), ["filePath", "mimeType", "sizeBytes"])
        XCTAssertEqual(attachments[0]["filePath"] as? String, "/data/attachments/s-1/a.png")
        XCTAssertEqual(attachments[0]["sizeBytes"] as? Int, 2048)
    }

    /// Storing the bytes is a mutation: it writes a file on the Mac.
    func testSaveAttachmentImageIsAMutation() throws {
        let frame = try frame(
            "attachments:save-image",
            SaveAttachmentImageInput(sessionId: "s-1", mimeType: "image/png", dataBase64: "AAAA")
        )
        XCTAssertNotNil(operation(frame))
        let body = try XCTUnwrap(frame["input"] as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["sessionId", "mimeType", "dataBase64"])
    }

    /// A model with no effort control sends `reasoningEffort: null`, not a
    /// dropped key — matching every other nullable field this app sends.
    func testSendInputWithNoEffort() throws {
        let body = try input(
            "providers:send-input",
            SendInputInput(
                sessionId: "s-1",
                input: "hi",
                provider: "cursor",
                modelLabel: "Composer",
                modelId: "composer",
                reasoningEffort: nil,
                agentMode: "auto"
            )
        )
        XCTAssertTrue(body["reasoningEffort"] is NSNull)
    }

    func testTerminateSession() throws {
        let body = try input("providers:terminate", TerminateSessionInput(sessionId: "s-1"))
        XCTAssertEqual(Set(body.keys), ["sessionId"])
    }

    func testCancelQueuedMessage() throws {
        let body = try input(
            "providers:cancel-queued-message",
            CancelQueuedMessageInput(sessionId: "s-1", messageId: "pm-1")
        )
        XCTAssertEqual(Set(body.keys), ["sessionId", "messageId"])
    }

    /// `delivery` always goes out, defaulted to `"interrupt"` the way
    /// `useSessionCommands.ts` defaults it rather than omitting the key — the
    /// native composer's queued stack never steers.
    /// Steer puts the row into the running turn without stopping it. The page
    /// says per row whether the session can take that (`canSteer`), so the
    /// only thing pinned here is that the choice reaches the wire.
    func testSendQueuedMessageNowCanSteer() throws {
        let body = try input(
            "providers:send-queued-message-now",
            SendQueuedMessageNowInput(sessionId: "s-1", messageId: "pm-1", delivery: "steer")
        )
        XCTAssertEqual(body["delivery"] as? String, "steer")
    }

    /// A queued follow-up dispatched as its own chat. `taskLabel` goes out as
    /// null — the host falls back to the prompt's first line and the
    /// auto-title call renames it — and `worktree` is left off, so the
    /// multitask shares this checkout.
    func testMultitaskQueued() throws {
        let frame = try frame(
            "session:multitask",
            MultitaskInput(sessionId: "s-1", prompt: "fix the changelog date", pendingMessageId: "pm-1")
        )
        XCTAssertNotNil(operation(frame), "dispatching a chat is a mutation")
        let body = try XCTUnwrap(frame["input"] as? [String: Any])
        XCTAssertEqual(Set(body.keys), ["sessionId", "prompt", "pendingMessageId", "taskLabel"])
        XCTAssertEqual(body["pendingMessageId"] as? String, "pm-1")
        XCTAssertTrue(body["taskLabel"] is NSNull)
    }

    func testSendQueuedMessageNow() throws {
        let body = try input(
            "providers:send-queued-message-now",
            SendQueuedMessageNowInput(sessionId: "s-1", messageId: "pm-1")
        )
        XCTAssertEqual(Set(body.keys), ["sessionId", "messageId", "delivery"])
        XCTAssertEqual(body["delivery"] as? String, "interrupt")
    }
}
