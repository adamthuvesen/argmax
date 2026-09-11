import XCTest

@testable import Argmax

/// The seam between the navigation stack and the one shared web view.
///
/// The page reports `session` and `composer` *on change*, so anything native
/// throws away it cannot ask for again. These are the two ways the stack used
/// to throw it away: opening the chat that is already open, and a duplicate
/// screen for it leaving.
@MainActor
final class TranscriptHostTests: XCTestCase {
    private func host() -> TranscriptHost {
        let host = TranscriptHost(
            pairingURL: URL(string: "https://mac.example.ts.net/mobile.html#token=abc")!,
            evaluate: { _ in }
        )
        host.receive(.ready)
        return host
    }

    private func composer(_ sessionID: String) -> NativeComposerState {
        NativeComposerState(
            sessionId: sessionID,
            provider: "codex",
            modelId: "gpt-5.6-sol",
            modelLabel: "GPT-5.6 Sol",
            effort: "medium",
            efforts: ["low", "medium", "high"],
            queued: [],
            running: false
        )
    }

    private func session(_ sessionID: String) -> NativeSession {
        NativeSession(sessionId: sessionID, title: "Improve Alfred", state: .complete, attention: .normal)
    }

    /// A second screen for the chat already on screen must not blank the
    /// header and the composer: the page sees no change, so it never reports
    /// again and nothing would refill them.
    func testReopeningTheOpenChatKeepsWhatThePageReported() {
        let host = host()
        let screen = UUID()
        host.claim(screen)
        host.openSession("session-1")
        host.receive(.session(session("session-1")))
        host.receive(.composer(composer("session-1")))

        host.claim(UUID())
        host.openSession("session-1")

        XCTAssertEqual(host.session?.sessionId, "session-1")
        XCTAssertEqual(host.composer?.sessionId, "session-1")
    }

    /// Switching chats still forgets: held on, the report is the previous
    /// chat's title drawn over the one being opened.
    func testOpeningAnotherChatForgetsTheLastReport() {
        let host = host()
        host.claim(UUID())
        host.openSession("session-1")
        host.receive(.session(session("session-1")))
        host.receive(.composer(composer("session-1")))

        host.openSession("session-2")

        XCTAssertNil(host.session)
        XCTAssertNil(host.composer)
    }

    /// `onDisappear` is not ordered against the next screen's `onAppear`, so
    /// a screen that has already handed the page on tears nothing down.
    func testOnlyTheOwningScreenCanParkThePage() {
        let host = host()
        let first = UUID()
        let second = UUID()
        host.claim(first)
        host.openSession("session-1")
        host.claim(second)
        host.openSession("session-1")
        host.receive(.session(session("session-1")))
        host.receive(.composer(composer("session-1")))

        XCTAssertFalse(host.relinquish(first))
        XCTAssertEqual(host.composer?.sessionId, "session-1")

        XCTAssertTrue(host.relinquish(second))
    }

    /// And the page it parked stays parked: a later report about the chat it
    /// left is not drawn.
    func testAParkedPageIgnoresLateReports() {
        let host = host()
        let screen = UUID()
        host.claim(screen)
        host.openSession("session-1")
        XCTAssertTrue(host.relinquish(screen))
        host.closeSession()

        host.receive(.composer(composer("session-1")))

        XCTAssertNil(host.composer)
    }
}
