import XCTest
@testable import Argmax

final class MobileTranscriptRowsTests: XCTestCase {
    func testCompactFoldsAlternatingThoughtsAndToolsBetweenMessages() {
        let items = [message("user", user: true), thought("thought-1"), tools("tool-1"), thought("thought-2"), tools("tool-2"), message("answer")]
        let rows = MobileTranscriptRow.rows(items, detail: .compact)
        XCTAssertEqual(rows.count, 3)
        guard case .activity(let activity) = rows[1] else { return XCTFail("expected folded activity") }
        XCTAssertEqual(activity.map(\.id), ["thought-1", "tool-1", "thought-2", "tool-2"])
        XCTAssertEqual(rows.last, .item(items.last!))
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    func testMinimalFoldsNarrationButKeepsFinalAnswersAndTurnBoundaries() {
        let items = [message("user-1", user: true), message("narration"), tools("work"), message("answer-1"), message("user-2", user: true), thought("thought"), message("answer-2")]
        let minimal = MobileTranscriptRow.rows(items, detail: .minimal)
        XCTAssertEqual(minimal.count, 6)
        guard case .activity(let activity) = minimal[1] else { return XCTFail("expected work") }
        XCTAssertEqual(activity.map(\.id), ["narration", "work"])
        XCTAssertTrue(minimal.contains(.item(items[3])))
        XCTAssertTrue(minimal.contains(.item(items[6])))
        XCTAssertEqual(MobileTranscriptRow.rows(items, detail: .compact).count, 7)
    }

    /// A failed tool call is work the agent usually recovers from in its next
    /// call, so it folds with the rest of the work. A session error and an
    /// outstanding question are addressed to the reader and never fold.
    func testFailedToolsFoldWithTheWorkWhileErrorsAndRequestsStayVisible() {
        let failed = tools("failed", status: .failed)
        let error = TranscriptItem.error(.init(id: "error", message: "Connection failed", code: nil, operation: nil, createdAt: "1"))
        let question = TranscriptItem.question(.init(id: "question", toolUseId: "ask", createdAt: "1", questions: [], isOutstanding: true))
        for detail in MobileChatDetail.allCases {
            let rows = MobileTranscriptRow.rows([thought("thinking"), failed, error, question], detail: detail)
            XCTAssertTrue(rows.contains(.item(error)))
            XCTAssertTrue(rows.contains(.item(question)))
            if detail == .minimal || detail == .compact {
                XCTAssertFalse(rows.contains(.item(failed)))
                XCTAssertTrue(rows.contains(.activity([thought("thinking"), failed])))
            } else {
                XCTAssertTrue(rows.contains(.item(failed)))
            }
        }
    }

    func testHigherLevelsKeepStepsIndividuallyInspectableAndEmptyInputIsEmpty() {
        let items = [thought("thought"), tools("tools"), message("answer")]
        for detail in [MobileChatDetail.balanced, .detailed] {
            XCTAssertEqual(MobileTranscriptRow.rows(items, detail: detail), items.map(MobileTranscriptRow.item))
        }
        XCTAssertTrue(MobileTranscriptRow.rows([], detail: .compact).isEmpty)
    }

    func testMinimalKeepsTheLatestMessageWhileMoreWorkIsRunning() {
        let update = message("latest-update")
        let rows = MobileTranscriptRow.rows([update, tools("running", status: .running)], detail: .minimal)
        XCTAssertEqual(rows.first, .item(update))
    }

    func testActivityHeadlineUsesObservedLifecycleAndKeepsEachKind() {
        let read = tool(
            "read", kind: .read, status: .done, completionObserved: true,
            targets: ["Sources/App.swift", "Sources/Store.swift"]
        )
        let command = tool("command", kind: .command, status: .done, completionObserved: true)
        let failedEdit = tool("edit", kind: .edit, status: .failed, completionObserved: true)

        XCTAssertEqual(
            TranscriptToolActivity.summary(for: [read, command, failedEdit]).headline,
            "Read files, ran a command, file change failed"
        )
        XCTAssertEqual(TranscriptToolActivity.summary(for: [read, command]).iconKind, .read)
    }

    private func message(_ id: String, user: Bool = false) -> TranscriptItem {
        let message = TranscriptMessage(id: id, role: user ? .user : .assistant, text: id, createdAt: "1", isStreaming: false, isSteering: false, originLabel: nil, attachments: [])
        return user ? .user(message) : .assistant(message)
    }

    private func thought(_ id: String) -> TranscriptItem {
        .thought(.init(id: id, text: "Preparing the patch", createdAt: "1", isStreaming: false))
    }

    private func tools(_ id: String, status: TranscriptToolStatus = .done) -> TranscriptItem {
        .tools(.init(id: id, tools: [.init(id: id + "-tool", toolUseId: id, name: "Bash", summary: "Run command", input: nil, output: nil, error: nil, status: status, createdAt: "1", completedAt: nil, filePath: nil, fileLabel: nil)], createdAt: "1"))
    }

    private func tool(
        _ id: String,
        kind: TranscriptToolActivityKind,
        status: TranscriptToolStatus,
        completionObserved: Bool,
        targets: [String] = []
    ) -> TranscriptTool {
        TranscriptTool(
            id: id, toolUseId: id, name: id, summary: "", input: nil, output: nil, error: nil,
            status: status, createdAt: "1", completedAt: completionObserved ? "2" : nil,
            filePath: nil, fileLabel: nil,
            activity: TranscriptToolActivity(
                version: 1, kind: kind, evidence: .native, targets: targets,
                operation: nil, toolCount: nil
            ),
            completionObserved: completionObserved
        )
    }
}
