import XCTest
@testable import Argmax

final class TranscriptThinkingTests: XCTestCase {
    private let session = NativeSession(sessionId: "session", title: "Chat", state: .running, attention: .normal)

    @MainActor
    func testLocalSendCueSurvivesUserEchoAndEndsAtAssistantContent() {
        let store = TranscriptStore(client: previewClient())
        let metadata = TranscriptSessionMetadata(id: "session", workspaceId: "workspace", provider: "claude", modelLabel: "Opus", modelId: "opus", prompt: "", state: .complete, attention: .normal, reasoningEffort: nil, agentMode: "auto")
        store.preview(page: page([]), metadata: metadata)
        let start = store.beginThinking()
        XCTAssertEqual(store.thinkingStart, start)
        store.ingest(page: page([event("user", type: "user.message")]), for: "session")
        XCTAssertEqual(store.thinkingStart, start)
        store.ingest(page: page([event("answer", type: "message.delta")]), for: "session")
        XCTAssertNil(store.thinkingStart)
        let failed = store.beginThinking()
        store.cancelThinking(failed)
        XCTAssertNil(store.thinkingStart)
        _ = store.beginThinking()
        store.closeSession()
        XCTAssertNil(store.thinkingStart)
    }

    private func event(_ id: String, type: String) -> TranscriptEvent {
        .init(id: id, sessionId: "session", type: type, message: id, payload: .object([:]), createdAt: "2026-09-12T10:00:00Z", rowCursor: nil)
    }

    private func page(_ events: [TranscriptEvent]) -> TranscriptPage {
        .init(events: events, rawOutputs: [], eventCursor: 0, rawOutputCursor: 0, changeCursor: nil, deletedEventIds: [], deletedRawOutputIds: [], resetRequired: false, hasMore: false)
    }

    func testSilentGapYieldsToContentAndReturnsAfterToolCompletion() {
        let user = message("user", user: true)
        XCTAssertNotNil(TranscriptThinking.current(items: [user], session: session))
        XCTAssertNil(TranscriptThinking.current(items: [user, message("answer", streaming: true)], session: session))
        XCTAssertNil(TranscriptThinking.current(items: [user, message("answer")], session: session))
        XCTAssertNil(TranscriptThinking.current(items: [user, .thought(.init(id: "thought", text: "Reasoning", createdAt: "2", isStreaming: true))], session: session))
        XCTAssertNil(TranscriptThinking.current(items: [user, tool(.running)], session: session))
        let gap = TranscriptThinking.current(items: [user, tool(.done)], session: session)
        XCTAssertEqual(gap?.startedAt, "2026-09-12T10:00:05Z")
        XCTAssertEqual(gap, TranscriptThinking.current(items: [user, tool(.done)], session: session))
        XCTAssertEqual(gap?.word, TranscriptThinking.current(items: [user, tool(.done)], session: session)?.word)
    }

    func testPreviousTurnAndSteeringDoNotRestartOrSuppressGap() {
        let user = message("user", user: true)
        let gap = TranscriptThinking.current(items: [user], session: session)
        XCTAssertEqual(gap, TranscriptThinking.current(items: [tool(.running), user], session: session))
        var steer = TranscriptMessage(id: "steer", role: .user, text: "Also", createdAt: "3", isStreaming: false, isSteering: false, originLabel: nil, attachments: [])
        steer.isSteering = true
        XCTAssertEqual(gap, TranscriptThinking.current(items: [user, .user(steer)], session: session))
    }

    func testStopsForFinishedSessionAndOutstandingQuestion() {
        var finished = session
        finished.state = .complete
        XCTAssertNil(TranscriptThinking.current(items: [], session: finished))
        let question = TranscriptItem.question(.init(id: "question", toolUseId: "ask", createdAt: "1", questions: [], isOutstanding: true))
        XCTAssertNil(TranscriptThinking.current(items: [question], session: session))
    }

    private func message(_ id: String, user: Bool = false, streaming: Bool = false) -> TranscriptItem {
        let value = TranscriptMessage(id: id, role: user ? .user : .assistant, text: id, createdAt: "2026-09-12T10:00:00Z", isStreaming: streaming, isSteering: false, originLabel: nil, attachments: [])
        return user ? .user(value) : .assistant(value)
    }

    private func tool(_ status: TranscriptToolStatus) -> TranscriptItem {
        .tools(.init(id: "tools", tools: [.init(id: "tool", toolUseId: "tool", name: "Bash", summary: "Run", input: nil, output: nil, error: nil, status: status, createdAt: "2026-09-12T10:00:01Z", completedAt: status == .running ? nil : "2026-09-12T10:00:05Z", filePath: nil, fileLabel: nil)], createdAt: "2026-09-12T10:00:01Z"))
    }
}
