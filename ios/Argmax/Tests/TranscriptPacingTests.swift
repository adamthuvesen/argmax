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

    // MARK: - Who holds the beat between calls

    func testASettledFoldHoldsTheBeatUntilTheCueEarnsItsWord() {
        let sent = Date()
        // The OpenCode shape: every call starts and finishes in the same
        // instant (measured median 0ms), so nothing in the turn is ever
        // running and a rule keyed on a running call leaves the fold dead.
        let items = [userMessage(at: sent),
                     toolGroup(from: sent, calls: [(1, 0), (2, 0), (3, 0)])]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.wait, 0.9)
        // The id is the transcript item's, which is what a fold label matches
        // itself against.
        XCTAssertEqual(beat?.beatHolder(now: sent.addingTimeInterval(3.5)), "tools")
        // …and the cue is still down while the line has it: one live line.
        XCTAssertGreaterThan(beat?.remainingWait(now: sent.addingTimeInterval(3.5)) ?? 0, 0)
        // The cue takes over the moment its wait elapses, and the line that
        // just worked goes quiet in the same frame.
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(4)), 0)
        XCTAssertNil(beat?.beatHolder(now: sent.addingTimeInterval(4)))
    }

    func testTheLinkDoesNotSpendTheBeatBeforeTheFoldCanWave() {
        let sent = Date()
        // The Grok shape — a call that starts and completes 4ms apart — so
        // the fold is never `running` on this side and the beat is its only
        // path to the band. The beat is measured from the host's stamp, and
        // the delta frame, the tail read's round trip and the projection all
        // land after it: by the time the phone has a frame, 1.2s of a 0.9s
        // window is gone and the line used to jump straight to the cue.
        let items = [userMessage(at: sent), toolGroup(from: sent, calls: [(1, 0.004)])]
        let raw = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(raw?.wait, 0.9)
        let landed = sent.addingTimeInterval(1.004)
        let seen = landed.addingTimeInterval(1.2)
        XCTAssertEqual(raw?.remainingWait(now: seen), 0)
        XCTAssertNil(raw?.beatHolder(now: seen))

        // Charged from first sight instead, the fold gets the whole window,
        // which is what the desktop gets from its own clock.
        let beat = raw?.delivered(at: seen)
        XCTAssertEqual(beat?.remainingWait(now: seen) ?? -1, 0.9, accuracy: 0.01)
        XCTAssertEqual(beat?.beatHolder(now: seen), "tools")
        // The cue still arrives one wait after the line appeared here, not
        // one wait after a stamp written on another machine.
        XCTAssertEqual(beat?.remainingWait(now: seen.addingTimeInterval(0.91)), 0)
        XCTAssertNil(beat?.beatHolder(now: seen.addingTimeInterval(0.91)))

        // A stall this client opened into is not a late delivery: its beat is
        // spent, so the cue shows at once and no stale line waves.
        let reopened = raw?.delivered(at: landed.addingTimeInterval(30))
        XCTAssertEqual(reopened?.remainingWait(now: landed.addingTimeInterval(30)), 0)
        XCTAssertNil(reopened?.beatHolder(now: landed.addingTimeInterval(30)))

        // A device clock behind the host's cannot bank extra window.
        let skewed = raw?.delivered(at: landed.addingTimeInterval(-5))
        XCTAssertEqual(skewed?.remainingWait(now: landed) ?? -1, 0.9, accuracy: 0.01)
        // The lag is not identity: a hand-off must not remount the cue.
        XCTAssertEqual(beat, raw)
    }

    func testARunningLineKeepsTheBeatItselfAndThePromptNeverHoldsIt() {
        let sent = Date()
        // A five-second stall and then a call still in flight: that row waves
        // on its own status, so the fold behind it must not also.
        let running = [userMessage(at: sent), toolGroup(from: sent, calls: [(1, 0.2), (6, nil)])]
        let handOff = TranscriptThinking.current(items: running, session: session)
        XCTAssertEqual(handOff?.phase, .leaving)
        XCTAssertNil(handOff?.beatHolder(now: sent.addingTimeInterval(6.1)))
        // A turn whose only predecessor is the prompt has no line of work to
        // give the beat to, however long its wait still has to run.
        let first = TranscriptThinking.current(items: [userMessage(at: sent)], session: session)
        XCTAssertGreaterThan(first?.remainingWait(now: sent.addingTimeInterval(0.2)) ?? 0, 0)
        XCTAssertNil(first?.beatHolder(now: sent.addingTimeInterval(0.2)))
    }

    func testABackgroundedLaunchDoesNotVoteForTheBeat() {
        let sent = Date()
        // An async launch is running by inference: no completion for it ever
        // arrives, so the row never takes the beat and never silences the
        // cue. The turn's last real work — a call that landed in the same
        // instant, the OpenCode shape that hid this bug before the flag
        // existed — keeps the beat, and the cue follows it after the wait.
        let items = [
            userMessage(at: sent),
            toolGroup(from: sent, calls: [(1, 0), (2, 0)]),
            agentGroup(from: sent.addingTimeInterval(2), status: .running, backgroundLaunch: true)
        ]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.phase, .live)
        XCTAssertEqual(beat?.startedAt, stamp(sent.addingTimeInterval(2)))
        XCTAssertEqual(beat?.beatHolder(now: sent.addingTimeInterval(2.5)), "tools")
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(2.5)) ?? -1, 0.4, accuracy: 0.01)
        // The cue takes over the moment its wait elapses: the turn is not
        // busy for the rest of the session.
        XCTAssertEqual(beat?.remainingWait(now: sent.addingTimeInterval(3)), 0)
        XCTAssertNil(beat?.beatHolder(now: sent.addingTimeInterval(3)))
    }

    func testALaunchTheTurnIsBlockedOnStillTakesTheBeat() {
        let sent = Date()
        // Same shape without the backgrounded mark: the card is the live
        // line the reader is waiting on, so the cue yields to it once its
        // wait has passed.
        let items = [
            userMessage(at: sent),
            toolGroup(from: sent, calls: [(1, 0.2), (2, 1.0)]),
            agentGroup(from: sent.addingTimeInterval(4), status: .running, backgroundLaunch: false)
        ]
        let beat = TranscriptThinking.current(items: items, session: session)
        XCTAssertEqual(beat?.phase, .leaving)
        XCTAssertNil(beat?.beatHolder(now: sent.addingTimeInterval(4.5)))
    }

    // MARK: - Who claims the beat on a subagent card

    func testASettledAgentCardClaimsTheBeatTheGroupPublishes() {
        // The cue hands the beat to the group whose work just landed, so the
        // card the silence started at has to be the one that waves — a beat
        // nothing could show left the gap with no live line at all.
        let group = agentGroup(id: "agents", agents: [
            agent(id: "agent-1", status: .done, completedAt: 1.0),
            agent(id: "agent-2", status: .done, completedAt: 2.5)
        ])
        XCTAssertEqual(
            TranscriptAgentGroupView.beatAgentID(of: group, beat: "agents"),
            "agent-2",
            "the newest landed card is the line the silence started at"
        )
        XCTAssertNil(TranscriptAgentGroupView.beatAgentID(of: group, beat: "tools"))
        // The card the cue's settled stamp names and the one the card claims
        // read the same completion.
        let claimed = group.agents.first {
            $0.id == TranscriptAgentGroupView.beatAgentID(of: group, beat: "agents")
        }
        XCTAssertEqual(claimed?.completedAt, agentGroupMaxCompleted(of: group))
    }

    func testARunningAgentCardWavesAndABackgroundedOneNeverDoes() {
        let group = agentGroup(id: "agents", agents: [
            agent(id: "agent-1", status: .done, completedAt: 1.0),
            agent(id: "agent-2", status: .running, backgroundLaunch: true)
        ])
        // The turn is blocked on a plain launch, so its words carry the
        // band the way a running tool row's do.
        XCTAssertTrue(TranscriptAgentGroupView.isLive(
            agent(id: "agent-3", status: .running), in: group, beat: "agents"
        ))
        // A backgrounded launch is running by inference: no completion for
        // one ever arrives, so its words never wave and it does not claim
        // the beat either — the nest is the only mark it keeps.
        XCTAssertFalse(TranscriptAgentGroupView.isLive(
            agent(id: "agent-2", status: .running, backgroundLaunch: true), in: group, beat: "agents"
        ))
        // A settled card only waves while it holds the beat, and it is the
        // newest landed one that holds it.
        XCTAssertTrue(TranscriptAgentGroupView.isLive(
            agent(id: "agent-1", status: .done, completedAt: 1.0), in: group, beat: "agents"
        ))
        XCTAssertFalse(TranscriptAgentGroupView.isLive(
            agent(id: "agent-1", status: .done, completedAt: 1.0), in: group, beat: "tools"
        ))
    }

    func testASettledDetailedRowClaimsTheBeatItsGroupPublishes() {
        let sent = Date()
        // Detailed and revealed folds show bare rows instead of a headline,
        // so the group's beat is the row the silence started at to carry:
        // the newest landed call, the same stamp the cue reads. Every call
        // here starts and finishes in the same instant — the OpenCode shape
        // that left these rows dead when the beat only waited for a running
        // one.
        let group = TranscriptToolGroup(
            id: "tools",
            tools: [
                tool(id: "tool-0", kind: .read, status: .done,
                     createdAt: sent, completedAt: sent),
                tool(id: "tool-1", kind: .edit, status: .done,
                     createdAt: sent, completedAt: sent.addingTimeInterval(0.001))
            ],
            createdAt: stamp(sent)
        )
        XCTAssertEqual(TranscriptToolsRow.beatToolID(of: group, beat: "tools"), "tool-1")
        XCTAssertNil(TranscriptToolsRow.beatToolID(of: group, beat: "agents"))
        // A group with nothing finished in it never started a silence, so it
        // publishes nothing for a row to claim.
        let running = TranscriptToolGroup(
            id: "tools",
            tools: [tool(id: "tool-0", kind: .read, status: .running,
                         createdAt: sent, completedAt: nil)],
            createdAt: stamp(sent)
        )
        XCTAssertNil(TranscriptToolsRow.beatToolID(of: running, beat: "tools"))
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

    /// One card of delegated work, at an offset from the turn's start.
    private func agentGroup(
        from start: Date,
        status: TranscriptToolStatus,
        backgroundLaunch: Bool
    ) -> TranscriptItem {
        .agents(.init(
            id: "agents",
            agents: [.init(id: "agent", parentSessionId: "session", toolUseId: "agent",
                           name: "Agent", prompt: nil, status: status,
                           createdAt: stamp(start), completedAt: nil,
                           providerChildSessionId: nil, providerParentConversationId: nil,
                           agentCodename: nil, children: [],
                           backgroundLaunch: backgroundLaunch)],
            createdAt: stamp(start)
        ))
    }

    private func agentGroup(id: String, agents: [TranscriptAgent]) -> TranscriptAgentGroup {
        .init(id: id, agents: agents, createdAt: stamp(Date()))
    }

    private func agent(
        id: String,
        status: TranscriptToolStatus,
        backgroundLaunch: Bool = false,
        completedAt: TimeInterval? = nil
    ) -> TranscriptAgent {
        var value = TranscriptAgent(
            id: id, parentSessionId: "session", toolUseId: id,
            name: "Agent", prompt: nil, status: status,
            createdAt: stamp(Date()), completedAt: nil,
            providerChildSessionId: nil, providerParentConversationId: nil,
            agentCodename: nil, children: [],
            backgroundLaunch: backgroundLaunch
        )
        if let completedAt {
            value.completedAt = stamp(Date().addingTimeInterval(completedAt))
        }
        return value
    }

    /// The group's settled stamp, the way `TranscriptThinking.settledBeat`
    /// reads it: the newest completion in the group.
    private func agentGroupMaxCompleted(of group: TranscriptAgentGroup) -> String? {
        group.agents.compactMap(\.completedAt).max()
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
