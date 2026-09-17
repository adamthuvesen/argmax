import XCTest
@testable import Argmax

/// The timing decisions behind the live line, as pure functions: given a
/// turn's rhythm, does the cue earn the screen, and does a fold's headline
/// re-word? The numbers are the desktop's, so the two surfaces read the same
/// (`docs/design/live-activity-timing`).
final class TranscriptPacingTests: XCTestCase {
    private let session = NativeSession(sessionId: "session", title: "Chat",
                                        state: .running, attention: .normal)

    // MARK: - What a silent beat has to outlast

    func testGapWaitFollowsTheTurnsOwnRhythm() {
        XCTAssertEqual(TranscriptThinkingWait.gap(measuring: []), 1.0)
        XCTAssertEqual(TranscriptThinkingWait.gap(measuring: [1.0, 2.0, 3.0]), 1.6, accuracy: 0.001)
        // A burst of same-millisecond calls cannot drive the wait to nothing,
        // and a single long stall cannot raise it past usefulness.
        XCTAssertEqual(TranscriptThinkingWait.gap(measuring: [0.01, 0.02, 0.05]), 0.9)
        XCTAssertEqual(TranscriptThinkingWait.gap(measuring: [10, 20, 30]), 2.5)
        // The median, not the mean: one 30s stall among fast calls leaves the
        // turn's rhythm fast, where a mean would read 10s.
        XCTAssertEqual(TranscriptThinkingWait.gap(measuring: [0.2, 0.3, 30]), 0.9)
    }

    func testFirstBeatOfATurnWaitsSixHundredMilliseconds() {
        let sent = Date()
        let beat = TranscriptThinking.current(items: [userMessage(at: sent)], session: session)
        XCTAssertEqual(beat?.wait, 0.6)
        XCTAssertEqual(beat?.phase, .live)
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(0.2)) ?? -1, 0.4, accuracy: 0.01)
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(0.9)), 0)
        // A beat with no clock to count from has nothing to smooth, so it
        // shows at once instead of replaying a wait no one sat through.
        XCTAssertEqual(TranscriptThinking(id: "session", startedAt: "").remainingWait(), 0)
        // A clock stepped backwards cannot park the line beyond its own wait.
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(-30)), 0.6)
    }

    func testMidTurnGapWaitsForAFractionOfTheTurnsMedianGap() {
        let sent = Date()
        // Three calls roughly a second apart: the turn's rhythm is its own
        // argument that a one-second gap is work, not a stall.
        let items = [userMessage(at: sent),
                     toolGroup(from: sent, calls: [(1, 0.2), (2, 0.2), (3, 0.2)])]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.wait, 0.9)
        XCTAssertGreaterThan(beat?.remainingWait(now: sent.addingTimeInterval(3.6)) ?? 0, 0)
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(4.2)), 0)
    }

    func testAGapTooShortToEarnAWordShowsNoneOnTheHandOffEither() {
        let sent = Date()
        // The next call starts 0.4s after the last one finished, inside the
        // 0.9s this turn's rhythm asks for: nothing was on screen to lose.
        let items = [userMessage(at: sent),
                     toolGroup(from: sent, calls: [(1, 0.2), (2, 0.2), (3, 0.2), (3.6, nil)])]
        XCTAssertNil(TranscriptThinking.current(items: items, session: session))
    }

    func testARunningToolLineTakesTheBeatAndTheCueDissolves() {
        let sent = Date()
        // A five-second stall, then the next call: the cue was up by then, so
        // it hands the beat over on a fade rather than a cut.
        let items = [userMessage(at: sent),
                     toolGroup(from: sent, calls: [(1, 0.2), (6, nil)])]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.phase, .leaving)
        // One live line at a time: whatever the clocks say, the cue is never
        // live while a row is running.
        XCTAssertNotEqual(beat?.phase, .live)
    }

    func testSettledCallsLeaveTheCueLiveFromTheLastCompletion() {
        let sent = Date()
        let items = [userMessage(at: sent), toolGroup(from: sent, calls: [(1, 0.2), (2, 1.0)])]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.phase, .live)
        XCTAssertEqual(beat?.startedAt, stamp(sent.addingTimeInterval(3)))
    }

    func testAPhaseFlipIsTheSameBeat() {
        // Equality is the beat's identity, so a hand-off leaves the line's
        // word and its clock alone rather than remounting it.
        var leaving = TranscriptThinking(id: "beat", startedAt: "2026-09-17T10:00:00Z", wait: 1.2)
        leaving.phase = .leaving
        XCTAssertEqual(leaving, TranscriptThinking(id: "beat", startedAt: "2026-09-17T10:00:00Z"))
        XCTAssertNotEqual(leaving, TranscriptThinking(id: "beat", startedAt: "2026-09-17T10:00:05Z"))
    }

    // MARK: - What a fold's headline re-words on

    func testHeadlineHoldsUnlessTheKindOfWorkChanges() {
        let dwell = Duration.milliseconds(800)
        XCTAssertEqual(TranscriptDwell.decide(keyChanged: false, running: true,
                                              shownFor: .seconds(5), dwell: dwell), .hold)
        XCTAssertEqual(TranscriptDwell.decide(keyChanged: true, running: true,
                                              shownFor: .seconds(5), dwell: dwell), .now)
        XCTAssertEqual(TranscriptDwell.decide(keyChanged: true, running: true,
                                              shownFor: .milliseconds(200), dwell: dwell),
                       .after(.milliseconds(600)))
        XCTAssertEqual(TranscriptDwell.decide(keyChanged: true, running: true,
                                              shownFor: nil, dwell: dwell), .now)
        // Settled work is the moment the counts are worth reading, so it
        // paints whatever the dwell was holding back.
        XCTAssertEqual(TranscriptDwell.decide(keyChanged: false, running: false,
                                              shownFor: .milliseconds(10), dwell: dwell), .now)
    }

    func testKindKeyIgnoresCountsAndOutcomes() {
        let read = tool(id: "1", kind: .read, status: .done)
        let secondRead = tool(id: "2", kind: .read, status: .running)
        let edit = tool(id: "3", kind: .edit, status: .running)
        let create = tool(id: "4", kind: .edit, status: .running, operation: .create)
        XCTAssertEqual(TranscriptFoldLabel.kindKey(for: [read]),
                       TranscriptFoldLabel.kindKey(for: [read, secondRead]))
        XCTAssertNotEqual(TranscriptFoldLabel.kindKey(for: [read]),
                          TranscriptFoldLabel.kindKey(for: [read, edit]))
        XCTAssertNotEqual(TranscriptFoldLabel.kindKey(for: [edit]),
                          TranscriptFoldLabel.kindKey(for: [create]))
        XCTAssertEqual(TranscriptFoldLabel.kindKey(for: []), "")
    }

    // MARK: - Fixtures

    private func stamp(_ date: Date) -> String {
        ISO8601DateFormatter.withMilliseconds.string(from: date)
    }

    private func userMessage(at date: Date) -> TranscriptItem {
        .user(.init(id: "user", role: .user, text: "Go", createdAt: stamp(date),
                    isStreaming: false, isSteering: false, originLabel: nil, attachments: []))
    }

    /// One fold of calls, each as an offset from the turn's start and a
    /// duration — nil for a call still running.
    private func toolGroup(from start: Date, calls: [(offset: TimeInterval, duration: TimeInterval?)]) -> TranscriptItem {
        let tools = calls.enumerated().map { index, call in
            tool(id: "tool-\(index)", kind: .read,
                 status: call.duration == nil ? .running : .done,
                 createdAt: start.addingTimeInterval(call.offset),
                 completedAt: call.duration.map { start.addingTimeInterval(call.offset + $0) })
        }
        return .tools(.init(id: "tools", tools: tools,
                            createdAt: stamp(start.addingTimeInterval(calls.first?.offset ?? 0))))
    }

    private func tool(
        id: String,
        kind: TranscriptToolActivityKind,
        status: TranscriptToolStatus,
        operation: TranscriptToolActivityOperation? = nil,
        createdAt: Date = Date(),
        completedAt: Date? = nil
    ) -> TranscriptTool {
        var value = TranscriptTool(id: id, toolUseId: id, name: "Read", summary: "Read",
                                   input: nil, output: nil, error: nil, status: status,
                                   createdAt: stamp(createdAt),
                                   completedAt: completedAt.map(stamp),
                                   filePath: nil, fileLabel: nil)
        value.activity = TranscriptToolActivity(version: 1, kind: kind, evidence: .tool,
                                                targets: [], operation: operation, toolCount: nil)
        return value
    }
}
