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

    func testFailuresAndRequestsRemainVisibleAtEveryLevel() {
        let failed = tools("failed", status: .failed)
        let error = TranscriptItem.error(.init(id: "error", message: "Connection failed", code: nil, operation: nil, createdAt: "1"))
        let question = TranscriptItem.question(.init(id: "question", toolUseId: "ask", createdAt: "1", questions: [], isOutstanding: true))
        for detail in MobileChatDetail.allCases {
            let rows = MobileTranscriptRow.rows([thought("thinking"), failed, error, question], detail: detail)
            XCTAssertTrue(rows.contains(.item(failed)))
            XCTAssertTrue(rows.contains(.item(error)))
            XCTAssertTrue(rows.contains(.item(question)))
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
}
