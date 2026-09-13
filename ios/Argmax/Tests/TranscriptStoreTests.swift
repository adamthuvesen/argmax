import XCTest
@testable import Argmax

@MainActor
final class TranscriptStoreTests: XCTestCase {
    func testOpeningWaitsForTheLatestHistoryPageBeforePublishing() async throws {
        let store = try makeStore()
        store.openSession("session-1")
        defer { store.closeSession() }
        var first = page(events: [event("old", "message.completed", "Older answer", 1)], cursor: 1)
        first.hasMore = true
        store.ingest(page: first, for: "session-1", authoritative: true)
        await store.waitForProjection()

        XCTAssertTrue(store.items.isEmpty, "Opening must not show an intermediate history tail")

        store.ingest(page: page(events: [event("latest", "message.completed", "Latest answer", 2)],
                                cursor: 2, reset: false), for: "session-1")
        await store.waitForProjection()
        XCTAssertEqual(assistantTexts(store.items), ["Older answerLatest answer"])
    }

    func testClearHidesOpeningPromptAndEarlierRawOutput() async throws {
        let store = try makeStore()
        var snapshot = page(events: [event("clear", "session.cleared", "Cleared", 2)])
        snapshot.rawOutputs = [TranscriptRawOutput(
            id: "old-output", sessionId: "session-1", stream: "stderr",
            content: "Old human-readable error", createdAt: "2026-01-01T00:00:01.000Z", rowCursor: 1
        )]
        store.preview(page: snapshot, metadata: sessionMetadata(id: "session-1"))
        XCTAssertTrue(store.items.isEmpty)

        var next = page(events: [], cursor: 3, changeCursor: 4, reset: false)
        next.rawOutputs = [TranscriptRawOutput(
            id: "new-output", sessionId: "session-1", stream: "stderr",
            content: "New human-readable error", createdAt: "2026-01-01T00:00:03.000Z", rowCursor: 3
        )]
        store.ingest(page: next, for: "session-1")
        await store.waitForProjection()
        XCTAssertEqual(store.items.count, 1)
        guard case .error(let output) = store.items[0] else { return XCTFail("expected raw error") }
        XCTAssertEqual(output.message, "New human-readable error")
    }

    func testStaleOwnerCannotCloseNewerScreen() throws {
        let store = try makeStore()
        let first = UUID()
        let second = UUID()

        store.claim(first, sessionID: "session-1")
        store.claim(second, sessionID: "session-2")

        XCTAssertFalse(store.relinquish(first))
        XCTAssertEqual(store.sessionID, "session-2")
        XCTAssertTrue(store.relinquish(second))
        XCTAssertNil(store.sessionID)
        XCTAssertEqual(store.phase, .idle)
    }

    func testPageMergeAppliesEditsDeletionsAndAuthoritativeReset() async throws {
        let store = try makeStore()
        let metadata = sessionMetadata(id: "session-1")
        store.preview(
            page: page(events: [event("user", "user.message", "Go", 1), event("answer", "message.completed", "Old", 2)]),
            metadata: metadata,
            title: "Native transcript"
        )

        store.ingest(
            page: page(
                events: [event("answer-2", "message.completed", "New", 3)],
                deleted: ["answer"],
                cursor: 3,
                changeCursor: 4,
                reset: false
            ),
            for: "session-1"
        )
        await store.waitForProjection()
        XCTAssertEqual(assistantTexts(store.items), ["New"])

        store.ingest(
            page: page(events: [event("replacement", "user.message", "Fresh chat", 8)], cursor: 8, changeCursor: 9),
            for: "session-1",
            authoritative: true
        )
        await store.waitForProjection()
        XCTAssertEqual(store.items.count, 1)
        guard case .user(let message) = store.items[0] else { return XCTFail("expected reset user") }
        XCTAssertEqual(message.text, "Fresh chat")
    }

    func testTraceSupersessionActsAsATombstone() async throws {
        let store = try makeStore()
        store.preview(
            page: page(events: [event("synthetic", "message.completed", "Synthetic", 1)]),
            metadata: sessionMetadata(id: "session-1")
        )
        XCTAssertEqual(assistantTexts(store.items), ["Synthetic"])

        store.ingest(
            page: page(events: [event(
                "synthetic",
                "message.completed",
                "Synthetic",
                1,
                ["traceSyntheticSuperseded": .bool(true)]
            )], cursor: 1, changeCursor: 2, reset: false),
            for: "session-1"
        )
        await store.waitForProjection()
        XCTAssertTrue(assistantTexts(store.items).isEmpty)
        await store.waitForProjection()
        XCTAssertEqual(store.items.count, 1)
        guard case .user(let prompt) = store.items[0] else { return XCTFail("expected opening prompt") }
        XCTAssertEqual(prompt.text, "Go")
    }

    func testRichDashboardDecodesComposerMetadataAndPendingMessages() throws {
        let data = Data(
            """
            {"sessions":[{"id":"s","workspaceId":"w","provider":"codex","modelLabel":"Astra",
              "modelId":"gpt-6-astra","prompt":"Go","state":"running","attention":"normal",
              "reasoningEffort":"high","agentMode":"auto"}],
             "workspaces":[{"id":"w","taskLabel":"Native transcript","path":"/Users/dev/argmax"}],
             "pendingMessages":{"s":[{"id":"p","sessionId":"s","content":"Then test",
               "agentMode":"auto","modelLabel":null,"modelId":"gpt-6-astra","reasoningEffort":"high",
               "recoveryStatus":null,"queuedAt":"2026-01-01T00:00:00Z","fastMode":false,
               "attachments":[],"agentReferences":[]}]}}
            """.utf8
        )
        let snapshot = try JSONDecoder().decode(TranscriptDashboardSnapshot.self, from: data)
        XCTAssertEqual(snapshot.sessions.first?.reasoningEffort, "high")
        XCTAssertEqual(snapshot.workspaces.first?.path, "/Users/dev/argmax")
        XCTAssertEqual(snapshot.pendingMessages["s"]?.first?.content, "Then test")
    }

    func testAuthoritativeDashboardRemovesAQueuedMessageMissingFromHostSnapshot() throws {
        let store = try makeStore()
        let pending = TranscriptPendingMessage(
            id: "queued-1",
            sessionId: "session-1",
            content: "Then test",
            agentMode: "auto",
            modelLabel: nil,
            modelId: nil,
            reasoningEffort: nil,
            recoveryStatus: nil,
            queuedAt: "2026-01-01T00:00:00.000Z"
        )
        store.preview(
            page: page(events: []),
            metadata: sessionMetadata(id: "session-1"),
            pendingMessages: [pending]
        )
        XCTAssertEqual(store.composer?.queued.map(\.id), ["queued-1"])

        let authoritative = try JSONDecoder().decode(
            TranscriptDashboardSnapshot.self,
            from: Data(
                """
                {"sessions":[{"id":"session-1","workspaceId":"workspace-1","provider":"claude",
                  "modelLabel":"Opus","modelId":"claude-opus","prompt":"Go","state":"complete",
                  "attention":"normal","reasoningEffort":"high","agentMode":"auto"}],
                 "workspaces":[{"id":"workspace-1","taskLabel":"Native transcript","path":"/Users/dev/argmax"}],
                 "pendingMessages":{}}
                """.utf8
            )
        )
        store.receive(snapshot: authoritative)

        XCTAssertTrue(store.composer?.queued.isEmpty == true)
    }

    func testDashboardWorkspacePathPropagatesIntoToolProjection() async throws {
        let store = try makeStore()
        let path = "/Users/dev/argmax/src/App.swift"
        store.preview(
            page: page(events: [event("edit", "command.started", "Edit", 1, [
                "id": .string("tool-1"),
                "name": .string("Edit"),
                "input": .object(["file_path": .string(path)])
            ])]),
            metadata: sessionMetadata(id: "session-1")
        )
        var workspace = previewWorkspace
        workspace.id = "workspace-1"
        workspace.path = "/Users/dev/argmax"
        var session = previewSession
        session.id = "session-1"
        session.workspaceId = workspace.id
        store.receive(snapshot: DashboardSnapshot(workspaces: [workspace], sessions: [session]))

        await store.waitForProjection()
        let tool = try XCTUnwrap(store.items.compactMap { item -> TranscriptTool? in
            guard case .tools(let group) = item else { return nil }
            return group.tools.first
        }.first)

        XCTAssertEqual(tool.summary, "File change")
        XCTAssertEqual(tool.fileLabel, "src/App.swift")
        XCTAssertEqual(tool.filePath, path)
    }

    func testRecentChatPaintsImmediatelyAndRemovalCancelsCachedWrite() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DeviceCache(directory: directory)
        let client = try BridgeClient(pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=cache-test")), monitorNetwork: false)
        let store = TranscriptStore(client: client, cache: cache)
        store.preview(page: page(events: [event("a", "message.completed", "Saved answer", 1)]), metadata: sessionMetadata(id: "session-1"))
        store.ingest(page: page(events: [event("a", "message.completed", "Saved answer", 1)]), for: "session-1")
        await store.waitForProjection()
        await store.flushCache()
        store.closeSession()
        store.openSession("session-1")
        XCTAssertEqual(assistantTexts(store.items), ["Saved answer"])
        XCTAssertTrue(store.showingCachedContent)
        store.receive(connection: .live)
        store.ingest(page: page(events: [event("a", "message.completed", "Changed answer", 2)]), for: "session-1")
        XCTAssertTrue(store.showingCachedContent, "Cached rows remain on screen until projection finishes")
        await store.waitForProjection()
        XCTAssertFalse(store.showingCachedContent)
        XCTAssertEqual(assistantTexts(store.items), ["Changed answer"])
        store.receive(snapshot: DashboardSnapshot())
        await store.flushCache()
        XCTAssertNil(store.sessionID)
        XCTAssertNil(store.composer)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(store.failure, "This chat is no longer available on the Mac.")
        store.receive(connection: .live)
        XCTAssertEqual(store.failure, "This chat is no longer available on the Mac.")
        await client.disconnect()
    }

    func testNewerProjectionWinsAndClosingDiscardsQueuedWork() async throws {
        let store = try makeStore()
        store.preview(page: page(events: []), metadata: sessionMetadata(id: "session-1"))
        for index in 1...20 {
            store.ingest(page: page(events: [event("answer", "message.completed", "Answer \(index)", Int64(index))]), for: "session-1")
        }
        await store.waitForProjection()
        XCTAssertEqual(assistantTexts(store.items), ["Answer 20"])
        store.ingest(page: page(events: [event("late", "message.completed", "Late", 30)]), for: "session-1")
        store.closeSession()
        await store.waitForProjection()
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(store.phase, .idle)
    }

    /// A running chat invalidates the projection on every streamed chunk.
    /// The first projection must still reach the screen; waiting for a
    /// quiet moment left the opened chat blank for the whole turn.
    func testStreamingChatPaintsWhileContentKeepsArriving() async throws {
        let store = try makeStore()
        store.openSession("session-1")
        let history = (1...1500).map { index in
            event("answer-\(index)", "message.completed",
                  String(repeating: "Streamed **answer** \(index) with `code` and a [link](https://example.com). ", count: 12),
                  Int64(index))
        }
        store.ingest(page: page(events: history, cursor: 1500, changeCursor: 1500), for: "session-1", authoritative: true)
        XCTAssertEqual(store.phase, .loading)

        // Chunks land faster than a projection completes, for as long as the turn runs.
        let deadline = ContinuousClock.now + .seconds(20)
        var cursor: Int64 = 1500
        while ContinuousClock.now < deadline, store.items.isEmpty {
            cursor += 1
            store.ingest(page: page(events: [event("chunk", "message.completed", "Chunk \(cursor)", cursor)],
                                    cursor: cursor, changeCursor: cursor, reset: false),
                         for: "session-1")
            await Task.yield()
        }

        XCTAssertFalse(store.items.isEmpty, "the chat stayed blank while chunks kept arriving")
        store.closeSession()
        await store.waitForProjection()
    }

    private func makeStore() throws -> TranscriptStore {
        let url = try XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=test"))
        return TranscriptStore(client: try BridgeClient(pairingURL: url))
    }

    private func sessionMetadata(id: String) -> TranscriptSessionMetadata {
        TranscriptSessionMetadata(
            id: id,
            workspaceId: "workspace-1",
            provider: "claude",
            modelLabel: "Opus",
            modelId: "claude-opus",
            prompt: "Go",
            state: .complete,
            attention: .normal,
            reasoningEffort: "high",
            agentMode: "auto"
        )
    }

    private func page(
        events: [TranscriptEvent],
        deleted: [String] = [],
        cursor: Int64 = 2,
        changeCursor: Int64? = 3,
        reset: Bool = true
    ) -> TranscriptPage {
        TranscriptPage(
            events: events,
            rawOutputs: [],
            eventCursor: cursor,
            rawOutputCursor: 0,
            changeCursor: changeCursor,
            deletedEventIds: deleted,
            deletedRawOutputIds: [],
            resetRequired: reset,
            hasMore: false
        )
    }

    private func event(
        _ id: String,
        _ type: String,
        _ message: String,
        _ cursor: Int64,
        _ payload: [String: TranscriptJSONValue] = [:]
    ) -> TranscriptEvent {
        TranscriptEvent(
            id: id,
            sessionId: "session-1",
            type: type,
            message: message,
            payload: .object(payload),
            createdAt: String(format: "2026-01-01T00:00:%02lld.000Z", cursor),
            rowCursor: cursor
        )
    }

    private func assistantTexts(_ items: [TranscriptItem]) -> [String] {
        items.compactMap { item in
            guard case .assistant(let message) = item else { return nil }
            return message.text
        }
    }
}
