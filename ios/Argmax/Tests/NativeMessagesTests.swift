import XCTest
@testable import Argmax

// The native half of the contract in `src/renderer/mobile/nativeHost.ts`.
// Both directions are pinned here because the page ships separately from the
// app: a rename on either side has to fail a test rather than a transcript.

final class NativeMessageDecodingTests: XCTestCase {
    /// Bodies shaped the way WebKit hands them over — a dictionary of
    /// Foundation values, never JSON text.
    func testDecodesEveryMessageType() {
        XCTAssertEqual(NativeMessage(body: ["type": "ready"]), .ready)
        XCTAssertEqual(NativeMessage(body: ["type": "back"]), .back)
        XCTAssertEqual(NativeMessage(body: ["type": "review", "open": true]), .review(open: true))
        XCTAssertEqual(NativeMessage(body: ["type": "review", "open": false]), .review(open: false))
        XCTAssertEqual(NativeMessage(body: ["type": "agents", "open": true]), .agents(open: true))
        XCTAssertEqual(NativeMessage(body: ["type": "agents", "open": false]), .agents(open: false))
        XCTAssertEqual(NativeMessage(body: ["type": "haptic", "kind": "light"]), .haptic(.light))
        XCTAssertEqual(NativeMessage(body: ["type": "haptic", "kind": "success"]), .haptic(.success))
        XCTAssertEqual(NativeMessage(body: ["type": "haptic", "kind": "warning"]), .haptic(.warning))
        XCTAssertEqual(
            NativeMessage(body: ["type": "error", "message": "Lost the connection to your Mac."]),
            .error(message: "Lost the connection to your Mac.")
        )
        XCTAssertEqual(
            NativeMessage(body: [
                "type": "session",
                "sessionId": "b0e0f4c2-2f1e-4a2f-9c1e-2b3d4e5f6a7b",
                "title": "Wire the review screen",
                "state": "running",
                "attention": "normal"
            ]),
            .session(
                NativeSession(
                    sessionId: "b0e0f4c2-2f1e-4a2f-9c1e-2b3d4e5f6a7b",
                    title: "Wire the review screen",
                    state: .running,
                    attention: .normal
                )
            )
        )
    }

    /// The composer's own state, carried alongside `session` so
    /// `TranscriptComposer` can draw itself without re-deriving the
    /// composer's rules.
    func testDecodesComposerState() {
        XCTAssertEqual(
            NativeMessage(body: [
                "type": "composer",
                "sessionId": "session-1",
                "provider": "codex",
                "modelId": "gpt-5.6-terra",
                "modelLabel": "GPT-5.6 Terra",
                "effort": "medium",
                "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
                "queued": [["id": "pm-1", "text": "and the tests", "canSteer": true]],
                "running": true
            ]),
            .composer(
                NativeComposerState(
                    sessionId: "session-1",
                    provider: "codex",
                    modelId: "gpt-5.6-terra",
                    modelLabel: "GPT-5.6 Terra",
                    effort: "medium",
                    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    queued: [NativeQueuedMessage(id: "pm-1", text: "and the tests", canSteer: true)],
                    running: true
                )
            )
        )
    }

    /// The page is the Mac's renderer and updates on its own schedule, so a
    /// queued row from a build that has never heard of `canSteer` still has
    /// to decode — otherwise the card stops following the chat the moment a
    /// follow-up is queued.
    func testAQueuedRowFromAnOlderPageDecodesWithoutSteer() {
        let message = NativeMessage(body: [
            "type": "composer",
            "sessionId": "session-1",
            "provider": "claude",
            "modelId": "claude-opus-5",
            "modelLabel": "Opus 5",
            "effort": "medium",
            "efforts": ["low", "medium", "high"],
            "queued": [["id": "pm-1", "text": "and the tests"]],
            "running": true
        ])
        guard case .composer(let state) = message else {
            return XCTFail("a queued row without canSteer took the whole message down")
        }
        XCTAssertEqual(state.queued.first?.canSteer, false)
    }

    /// A model with no effort control sends `effort: null` and an empty
    /// ladder rather than omitting the keys.
    func testDecodesComposerStateWithNoEffort() {
        let message = NativeMessage(body: [
            "type": "composer",
            "sessionId": "session-1",
            "provider": "cursor",
            "modelId": "composer",
            "modelLabel": "Composer",
            "effort": NSNull(),
            "efforts": [],
            "queued": [],
            "running": false
        ])
        guard case .composer(let state) = message else { return XCTFail("expected a composer message") }
        XCTAssertNil(state.effort)
        XCTAssertEqual(state.efforts, [])
        XCTAssertEqual(state.queued, [])
        XCTAssertFalse(state.running)
    }

    /// The hyphenated attention spellings are the wire's, not Swift's.
    func testDecodesHyphenatedAttention() {
        let message = NativeMessage(body: [
            "type": "session",
            "sessionId": "s-1",
            "title": "Needs a decision",
            "state": "waiting",
            "attention": "approval-needed"
        ])
        XCTAssertEqual(
            message,
            .session(
                NativeSession(sessionId: "s-1", title: "Needs a decision", state: .waiting, attention: .approvalNeeded)
            )
        )
    }

    /// A host that grows a session state must not blank the native header.
    func testKeepsUnknownEnumValues() {
        let message = NativeMessage(body: [
            "type": "session",
            "sessionId": "s-1",
            "title": "From a newer host",
            "state": "hibernating",
            "attention": "needs-coffee"
        ])
        guard case .session(let open) = message else { return XCTFail("expected a session message") }
        XCTAssertEqual(open.state, .unknown("hibernating"))
        XCTAssertEqual(open.attention, .unknown("needs-coffee"))
    }

    /// The page grows message types first, so an unreadable one is dropped
    /// rather than fatal.
    func testDropsWhatItCannotRead() {
        XCTAssertNil(NativeMessage(body: ["type": "telemetry", "value": 1]))
        XCTAssertNil(NativeMessage(body: ["type": "haptic", "kind": "buzz"]))
        XCTAssertNil(NativeMessage(body: ["type": "review"]))
        XCTAssertNil(NativeMessage(body: ["kind": "light"]))
        XCTAssertNil(NativeMessage(body: "ready"))
        XCTAssertNil(NativeMessage(body: [String: Any]()))
    }
}

final class NativeCommandTests: XCTestCase {
    func testRendersEveryCall() {
        XCTAssertEqual(
            NativeCommand.openSession("s-1").javaScript,
            #"window.argmaxNative?.openSession?.("s-1")"#
        )
        XCTAssertEqual(NativeCommand.closeSession.javaScript, "window.argmaxNative?.closeSession?.()")
        XCTAssertEqual(
            NativeCommand.setTheme(.dark).javaScript,
            #"window.argmaxNative?.setTheme?.("dark")"#
        )
        XCTAssertEqual(
            NativeCommand.setAccent("orange").javaScript,
            #"window.argmaxNative?.setAccent?.("orange")"#
        )
        XCTAssertEqual(
            NativeCommand.setUserBubble("neutral").javaScript,
            #"window.argmaxNative?.setUserBubble?.("neutral")"#
        )
        XCTAssertEqual(NativeCommand.openReview.javaScript, "window.argmaxNative?.openReview?.()")
        XCTAssertEqual(
            NativeCommand.setComposer(hidden: true).javaScript,
            "window.argmaxNative?.setComposer?.(true)"
        )
        XCTAssertEqual(
            NativeCommand.setComposer(hidden: false).javaScript,
            "window.argmaxNative?.setComposer?.(false)"
        )
    }

    /// A session id is a uuid today, but it reaches `evaluateJavaScript` as
    /// source text either way — so it is escaped, not interpolated.
    func testEscapesTheArgument() {
        XCTAssertEqual(
            NativeCommand.openSession("she said \"hi\"").javaScript,
            #"window.argmaxNative?.openSession?.("she said \"hi\"")"#
        )
        XCTAssertEqual(
            NativeCommand.openSession("one\ntwo").javaScript,
            #"window.argmaxNative?.openSession?.("one\ntwo")"#
        )
        XCTAssertEqual(
            NativeCommand.openSession(#"back\slash"#).javaScript,
            #"window.argmaxNative?.openSession?.("back\\slash")"#
        )
        // `</script>` and a lone tab are the other two that bite.
        XCTAssertEqual(
            NativeCommand.openSession("a\tb").javaScript,
            #"window.argmaxNative?.openSession?.("a\tb")"#
        )
    }
}

@MainActor
final class TranscriptHostQueueTests: XCTestCase {
    private let pairing = URL(string: "https://mac.tailnet.ts.net/mobile.html#token=abc")!

    /// A command that races the load waits for the page rather than
    /// disappearing into a `window.argmaxNative` that does not exist yet.
    func testQueuesUntilReadyThenFlushesInOrder() {
        var run: [String] = []
        let host = TranscriptHost(pairingURL: pairing) { run.append($0) }

        host.setTheme(.dark)
        host.openSession("s-1")
        XCTAssertTrue(run.isEmpty)
        XCTAssertFalse(host.ready)

        host.receive(.ready)

        XCTAssertTrue(host.ready)
        XCTAssertEqual(run, [
            #"window.argmaxNative?.setTheme?.("dark")"#,
            #"window.argmaxNative?.openSession?.("s-1")"#
        ])
    }

    func testRunsStraightThroughOnceReady() {
        var run: [String] = []
        let host = TranscriptHost(pairingURL: pairing) { run.append($0) }
        host.receive(.ready)

        host.openSession("s-2")
        host.openReview()
        host.closeSession()

        XCTAssertEqual(run, [
            #"window.argmaxNative?.openSession?.("s-2")"#,
            "window.argmaxNative?.openReview?.()",
            "window.argmaxNative?.closeSession?.()"
        ])
    }

    /// Opening a second chat must not leave the first one's title in the
    /// header while the page catches up: the screen falls back to its row,
    /// which is the chat the reader tapped.
    func testForgetsTheChatItLeftWhenAnotherOpens() {
        let host = TranscriptHost(pairingURL: pairing) { _ in }
        host.receive(.ready)
        host.openSession("s-1")
        host.receive(.session(NativeSession(sessionId: "s-1", title: "A chat", state: .running, attention: .normal)))
        XCTAssertEqual(host.session?.title, "A chat")

        host.openSession("s-2")
        XCTAssertNil(host.session, "the page has not said what s-2 is yet")

        // The page still had one report about the chat just left in flight.
        host.receive(.session(NativeSession(sessionId: "s-1", title: "A chat", state: .complete, attention: .normal)))
        XCTAssertNil(host.session, "a report about another chat is not this chat")

        host.receive(.session(NativeSession(sessionId: "s-2", title: "Another chat", state: .running, attention: .normal)))
        XCTAssertEqual(host.session?.title, "Another chat")

        host.closeSession()
        XCTAssertNil(host.session)
    }

    /// The page's own state is what the screen draws, so every message it
    /// sends has to land somewhere the screen can read.
    func testPublishesWhatThePageReports() {
        let host = TranscriptHost(pairingURL: pairing) { _ in }
        var backs = 0
        var haptics: [NativeHapticKind] = []
        host.onBack = { backs += 1 }
        host.onHaptic = { haptics.append($0) }

        host.openSession("s-1")
        host.receive(.session(NativeSession(sessionId: "s-1", title: "A chat", state: .running, attention: .normal)))
        host.receive(.agents(open: true))
        XCTAssertTrue(host.agentsOpen, "the composer card stands down while the peek is up")
        host.receive(.agents(open: false))
        XCTAssertFalse(host.agentsOpen)

        host.receive(.review(open: true))
        host.receive(.haptic(.success))
        host.receive(.back)

        XCTAssertEqual(host.session?.title, "A chat")
        XCTAssertTrue(host.reviewOpen)
        XCTAssertEqual(haptics, [.success])
        XCTAssertEqual(backs, 1)

        host.receive(.error(message: "Lost the connection to your Mac."))
        XCTAssertEqual(host.failure, "Lost the connection to your Mac.")
        // The page recovering says so itself.
        host.receive(.ready)
        XCTAssertNil(host.failure)
    }
}

final class EmbeddedTranscriptURLTests: XCTestCase {
    func testKeepsTheTokenAndAsksForEmbedMode() {
        let pairing = URL(string: "https://mac.tailnet.ts.net/mobile.html#token=abc123")!
        XCTAssertEqual(
            PairingLink.embeddedTranscriptURL(for: pairing)?.absoluteString,
            "https://mac.tailnet.ts.net/mobile.html?embed=1#token=abc123"
        )
    }

    func testRefusesALinkWithNoToken() {
        let pairing = URL(string: "https://mac.tailnet.ts.net/mobile.html")!
        XCTAssertNil(PairingLink.embeddedTranscriptURL(for: pairing))
    }
}

final class CompactElapsedTests: XCTestCase {
    private let now = Date(timeIntervalSinceReferenceDate: 800_000_000)

    func testStepsThroughTheUnits() {
        func ago(_ seconds: TimeInterval) -> String {
            compactElapsed(since: now.addingTimeInterval(-seconds), now: now)
        }
        XCTAssertEqual(ago(0), "now")
        XCTAssertEqual(ago(59), "now")
        XCTAssertEqual(ago(60), "1m")
        XCTAssertEqual(ago(3599), "59m")
        XCTAssertEqual(ago(3600), "1h")
        XCTAssertEqual(ago(86_399), "23h")
        XCTAssertEqual(ago(86_400), "1d")
        XCTAssertEqual(ago(604_799), "6d")
        XCTAssertEqual(ago(604_800), "1w")
    }

    /// A row whose timestamp is unreadable, or a phone clock that has drifted
    /// behind the Mac's, still has to render.
    func testSurvivesNothingAndTheFuture() {
        XCTAssertEqual(compactElapsed(since: nil, now: now), "")
        XCTAssertEqual(compactElapsed(since: now.addingTimeInterval(120), now: now), "now")
    }
}
