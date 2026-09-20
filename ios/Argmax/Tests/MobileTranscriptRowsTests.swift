import XCTest
@testable import Argmax

final class MobileTranscriptRowsTests: XCTestCase {
    func testCompactFoldsAlternatingThoughtsAndToolsBetweenMessages() {
        let items = [message("user", user: true), thought("thought-1"), tools("tool-1"), thought("thought-2"), tools("tool-2"), message("answer")]
        let rows = MobileTranscriptRow.rows(items, detail: .compact, latestTurnIsLive: false)
        XCTAssertEqual(rows.count, 3)
        guard case .activity(let activity) = rows[1] else { return XCTFail("expected folded activity") }
        XCTAssertEqual(activity.map(\.id), ["thought-1", "tool-1", "thought-2", "tool-2"])
        XCTAssertEqual(rows.last, .item(items.last!))
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count)
    }

    func testMinimalFoldsNarrationButKeepsFinalAnswersAndTurnBoundaries() {
        let items = [message("user-1", user: true), message("narration"), tools("work"), message("answer-1"), message("user-2", user: true), thought("thought"), message("answer-2")]
        let minimal = MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: false)
        XCTAssertEqual(minimal.count, 6)
        guard case .activity(let activity) = minimal[1] else { return XCTFail("expected work") }
        XCTAssertEqual(activity.map(\.id), ["narration", "work"])
        XCTAssertTrue(minimal.contains(.item(items[3])))
        XCTAssertTrue(minimal.contains(.item(items[6])))
        XCTAssertEqual(MobileTranscriptRow.rows(items, detail: .compact, latestTurnIsLive: false).count, 7)
    }

    /// A turn still working keeps the narration the reader may be halfway
    /// through, the way the desktop gates the fold on a finished turn. The
    /// activity row's identity is the other half of it: folding the narration
    /// in moves the row's id off the tool it started on, and a rebuilt row
    /// loses both its expansion and its place on screen.
    func testALiveTurnKeepsItsNarrationAndItsActivityRowIdentity() {
        let items = [message("user", user: true), message("narration"), tools("work"), message("answer")]
        let live = MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: true)
        XCTAssertEqual(live.map(\.id), ["user", "narration", "mobile-activity-work", "answer"])
        let settled = MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: false)
        XCTAssertEqual(settled.map(\.id), ["user", "mobile-activity-narration", "answer"])
    }

    /// Only the newest turn can still be running. A finished turn behind it
    /// folds its narration whatever the session is doing now.
    func testOnlyTheNewestTurnHoldsItsNarrationOpen() {
        let items = [
            message("user-1", user: true), message("narration-1"), tools("work-1"), message("answer-1"),
            message("user-2", user: true), message("narration-2"), tools("work-2"), message("answer-2")
        ]
        let rows = MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: true)
        XCTAssertEqual(rows.map(\.id), [
            "user-1", "mobile-activity-narration-1", "answer-1",
            "user-2", "narration-2", "mobile-activity-work-2", "answer-2"
        ])
    }

    /// A fold promises thinking and activity. Narration with no work in its own
    /// run is prose with nothing to narrate, so it stays a row: hiding it
    /// behind a disclosure that opens to one sentence is worse than showing it.
    func testNarrationOnlyFoldsIntoARunThatHasWorkInIt() {
        let items = [
            message("user", user: true),
            message("remark", text: "I'll take a look."),
            message("answer", text: "The watcher fans out one git process per file, so a single touch costs 91."),
            tools("record")
        ]
        let rows = MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: false)
        XCTAssertEqual(rows.map(\.id), ["user", "remark", "answer", "mobile-activity-record"])
    }

    /// The desktop's boundary is the turn's last *tool*: with none, it hides
    /// nothing. Grok alternates tiny thinking/text pairs, and counting a
    /// thought as work hid remarks the desktop keeps.
    func testAToollessReasoningTurnKeepsEveryRemark() {
        let items = [
            message("user", user: true),
            message("remark", text: "Let me think about it."),
            thought("thought"),
            message("answer", text: "Yes.")
        ]
        XCTAssertEqual(
            MobileTranscriptRow.rows(items, detail: .minimal, latestTurnIsLive: false).map(\.id),
            ["user", "remark", "thought", "answer"]
        )
    }

    /// Reasoning alone keeps its own disclosure — the row that says "Thinking"
    /// and waves while the model reasons. An outer fold over it is a nested
    /// control whose label sits still for the whole burst.
    func testAReasoningOnlyRunKeepsTheThoughtsOwnDisclosure() {
        let items = [message("user", user: true), thought("thought-1"), thought("thought-2"), message("answer")]
        for detail in [MobileChatDetail.minimal, .compact] {
            XCTAssertEqual(
                MobileTranscriptRow.rows(items, detail: detail, latestTurnIsLive: false),
                items.map(MobileTranscriptRow.item)
            )
        }
    }

    /// A fold holding a burst still being written is live work: it names it and
    /// waves for it, rather than standing still through a 30-second reasoning
    /// phase because every call in it already settled.
    func testFoldHeadlineTreatsStreamingReasoningAsLiveWork() {
        let settled = tools("settled")
        XCTAssertFalse(MobileTranscriptRow.foldHeadline([settled, thought("quiet")]).running)
        let live = MobileTranscriptRow.foldHeadline([settled, thought("live", streaming: true)])
        XCTAssertTrue(live.running)
        XCTAssertEqual(live.summary, TranscriptToolActivity.summary(for: [settled].flatMap(toolsOf)).headline)
        XCTAssertEqual(MobileTranscriptRow.foldHeadline([thought("live", streaming: true)]).summary, "Thinking")
        XCTAssertEqual(MobileTranscriptRow.foldHeadline([thought("quiet")]).summary, "Thought")
    }

    /// `isProgressNarration` decides the same way on both platforms or the two
    /// transcripts disagree about which sentence is the answer. The four cases
    /// where the Swift regex used to part company with the JS one.
    func testProgressNarrationMirrorsTheDesktopPredicate() {
        // JS `/\n\s*\n/` matches a blank line whose whitespace is a carriage
        // return, a non-breaking space or a line separator; `\n[ \t]*\n` did not,
        // so a CRLF answer read as a remark and hid.
        for separator in ["\r", "\u{00A0}", "\u{000B}", "\u{2028}", "\u{FEFF}"] {
            XCTAssertFalse(
                MobileTranscriptRow.isProgressNarration("First paragraph.\n\(separator)\nSecond paragraph."),
                "a blank line separated by U+\(String(format: "%04X", separator.unicodeScalars.first!.value)) is writing"
            )
        }
        XCTAssertTrue(MobileTranscriptRow.isProgressNarration("One line.\nStill the same paragraph."))

        // `String.length` counts UTF-16 units. 201 emoji are 402 of them, and
        // 402 grapheme clusters of plain text are 402 too.
        XCTAssertFalse(MobileTranscriptRow.isProgressNarration(String(repeating: "😀", count: 201)))
        XCTAssertTrue(MobileTranscriptRow.isProgressNarration(String(repeating: "😀", count: 200)))
        XCTAssertFalse(MobileTranscriptRow.isProgressNarration(String(repeating: "a", count: 401)))

        // JS `\d` is `[0-9]`; ICU's is `\p{Nd}`, which made Arabic-Indic digits
        // an ordered list on the phone and prose on the desktop.
        XCTAssertTrue(MobileTranscriptRow.isProgressNarration("١. build it"))
        XCTAssertFalse(MobileTranscriptRow.isProgressNarration("1. build it"))

        // Line starts, which JS takes from `\n`, `\r`, U+2028 and U+2029 only.
        XCTAssertFalse(MobileTranscriptRow.isProgressNarration("Here:\n- one"))
        XCTAssertTrue(MobileTranscriptRow.isProgressNarration("Here:\u{000C}- one"))
        XCTAssertTrue(MobileTranscriptRow.isProgressNarration("Reading the repo now."))
    }

    /// Steps previews the tail of the burst being written and leaves every
    /// settled one to its header.
    func testSteppedThoughtPreviewIsBoundedAndMarksItsCut() {
        let short = "Checking the watcher."
        XCTAssertEqual(TranscriptThought.previewTail(of: short), short)
        let long = String(repeating: "reasoning ", count: 200)
        let tail = TranscriptThought.previewTail(of: long)
        XCTAssertEqual(tail.count, 601)
        XCTAssertTrue(tail.hasPrefix("…"))
        XCTAssertTrue(long.hasSuffix(tail.dropFirst()))
    }

    /// A failed tool call is work the agent usually recovers from in its next
    /// call, so it folds with the rest of the work. A session error and an
    /// outstanding question are addressed to the reader and never fold.
    func testFailedToolsFoldWithTheWorkWhileErrorsAndRequestsStayVisible() {
        let failed = tools("failed", status: .failed)
        let error = TranscriptItem.error(.init(id: "error", message: "Connection failed", code: nil, operation: nil, createdAt: "1"))
        let question = TranscriptItem.question(.init(id: "question", toolUseId: "ask", createdAt: "1", questions: [], isOutstanding: true))
        for detail in MobileChatDetail.allCases {
            let rows = MobileTranscriptRow.rows([thought("thinking"), failed, error, question],
                                                detail: detail, latestTurnIsLive: false)
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

    /// The agent's plan is a beat in the conversation, not another tool
    /// row, so Compact and Minimal keep it outside the activity fold.
    func testPlanStaysVisibleInsteadOfFoldingIntoActivity() {
        let plan = TranscriptItem.todo(.init(
            id: "todo-user",
            items: [
                .init(id: "1", text: "Collect skill names", status: .active),
                .init(id: "2", text: "Wire the labels", status: .pending)
            ],
            createdAt: "1"
        ))
        for detail in [MobileChatDetail.minimal, .compact] {
            let rows = MobileTranscriptRow.rows(
                [message("user", user: true), thought("thought"), plan, tools("tools"), message("answer")],
                detail: detail, latestTurnIsLive: false
            )
            XCTAssertTrue(rows.contains(.item(plan)))
            XCTAssertFalse(rows.contains { row in
                if case .activity(let items) = row { return items.contains(plan) }
                return false
            })
        }
    }

    func testHigherLevelsKeepStepsIndividuallyInspectableAndEmptyInputIsEmpty() {
        let items = [thought("thought"), tools("tools"), message("answer")]
        for detail in [MobileChatDetail.steps, .detailed] {
            XCTAssertEqual(MobileTranscriptRow.rows(items, detail: detail, latestTurnIsLive: false),
                           items.map(MobileTranscriptRow.item))
        }
        XCTAssertTrue(MobileTranscriptRow.rows([], detail: .compact, latestTurnIsLive: false).isEmpty)
    }

    func testMinimalKeepsTheLatestMessageWhileMoreWorkIsRunning() {
        let update = message("latest-update")
        let rows = MobileTranscriptRow.rows([update, tools("running", status: .running)],
                                            detail: .minimal, latestTurnIsLive: true)
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
            "Read 2 files, ran a command, file change failed"
        )
        XCTAssertEqual(TranscriptToolActivity.summary(for: [read, command]).iconKind, .read)
    }

    /// Past four kinds of work the fold counts instead of listing.
    func testHeadlineCapsNamedClauses() {
        let kinds: [TranscriptToolActivityKind] = [.read, .command, .search, .image, .browser, .skill, .git]
        let tools = kinds.enumerated().map { index, kind in
            tool("t\(index)", kind: kind, status: .done, completionObserved: true)
        }
        XCTAssertEqual(
            TranscriptToolActivity.summary(for: tools).headline,
            "Read a file, ran a command, searched files, viewed an image, and 3 more"
        )
    }

    /// A settled plural clause says how many; a running one never does, since
    /// its number would change under the reader.
    func testSettledHeadlineCountsCallsOrDistinctTargets() {
        let commands = (1...11).map { tool("command-\($0)", kind: .command, status: .done, completionObserved: true) }
        XCTAssertEqual(TranscriptToolActivity.summary(for: commands).headline, "Ran 11 commands")
        let reads = ["a", "b", "a"].enumerated().map { index, path in
            tool("read-\(index)", kind: .read, status: .done, completionObserved: true, targets: [path])
        }
        let searches = (1...2).map { tool("search-\($0)", kind: .search, status: .done, completionObserved: true) }
        XCTAssertEqual(TranscriptToolActivity.summary(for: reads + searches).headline, "Read 2 files, searched files")
        let running = (1...2).map { tool("running-\($0)", kind: .command, status: .running, completionObserved: false) }
        XCTAssertEqual(TranscriptToolActivity.summary(for: running).headline, "Running commands")
        // One call still in flight and the fold states what it is doing: a
        // count beside it would be a total of work that is not done.
        XCTAssertEqual(
            TranscriptToolActivity.summary(for: commands + running).headline,
            "Ran commands, running commands"
        )
        XCTAssertEqual(TranscriptToolActivity.summary(for: commands, counting: false).headline, "Ran commands")
        // Discovery counts calls, not the tools they loaded, so it says neither.
        let discovery = (1...2).map {
            tool("discovery-\($0)", kind: .discovery, status: .done, completionObserved: true, toolCount: 3)
        }
        XCTAssertEqual(TranscriptToolActivity.summary(for: discovery).headline, "Loaded tools")
        // One call, several targets: the row says how many, like the fold.
        XCTAssertEqual(reads[0].activitySummary, "Read a")
        XCTAssertEqual(
            tool("read-many", kind: .read, status: .done, completionObserved: true, targets: ["a", "b", "c"]).activitySummary,
            "Read 3 files"
        )
    }

    func testOnlyEditActivitiesOpenWorkspaceRelativeDiffs() {
        var edit = tool("edit", kind: .edit, status: .done, completionObserved: true)
        edit.filePath = "/repo/Sources/App.swift"
        edit.fileLabel = "Sources/App.swift"
        var read = tool("read", kind: .read, status: .done, completionObserved: true)
        read.filePath = "/repo/Sources/App.swift"
        read.fileLabel = "Sources/App.swift"

        XCTAssertEqual(edit.diffPath, "Sources/App.swift")
        XCTAssertNil(read.diffPath)
    }

    private func message(_ id: String, user: Bool = false, text: String? = nil) -> TranscriptItem {
        let message = TranscriptMessage(id: id, role: user ? .user : .assistant, text: text ?? id, createdAt: "1", isStreaming: false, isSteering: false, originLabel: nil, attachments: [])
        return user ? .user(message) : .assistant(message)
    }

    private func thought(_ id: String, streaming: Bool = false) -> TranscriptItem {
        .thought(.init(id: id, text: "Preparing the patch", createdAt: "1", isStreaming: streaming))
    }

    private func toolsOf(_ item: TranscriptItem) -> [TranscriptTool] {
        if case .tools(let group) = item { return group.tools }
        return []
    }

    private func tools(_ id: String, status: TranscriptToolStatus = .done) -> TranscriptItem {
        .tools(.init(id: id, tools: [.init(id: id + "-tool", toolUseId: id, name: "Bash", summary: "Run command", input: nil, output: nil, error: nil, status: status, createdAt: "1", completedAt: nil, filePath: nil, fileLabel: nil)], createdAt: "1"))
    }

    private func tool(
        _ id: String,
        kind: TranscriptToolActivityKind,
        status: TranscriptToolStatus,
        completionObserved: Bool,
        targets: [String] = [],
        toolCount: Int? = nil
    ) -> TranscriptTool {
        TranscriptTool(
            id: id, toolUseId: id, name: id, summary: "", input: nil, output: nil, error: nil,
            status: status, createdAt: "1", completedAt: completionObserved ? "2" : nil,
            filePath: nil, fileLabel: nil,
            activity: TranscriptToolActivity(
                version: 1, kind: kind, evidence: .native, targets: targets,
                operation: nil, toolCount: toolCount
            ),
            completionObserved: completionObserved
        )
    }
}
