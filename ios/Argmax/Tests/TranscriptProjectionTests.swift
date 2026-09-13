import XCTest
@testable import Argmax

final class TranscriptProjectionTests: XCTestCase {
    func testKnownNonblockingQuestionRejectionIsACompactDiagnostic() {
        let error = TranscriptError(
            id: "error-1",
            message: "2026-09-13T12:18:51Z ERROR codex_app_server::bespoke_event_handling: request failed with client error: Codex question must be blocking",
            code: "stderr",
            operation: nil,
            createdAt: "2026-09-13T12:18:51Z"
        )

        XCTAssertEqual(error.compactSummary, "Codex continued past a nonblocking question")
        XCTAssertNil(TranscriptError(
            id: "error-2",
            message: "Codex turn failed",
            code: nil,
            operation: nil,
            createdAt: "2026-09-13T12:18:51Z"
        ).compactSummary)
    }

    func testCompletedThoughtItemsReplaceTheirLiveSummariesWithoutDuplication() throws {
        let completed = TranscriptProjection.project(events: [
            event("live-1", "message.delta", "**Inspecting files**", 1, [
                "thinking": .bool(true)
            ]),
            event("completed-1", "message.delta", "**Inspecting files**", 2, [
                "thinking": .bool(true),
                "providerEventType": .string("item.completed"),
                "summary": .array([.string("**Inspecting files**")])
            ]),
            event("live-2a", "message.delta", "**Separating concerns**", 3, [
                "thinking": .bool(true)
            ]),
            event("live-2b", "message.delta", "**Preparing the patch file**", 4, [
                "thinking": .bool(true)
            ]),
            event("completed-2", "message.delta", "**Separating concerns**\n**Preparing the patch file**", 5, [
                "thinking": .bool(true),
                "providerEventType": .string("item.completed"),
                "summary": .array([
                    .string("**Separating concerns**"),
                    .string("**Preparing the patch file**")
                ])
            ])
        ])
        guard case .thought(let completedThought) = completed.first else { return XCTFail("expected thought") }
        XCTAssertEqual(
            completedThought.text,
            "**Inspecting files**\n\n**Separating concerns**\n**Preparing the patch file**"
        )
    }

    func testLiveSummaryFragmentsOpenParagraphsRatherThanCollidingDelimiters() throws {
        // Without a completed item to correct them — which is every provider
        // but Codex — two summaries glued end to end rendered as one line
        // reading "…default****Searching…".
        let items = TranscriptProjection.project(events: [
            event("live-1", "message.delta", "**Adding missing session default**", 1, [
                "thinking": .bool(true)
            ]),
            event("live-2", "message.delta", "**Searching session completion events**", 2, [
                "thinking": .bool(true)
            ])
        ])
        guard case .thought(let thought) = items.first else { return XCTFail("expected thought") }
        XCTAssertEqual(
            thought.text,
            "**Adding missing session default**\n\n**Searching session completion events**"
        )
    }

    func testCompletedThoughtItemsKeepParagraphsWhileStreamingFragmentsStayJoined() throws {
        let completed = TranscriptProjection.project(events: [
            event("completed-1", "message.delta", "**Inspecting files**", 1, [
                "thinking": .bool(true), "providerEventType": .string("item.completed")
            ]),
            event("completed-2", "message.delta", "**Separating concerns**", 2, [
                "thinking": .bool(true), "providerEventType": .string("item.completed")
            ])
        ])
        guard case .thought(let completedThought) = completed.first else { return XCTFail("expected thought") }
        XCTAssertEqual(completedThought.text, "**Inspecting files**\n\n**Separating concerns**")

        let streaming = TranscriptProjection.project(events: [
            event("streaming-1", "message.delta", "Inspect", 1, [
                "thinking": .bool(true), "providerEventType": .string("thinking")
            ]),
            event("streaming-2", "message.delta", "ing files", 2, [
                "thinking": .bool(true), "providerEventType": .string("thinking")
            ])
        ])
        guard case .thought(let stream) = streaming.first else { return XCTFail("expected thought") }
        XCTAssertEqual(stream.text, "Inspecting files")
    }

    func testMalformedQuestionDoesNotHideLaterAnswer() {
        let payload: [String: TranscriptJSONValue] = [
            "id": .string("tool-1"),
            "name": .string("AskUserQuestion"),
            "input": .object(["questions": .array([])])
        ]
        let items = TranscriptProjection.project(events: [
            event("user", "user.message", "Go", 1),
            event("ask-start", "command.started", "AskUserQuestion", 2, payload),
            event("ask-end", "command.completed", "AskUserQuestion", 3, payload),
            event("prose", "message.completed", "Please clarify your preference.", 4)
        ])
        XCTAssertFalse(items.contains { if case .question = $0 { return true }; return false })
        let assistantTexts = items.compactMap { item -> String? in
            guard case .assistant(let message) = item else { return nil }
            return message.text
        }
        XCTAssertEqual(assistantTexts, ["Please clarify your preference."])
    }

    func testApprovalResolutionUpdatesOneCardAndPreservesRequestMetadata() throws {
        let request = event("approval-req", "approval.requested", "npm test", 1, [
            "approvalId": .string("approval-1"),
            "command": .string("npm test"),
            "cwd": .string("/tmp/project"),
            "provider": .string("claude"),
            "riskLevel": .string("low")
        ])
        let items = TranscriptProjection.project(events: [
            request,
            event("approval-res", "approval.resolved", "Approval granted", 2, [
                "approvalId": .string("approval-1"),
                "status": .string("approved")
            ])
        ])
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(Set(items.map(\.id)).count, items.count)
        let approval = try XCTUnwrap(items.compactMap { item -> TranscriptApproval? in
            guard case .approval(let approval) = item else { return nil }
            return approval
        }.first)
        XCTAssertEqual(approval.status, .approved)
        XCTAssertEqual(approval.command, "npm test")
        XCTAssertEqual(approval.workingDirectory, "/tmp/project")
        XCTAssertEqual(approval.provider, "claude")
        XCTAssertEqual(approval.riskLevel, "low")
        XCTAssertEqual(approval.createdAt, request.createdAt)
    }

    func testFinalAnswerReplacesStreamingDeltasAndKeepsThinking() {
        let events = [
            event("done", "message.completed", "Final answer", 5),
            event("delta-2", "message.delta", "answer", 4),
            event("delta-1", "message.delta", "Final ", 3),
            event("thought", "message.delta", "Check the contract.", 2, ["thinking": .bool(true)]),
            event("user", "user.message", "Proceed", 1)
        ]

        let items = TranscriptProjection.project(events: events)
        XCTAssertEqual(items.map(\.id), ["user-user", "thought-thought", "answer-user-0"])
        guard case .thought(let thought) = items[1], case .assistant(let answer) = items[2] else {
            return XCTFail("expected thought and final answer")
        }
        XCTAssertEqual(thought.text, "Check the contract.")
        XCTAssertEqual(answer.text, "Final answer")
        XCTAssertFalse(answer.isStreaming)
    }

    func testClearDeduplicatesEditedRowsAndHidesChildProse() {
        let events = [
            event("old", "user.message", "Before clear", 1),
            event("clear", "session.cleared", "Cleared", 2),
            event("user", "user.message", "First draft", 3),
            event("child", "message.completed", "Subagent prose", 4, ["parent_tool_use_id": .string("task-1")]),
            event("user", "user.message", "Edited draft", 3)
        ]

        let items = TranscriptProjection.project(events: events)
        XCTAssertEqual(items.count, 1)
        guard case .user(let message) = items[0] else { return XCTFail("expected user message") }
        XCTAssertEqual(message.text, "Edited draft")
    }

    func testAssistantBlocksSeparatedByAToolHaveDistinctStableIDs() {
        let events = [
            event("user", "user.message", "Go", 1),
            event("intro", "message.completed", "I will inspect it.", 2),
            event("read", "command.started", "Read", 3, ["id": .string("tool-1"), "name": .string("Read")]),
            event("read-end", "command.completed", "done", 4, ["tool_use_id": .string("tool-1")]),
            event("answer", "message.completed", "It is fixed.", 5)
        ]

        let items = TranscriptProjection.project(events: events)
        let answerIDs = items.compactMap { item -> String? in
            guard case .assistant = item else { return nil }
            return item.id
        }
        XCTAssertEqual(answerIDs, ["answer-user-0", "answer-user-1"])
        XCTAssertEqual(Set(items.map(\.id)).count, items.count)
    }

    func testItemsWithMatchingTimestampsKeepTheirEventCursorOrder() {
        let timestamp = "2026-01-01T00:00:02.000Z"
        var toolStart = event("read", "command.started", "Read", 2, [
            "id": .string("tool-1"),
            "name": .string("Read")
        ])
        var toolEnd = event("read-end", "command.completed", "done", 3, [
            "tool_use_id": .string("tool-1")
        ])
        var answer = event("answer", "message.completed", "It is fixed.", 4)
        toolStart.createdAt = timestamp
        toolEnd.createdAt = timestamp
        answer.createdAt = timestamp

        let items = TranscriptProjection.project(events: [answer, toolEnd, toolStart])

        XCTAssertEqual(items.count, 2)
        guard case .tools = items[0], case .assistant = items[1] else {
            return XCTFail("expected the tool before the answer")
        }
    }

    func testProjectsToolAgentTodoApprovalAndMultitaskModels() throws {
        let events = [
            event("user", "user.message", "Build it", 1),
            event("read", "command.started", "Read", 2, [
                "id": .string("tool-1"),
                "name": .string("Read"),
                "input": .object(["file_path": .string("Sources/App.swift")])
            ]),
            event("read-end", "command.completed", "tool_result", 3, [
                "tool_use_id": .string("tool-1"),
                "content": .string("file body")
            ]),
            event("agent", "command.started", "Task", 4, [
                "id": .string("task-1"),
                "name": .string("Task"),
                "agentCodename": .string("Gauss"),
                "providerChildSessionId": .string("child-1"),
                "input": .object(["description": .string("Review changes"), "prompt": .string("Review the diff")])
            ]),
            event("child-tool", "command.started", "Bash", 5, [
                "id": .string("child-tool-1"),
                "name": .string("Bash"),
                "parent_tool_use_id": .string("task-1"),
                "input": .object(["command": .string("npm test")])
            ]),
            event("todo", "todo.updated", "todo", 6, [
                "mode": .string("snapshot"),
                "items": .array([
                    .object(["id": .string("1"), "text": .string("Read"), "status": .string("done")]),
                    .object(["id": .string("2"), "text": .string("Verify"), "status": .string("active")])
                ])
            ]),
            event("approval", "approval.requested", "npm test", 7, [
                "approvalId": .string("approval-1"),
                "provider": .string("claude"),
                "command": .string("npm test"),
                "riskLevel": .string("medium")
            ]),
            event("multi", "multitask.launched", "Fix copy", 8, [
                "childSessionId": .string("session-child"),
                "taskLabel": .string("Fix copy"),
                "prompt": .string("Fix the label")
            ]),
            event("multi-end", "multitask.finished", "Fixed", 9, [
                "childSessionId": .string("session-child"),
                "state": .string("complete"),
                "answer": .string("Fixed")
            ])
        ]

        let items = TranscriptProjection.project(events: events)
        let tool = try XCTUnwrap(items.compactMap { item -> TranscriptTool? in
            guard case .tools(let group) = item else { return nil }
            return group.tools.first
        }.first)
        XCTAssertEqual(tool.filePath, "Sources/App.swift")
        XCTAssertEqual(tool.output, "file body")
        XCTAssertEqual(tool.status, .done)

        let agent = try XCTUnwrap(items.compactMap { item -> TranscriptAgent? in
            guard case .agents(let group) = item else { return nil }
            return group.agents.first
        }.first)
        XCTAssertEqual(agent.agentCodename, "Gauss")
        XCTAssertEqual(agent.providerChildSessionId, "child-1")
        XCTAssertEqual(agent.children.first?.summary, "Command")

        let todo = try XCTUnwrap(items.compactMap { item -> TranscriptTodoList? in
            guard case .todo(let list) = item else { return nil }
            return list
        }.first)
        XCTAssertEqual(todo.items.map(\.status), [.done, .active])

        let approval = try XCTUnwrap(items.compactMap { item -> TranscriptApproval? in
            guard case .approval(let approval) = item else { return nil }
            return approval
        }.first)
        XCTAssertEqual(approval.id, "approval-1")
        XCTAssertEqual(approval.status, .pending)

        let multitask = try XCTUnwrap(items.compactMap { item -> TranscriptMultitask? in
            guard case .multitask(let multitask) = item else { return nil }
            return multitask
        }.first)
        XCTAssertEqual(multitask.state, "complete")
        XCTAssertEqual(multitask.answer, "Fixed")
    }

    func testToolPathsUseWorkspaceRelativeLabelsAndPreserveTargets() throws {
        let cases = [
            (workspace: "/", path: "/Sources/App.swift", label: "Sources/App.swift"),
            (
                workspace: "/Users/adamthuvesen/dev/menti/a-very-long-workspace-name-that-exceeds-the-summary-limit/",
                path: "/Users/adamthuvesen/dev/menti/a-very-long-workspace-name-that-exceeds-the-summary-limit/src/App.swift",
                label: "src/App.swift"
            ),
            (
                workspace: "/Users/dev/argmax",
                path: "/Users/dev/argmax-other/App.swift",
                label: "/Users/dev/argmax-other/App.swift"
            ),
            (workspace: "/Users/dev/argmax", path: "Sources/App.swift", label: "Sources/App.swift")
        ]

        for (index, testCase) in cases.enumerated() {
            let path = testCase.path
            let items = TranscriptProjection.project(
                events: [event("edit-\(index)", "command.started", "Edit", 1, [
                    "id": .string("tool-\(index)"),
                    "name": .string("Edit"),
                    "input": .object(["file_path": .string(path)])
                ])],
                workspacePath: testCase.workspace
            )
            let tool = try XCTUnwrap(items.compactMap { item -> TranscriptTool? in
                guard case .tools(let group) = item else { return nil }
                return group.tools.first
            }.first)

            XCTAssertEqual(tool.summary, "File change")
            XCTAssertEqual(tool.fileLabel, testCase.label)
            XCTAssertEqual(tool.filePath, path)
            XCTAssertTrue(tool.input?.contains(path) == true)
        }
    }

    func testChildAgentToolUsesWorkspaceRelativePath() throws {
        let items = TranscriptProjection.project(
            events: [
                event("agent", "command.started", "Task", 1, [
                    "id": .string("agent-tool"),
                    "name": .string("Task"),
                    "input": .object(["description": .string("Edit the app")])
                ]),
                event("child-edit", "command.started", "Edit", 2, [
                    "id": .string("child-tool"),
                    "name": .string("Edit"),
                    "parent_tool_use_id": .string("agent-tool"),
                    "input": .object(["file_path": .string("/Users/dev/argmax/src/App.swift")])
                ])
            ],
            workspacePath: "/Users/dev/argmax"
        )
        let child = try XCTUnwrap(items.compactMap { item -> TranscriptTool? in
            guard case .agents(let group) = item else { return nil }
            return group.agents.first?.children.first
        }.first)

        XCTAssertEqual(child.summary, "File change")
        XCTAssertEqual(child.fileLabel, "src/App.swift")
        XCTAssertEqual(child.filePath, "/Users/dev/argmax/src/App.swift")
    }

    func testAgentNameDropsCodexImageMarker() throws {
        let items = TranscriptProjection.project(
            events: [
                event("agent", "command.started", "collab_tool_call", 1, [
                    "id": .string("agent-tool"),
                    "name": .string("collab_tool_call"),
                    "input": .object([
                        "prompt": .string(
                            "[local_image:/Users/dev/Library/Application Support/com.argmax.rs/shot.png]\nReview the screenshot."
                        )
                    ])
                ])
            ]
        )
        let agent = try XCTUnwrap(items.compactMap { item -> TranscriptAgent? in
            guard case .agents(let group) = item else { return nil }
            return group.agents.first
        }.first)

        XCTAssertEqual(agent.name, "Review the screenshot.")
    }

    func testWorkspacePathDoesNotRewriteCommandsOrQueries() throws {
        let items = TranscriptProjection.project(
            events: [
                event("bash", "command.started", "Bash", 1, [
                    "id": .string("bash-tool"),
                    "name": .string("Bash"),
                    "input": .object(["command": .string("/Users/dev/argmax/scripts/check.sh")])
                ]),
                event("search", "command.started", "Search", 2, [
                    "id": .string("search-tool"),
                    "name": .string("Search"),
                    "input": .object(["query": .string("/Users/dev/argmax/src")])
                ])
            ],
            workspacePath: "/Users/dev/argmax"
        )
        let tools = items.compactMap { item -> [TranscriptTool]? in
            guard case .tools(let group) = item else { return nil }
            return group.tools
        }.flatMap { $0 }

        XCTAssertEqual(tools.map(\.summary), [
            "Command",
            "File search"
        ])
    }

    func testActivityMetadataDrivesSuccessfulLiveAndUnconfirmedWording() throws {
        let activity: TranscriptJSONValue = .object([
            "version": .number(1),
            "kind": .string("read"),
            "evidence": .string("native"),
            "targets": .array([.string("/Users/dev/argmax/src/App.swift")])
        ])
        let started: [String: TranscriptJSONValue] = [
            "id": .string("read-1"),
            "name": .string("Read"),
            "activity": activity
        ]
        let runningSession = TranscriptSessionMetadata(
            id: "session-1", workspaceId: "workspace-1", provider: "claude",
            modelLabel: "Claude", modelId: "claude", prompt: "Read it", state: .running,
            attention: .normal, reasoningEffort: nil, agentMode: "auto"
        )

        let live = try XCTUnwrap(firstTool(TranscriptProjection.project(
            events: [event("read", "command.started", "Read", 1, started)],
            session: runningSession
        )))
        XCTAssertEqual(live.activity.kind, .read)
        XCTAssertEqual(live.activity.evidence, .native)
        XCTAssertEqual(live.summary, "Reading App.swift")
        XCTAssertFalse(live.completionObserved)

        let completed = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("read", "command.started", "Read", 1, started),
            event("read-end", "command.completed", "done", 2, [
                "tool_use_id": .string("read-1"),
                "status": .string("completed")
            ])
        ])))
        XCTAssertEqual(completed.summary, "Read App.swift")
        XCTAssertTrue(completed.completionObserved)

        let unconfirmed = try XCTUnwrap(firstTool(TranscriptProjection.project(
            events: [event("read", "command.started", "Read", 1, started)]
        )))
        XCTAssertEqual(unconfirmed.summary, "File read")
    }

    func testGenericToolAndCommandCaptionsKeepTheirUsefulPreviewAndLifecycle() throws {
        let events = [
            event("mcp", "command.started", "Linear", 1, [
                "id": .string("mcp-1"),
                "name": .string("mcp__linear__list_issues"),
                "input": .object(["query": .string("ENG-123")])
            ]),
            event("mcp-end", "command.completed", "done", 2, [
                "tool_use_id": .string("mcp-1")
            ]),
            event("command", "command.started", "Bash", 3, [
                "id": .string("command-1"),
                "name": .string("Bash"),
                "input": .object(["command": .string("cargo test --lib")])
            ]),
            event("command-end", "command.completed", "done", 4, [
                "tool_use_id": .string("command-1")
            ])
        ]
        let tools = TranscriptProjection.project(events: events).compactMap { item -> [TranscriptTool]? in
            guard case .tools(let group) = item else { return nil }
            return group.tools
        }.flatMap { $0 }

        XCTAssertEqual(tools.map(\.summary), [
            "Used Linear list issues · ENG-123",
            "Ran cargo test --lib"
        ])
    }

    func testCommandPreviewPeeksThroughTheShellLauncher() {
        XCTAssertEqual(
            TranscriptProjection.unwrapShellCommand("/bin/zsh -lc \"sed -n '1,80p' src/a.ts\""),
            "sed -n '1,80p' src/a.ts"
        )
        XCTAssertEqual(TranscriptProjection.unwrapShellCommand("bash -c 'git status --short'"), "git status --short")
        XCTAssertEqual(TranscriptProjection.unwrapShellCommand("cargo test --lib"), "cargo test --lib")
        XCTAssertEqual(TranscriptProjection.unwrapShellCommand("zsh -lc"), "zsh -lc")
    }

    func testThoughtTitleIsTheFirstLineWithoutMarkdown() {
        XCTAssertEqual(TranscriptThought.title(of: "**Checking deletion history**\n\nThe macro was…"), "Checking deletion history")
        XCTAssertEqual(TranscriptThought.title(of: "\n## Obtaining full parent:\nbody"), "Obtaining full parent")
        XCTAssertNil(TranscriptThought.title(of: "  \n\n"))
    }

    func testComputerActivityDecodesWithExactLifecycleCaptions() throws {
        let activity: TranscriptJSONValue = .object([
            "version": .number(1), "kind": .string("computer"),
            "evidence": .string("native"), "targets": .array([])
        ])
        let runningSession = TranscriptSessionMetadata(
            id: "session-1", workspaceId: "workspace-1", provider: "codex",
            modelLabel: "GPT", modelId: "gpt", prompt: "Use the app", state: .running,
            attention: .normal, reasoningEffort: nil, agentMode: "auto"
        )
        let start = event("computer", "command.started", "computer", 1, [
            "id": .string("computer-1"), "name": .string("mcp__computer__use"), "activity": activity
        ])

        let running = try XCTUnwrap(firstTool(TranscriptProjection.project(
            events: [start], session: runningSession
        )))
        XCTAssertEqual(running.activity.kind, .computer)
        XCTAssertEqual(running.summary, "Using a computer")

        let succeeded = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            start,
            event("computer-end", "command.completed", "done", 2, [
                "tool_use_id": .string("computer-1")
            ])
        ])))
        XCTAssertEqual(succeeded.summary, "Used a computer")
        XCTAssertEqual(succeeded.activity.label(state: .failed), "Computer use failed")
        XCTAssertEqual(succeeded.activity.label(state: .cancelled), "Computer use cancelled")
        XCTAssertEqual(succeeded.activity.label(state: .unconfirmed), "Computer use")
    }

    func testVisibleAssistantProgressSettlesAnUnmatchedNonAgentTool() throws {
        let runningSession = TranscriptSessionMetadata(
            id: "session-1", workspaceId: "workspace-1", provider: "claude",
            modelLabel: "Claude", modelId: "claude", prompt: "Read it", state: .running,
            attention: .normal, reasoningEffort: nil, agentMode: "auto"
        )
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("read", "command.started", "Read", 1, [
                "id": .string("read-1"), "name": .string("Read")
            ]),
            event("answer", "message.delta", "I found the issue.", 2)
        ], session: runningSession)))

        XCTAssertEqual(tool.status, .done)
        XCTAssertFalse(tool.completionObserved)
        XCTAssertEqual(tool.summary, "File read")
    }

    func testCodexFileChangeUsesItsSingleActivityTargetForDiffNavigation() throws {
        let activity: TranscriptJSONValue = .object([
            "version": .number(1),
            "kind": .string("edit"),
            "evidence": .string("native"),
            "targets": .array([.string("/repo/Sources/App.swift")])
        ])
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(
            events: [
                event("edit", "command.started", "file_change", 1, [
                    "id": .string("edit-1"),
                    "name": .string("file_change"),
                    "input": .object([
                        "changes": .array([.object([
                            "kind": .string("update"),
                            "path": .string("/repo/Sources/App.swift"),
                            "unified_diff": .string("@@ -1,1 +1,2 @@\n-old\n+new\n+extra\n")
                        ])])
                    ]),
                    "activity": activity
                ]),
                event("edit-end", "command.completed", "done", 2, [
                    "tool_use_id": .string("edit-1"),
                    "status": .string("completed")
                ])
            ],
            workspacePath: "/repo"
        )))

        XCTAssertEqual(tool.filePath, "/repo/Sources/App.swift")
        XCTAssertEqual(tool.fileLabel, "Sources/App.swift")
        XCTAssertEqual(tool.diffPath, "Sources/App.swift")
        XCTAssertEqual(tool.visibleChangeCounts, TranscriptChangeCounts(additions: 2, deletions: 1))
    }

    func testEditCountsRequireAnObservedSuccessfulCompletion() throws {
        let start = event("edit", "command.started", "Edit", 1, [
            "id": .string("edit-1"),
            "name": .string("Edit"),
            "input": .object([
                "file_path": .string("Sources/App.swift"),
                "old_string": .string("old\n"),
                "new_string": .string("new\nextra\n")
            ]),
            "activity": .object([
                "version": .number(1),
                "kind": .string("edit"),
                "evidence": .string("tool"),
                "targets": .array([.string("Sources/App.swift")])
            ])
        ])
        let running = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [start])))
        let failed = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            start,
            event("edit-end", "command.completed", "failed", 2, [
                "tool_use_id": .string("edit-1"),
                "status": .string("failed")
            ])
        ])))

        XCTAssertEqual(running.changeCounts, TranscriptChangeCounts(additions: 2, deletions: 1))
        XCTAssertNil(running.visibleChangeCounts)
        XCTAssertNil(failed.visibleChangeCounts)
    }

    func testClaudeIsErrorCompletionMarksTheToolFailed() throws {
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("read", "command.started", "Read", 1, [
                "id": .string("read-1"), "name": .string("Read")
            ]),
            event("read-end", "command.completed", "missing", 2, [
                "tool_use_id": .string("read-1"),
                "is_error": .bool(true),
                "content": .string("missing")
            ])
        ])))

        XCTAssertEqual(tool.status, .failed)
        XCTAssertEqual(tool.error, "missing")
        XCTAssertEqual(tool.summary, "File read failed")
    }

    func testNormalizedNoMatchesDoesNotTurnSearchExitOneIntoFailure() throws {
        let searchActivity: TranscriptJSONValue = .object([
            "version": .number(1), "kind": .string("search"),
            "evidence": .string("command"), "targets": .array([])
        ])
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("search", "command.started", "Search", 1, [
                "id": .string("search-1"), "name": .string("Search"), "activity": searchActivity
            ]),
            event("search-end", "command.completed", "", 2, [
                "tool_use_id": .string("search-1"),
                "status": .string("completed"),
                "exit_code": .number(1),
                "noMatches": .bool(true)
            ])
        ])))

        XCTAssertEqual(tool.status, .done)
        XCTAssertNil(tool.error)
        XCTAssertEqual(tool.activitySummary, "Searched files")
    }

    func testNoMatchesDoesNotHideAnExplicitToolError() throws {
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("search", "command.started", "Search", 1, [
                "id": .string("search-1"), "name": .string("Search")
            ]),
            event("search-end", "command.completed", "permission denied", 2, [
                "tool_use_id": .string("search-1"),
                "status": .string("completed"),
                "exit_code": .number(1),
                "noMatches": .bool(true),
                "error": .string("permission denied")
            ])
        ])))

        XCTAssertEqual(tool.status, .failed)
        XCTAssertEqual(tool.error, "permission denied")
    }

    func testCompletionActivityAddsDiscoveryCountWithoutGenericActivityErasingStart() throws {
        let discovery: TranscriptJSONValue = .object([
            "version": .number(1), "kind": .string("discovery"),
            "evidence": .string("tool"), "targets": .array([])
        ])
        let generic: TranscriptJSONValue = .object([
            "version": .number(1), "kind": .string("tool"),
            "evidence": .string("tool"), "targets": .array([]), "toolCount": .number(1)
        ])
        let specificItems = TranscriptProjection.project(events: [
            event("search", "command.started", "ToolSearch", 1, [
                "id": .string("search-1"), "name": .string("ToolSearch"), "activity": discovery
            ]),
            event("search-end", "command.completed", "done", 2, [
                "tool_use_id": .string("search-1"),
                "activity": .object([
                    "version": .number(1), "kind": .string("discovery"),
                    "evidence": .string("native"), "targets": .array([]), "toolCount": .number(3)
                ])
            ])
        ])
        let specific = try XCTUnwrap(firstTool(specificItems))
        XCTAssertEqual(specific.activity.kind, .discovery)
        XCTAssertEqual(specific.activity.toolCount, 3)
        XCTAssertEqual(specific.summary, "Loaded tools")

        let genericItems = TranscriptProjection.project(events: [
            event("search", "command.started", "ToolSearch", 1, [
                "id": .string("search-1"), "name": .string("ToolSearch"), "activity": discovery
            ]),
            event("search-end", "command.completed", "done", 2, [
                "tool_use_id": .string("search-1"), "activity": generic
            ])
        ])
        XCTAssertEqual(try XCTUnwrap(firstTool(genericItems)).activity.kind, .discovery)
        XCTAssertEqual(try XCTUnwrap(firstTool(genericItems)).activity.toolCount, 1)
        XCTAssertEqual(try XCTUnwrap(firstTool(genericItems)).summary, "Loaded a tool")
    }

    func testAnonymousImageResultKeepsTheIntentReportedAtStart() throws {
        let activity: (String) -> TranscriptJSONValue = { kind in
            .object([
                "version": .number(1), "kind": .string(kind),
                "evidence": .string("native"), "targets": .array([])
            ])
        }
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("capture", "command.started", "Screenshot", 1, [
                "id": .string("capture-1"), "name": .string("Screenshot"),
                "activity": activity("image-capture")
            ]),
            event("capture-end", "command.completed", "image", 2, [
                "tool_use_id": .string("capture-1"), "activity": activity("image")
            ])
        ])))

        XCTAssertEqual(tool.activity.kind, .imageCapture)
        XCTAssertEqual(tool.summary, "Captured a screenshot")
    }

    func testAnonymousImageResultKeepsComputerUseIntent() throws {
        let activity: (String) -> TranscriptJSONValue = { kind in
            .object([
                "version": .number(1), "kind": .string(kind),
                "evidence": .string("native"), "targets": .array([])
            ])
        }
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("computer", "command.started", "computer", 1, [
                "id": .string("computer-1"), "name": .string("computer"),
                "activity": activity("computer")
            ]),
            event("computer-end", "command.completed", "image", 2, [
                "tool_use_id": .string("computer-1"), "activity": activity("image")
            ])
        ])))

        XCTAssertEqual(tool.activity.kind, .computer)
        XCTAssertEqual(tool.summary, "Used a computer")
        XCTAssertEqual(
            TranscriptToolIcon.source(for: tool.name, activity: tool.activity),
            .system(name: "desktopcomputer")
        )
    }

    func testInvalidActivityMetadataFallsBackToExactLegacyToolIdentity() throws {
        let tool = try XCTUnwrap(firstTool(TranscriptProjection.project(events: [
            event("edit", "command.started", "search_replace", 1, [
                "id": .string("edit-1"),
                "name": .string("search_replace"),
                "activity": .object([
                    "version": .number(2), "kind": .string("read"),
                    "evidence": .string("native"), "targets": .array([])
                ])
            ])
        ])))
        XCTAssertEqual(tool.activity.kind, .edit)
        XCTAssertEqual(tool.summary, "File change")
    }

    func testQuestionUsesFirstValidRetryAndSuppressesPostCardProse() throws {
        let events = [
            event("user", "user.message", "Choose", 1),
            event("bad", "command.started", "AskUserQuestion", 2, [
                "id": .string("bad-tool"),
                "name": .string("AskUserQuestion"),
                "input": .object(["questions": .array([])])
            ]),
            event("good", "command.started", "AskUserQuestion", 3, [
                "id": .string("good-tool"),
                "name": .string("AskUserQuestion"),
                "input": .object(["questions": .array([
                    .object([
                        "question": .string("Which implementation?"),
                        "header": .string("Approach"),
                        "multiSelect": .bool(false),
                        "options": .array([
                            .object(["label": .string("Native"), "description": .string("SwiftUI")]),
                            .object(["label": .string("Web")])
                        ])
                    ])
                ])])
            ]),
            event("hallucinated", "message.completed", "I picked for you.", 4),
            event("answer", "user.message", "Approach: Native", 5)
        ]

        let items = TranscriptProjection.project(events: events)
        let card = try XCTUnwrap(items.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }.first)
        XCTAssertEqual(card.toolUseId, "good-tool")
        XCTAssertEqual(card.questions.first?.options.map(\.label), ["Native", "Web"])
        XCTAssertFalse(card.isOutstanding)
        XCTAssertFalse(items.contains { item in
            guard case .assistant(let message) = item else { return false }
            return message.text == "I picked for you."
        })
    }

    func testAsyncQuestionKeepsLaterAssistantMessage() throws {
        let payload: [String: TranscriptJSONValue] = [
            "id": .string("ask-1"),
            "name": .string("AskUserQuestion"),
            "delivery": .string("async"),
            "input": .object(["questions": .array([
                .object([
                    "question": .string("Which surface?"),
                    "options": .array([
                        .object(["label": .string("iOS")]),
                        .object(["label": .string("Both")])
                    ])
                ])
            ])])
        ]
        let items = TranscriptProjection.project(events: [
            event("user", "user.message", "Go", 1),
            event("ask-start", "command.started", "AskUserQuestion", 2, payload),
            event("ask-end", "command.completed", "AskUserQuestion", 3, payload),
            event("prose", "message.completed", "I found the iPhone app.", 4)
        ])
        let cards = items.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }
        XCTAssertEqual(cards.count, 1)
        let card = try XCTUnwrap(cards.first)
        XCTAssertEqual(card.toolUseId, "ask-1")
        XCTAssertEqual(card.questions.first?.options.map(\.label), ["iOS", "Both"])
        XCTAssertTrue(card.isOutstanding)
        XCTAssertTrue(items.contains { item in
            guard case .assistant(let message) = item else { return false }
            return message.text == "I found the iPhone app."
        })
    }

    func testCodexBlockingQuestionKeepsRequestMetadataAcrossReconnect() throws {
        let payload: [String: TranscriptJSONValue] = [
            "id": .string("item-1"),
            "name": .string("AskUserQuestion"),
            "providerRequestId": .string("request-1"),
            "providerInvocationId": .string("invocation-1"),
            "input": .object([
                "delivery": .string("blocking"),
                "requestId": .string("request-1"),
                "questions": .array([
                    .object([
                        "id": .string("scope"),
                        "header": .string("Scope"),
                        "question": .string("Where should it run?"),
                        "isOther": .bool(false),
                        "isSecret": .bool(false),
                        "options": .array([
                            .object([
                                "label": .string("Current checkout"),
                                "description": .string("Use this workspace")
                            ])
                        ])
                    ]),
                    .object([
                        "id": .string("token"),
                        "header": .string("Token"),
                        "question": .string("Enter the token"),
                        "isOther": .bool(false),
                        "isSecret": .bool(true),
                        "options": .array([])
                    ])
                ])
            ])
        ]
        let session = TranscriptSessionMetadata(
            id: "session-1",
            workspaceId: "workspace-1",
            provider: "codex",
            modelLabel: "GPT",
            modelId: "gpt-5",
            prompt: "Start",
            state: .waiting,
            attention: .questionAsked,
            reasoningEffort: nil,
            agentMode: "auto"
        )

        let items = TranscriptProjection.project(
            events: [event("ask-start", "command.started", "AskUserQuestion", 2, payload)],
            session: session
        )
        let card = try XCTUnwrap(items.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }.first)

        XCTAssertTrue(card.isOutstanding)
        XCTAssertEqual(card.sessionID, "session-1")
        XCTAssertEqual(card.requestID, "request-1")
        XCTAssertEqual(card.questions.map(\.responseID), ["scope", "token"])
        XCTAssertFalse(card.questions[0].allowsOther)
        XCTAssertTrue(card.questions[1].allowsOther)
        XCTAssertTrue(card.questions[1].isSecret)
    }

    func testCodexQuestionCompletionMakesReloadedCardInactive() throws {
        let started: [String: TranscriptJSONValue] = [
            "id": .string("item-1"),
            "name": .string("AskUserQuestion"),
            "providerRequestId": .string("request-1"),
            "providerInvocationId": .string("invocation-1"),
            "input": .object([
                "requestId": .string("request-1"),
                "questions": .array([
                    .object([
                        "id": .string("scope"),
                        "header": .string("Scope"),
                        "question": .string("Where should it run?"),
                        "isOther": .bool(false),
                        "isSecret": .bool(false),
                        "options": .array([.object(["label": .string("Here")])])
                    ])
                ])
            ])
        ]
        let completed: [String: TranscriptJSONValue] = [
            "id": .string("item-1"),
            "providerInvocationId": .string("invocation-1"),
            "status": .string("cancelled")
        ]

        let items = TranscriptProjection.project(events: [
            event("ask-start", "command.started", "AskUserQuestion", 2, started),
            event("ask-end", "command.completed", "Question cancelled", 3, completed)
        ])
        let card = try XCTUnwrap(items.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }.first)

        XCTAssertFalse(card.isOutstanding)
    }

    func testSuccessiveCodexQuestionsInOneTurnKeepTheLatestAnswerable() throws {
        func questionStart(itemID: String, requestID: String, questionID: String) -> TranscriptEvent {
            event("\(itemID)-start", "command.started", "AskUserQuestion", itemID == "item-1" ? 2 : 5, [
                "id": .string(itemID),
                "name": .string("AskUserQuestion"),
                "requestId": .string(requestID),
                "providerInvocationId": .string("invocation-1"),
                "input": .object([
                    "delivery": .string("blocking"),
                    "requestId": .string(requestID),
                    "questions": .array([
                        .object([
                            "id": .string(questionID),
                            "header": .string("Scope"),
                            "question": .string("Where should it run?"),
                            "isOther": .bool(false),
                            "isSecret": .bool(false),
                            "options": .array([
                                .object([
                                    "label": .string("Here"),
                                    "description": .string("Use this checkout")
                                ])
                            ])
                        ])
                    ])
                ])
            ])
        }
        func questionCompletion(itemID: String, cursor: Int64) -> TranscriptEvent {
            event("\(itemID)-end", "command.completed", "AskUserQuestion", cursor, [
                "id": .string(itemID),
                "providerInvocationId": .string("invocation-1"),
                "status": .string("completed")
            ])
        }
        func session(_ state: SessionState) -> TranscriptSessionMetadata {
            TranscriptSessionMetadata(
                id: "session-1",
                workspaceId: "workspace-1",
                provider: "codex",
                modelLabel: "GPT",
                modelId: "gpt-5",
                prompt: "Start",
                state: state,
                attention: state == .waiting ? .questionAsked : .normal,
                reasoningEffort: nil,
                agentMode: "auto"
            )
        }

        let waitingEvents = [
            event("user", "user.message", "Start", 1),
            questionStart(itemID: "item-1", requestID: "request-1", questionID: "first"),
            questionCompletion(itemID: "item-1", cursor: 3),
            event("between", "message.completed", "First answer accepted.", 4),
            questionStart(itemID: "item-2", requestID: "request-2", questionID: "second")
        ]
        let waitingItems = TranscriptProjection.project(events: waitingEvents, session: session(.waiting))
        let waitingCards = waitingItems.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }

        XCTAssertEqual(waitingCards.map(\.requestID), ["request-1", "request-2"])
        XCTAssertEqual(waitingCards.map(\.isOutstanding), [false, true])
        XCTAssertTrue(waitingItems.contains { item in
            guard case .assistant(let message) = item else { return false }
            return message.text == "First answer accepted."
        })

        let completedItems = TranscriptProjection.project(
            events: waitingEvents + [
                questionCompletion(itemID: "item-2", cursor: 6),
                event("after", "message.completed", "Continuing after the second answer.", 7)
            ],
            session: session(.running)
        )
        let completedCards = completedItems.compactMap { item -> TranscriptQuestionCard? in
            guard case .question(let card) = item else { return nil }
            return card
        }
        let assistantMessages = completedItems.compactMap { item -> String? in
            guard case .assistant(let message) = item else { return nil }
            return message.text
        }

        XCTAssertEqual(completedCards.map(\.isOutstanding), [false, false])
        XCTAssertEqual(assistantMessages, [
            "First answer accepted.",
            "Continuing after the second answer."
        ])
    }

    func testDecodesPageWireAndMessageAttachments() throws {
        let data = Data(
            """
            {"events":[{"id":"u","sessionId":"s","type":"user.message","message":"@/tmp/image.png\\nSee image",
              "payload":{"attachments":[{"filePath":"/tmp/image.png","mimeType":"image/png","sizeBytes":12}]},
              "createdAt":"2026-01-01T00:00:00.000Z","rowCursor":1}],"rawOutputs":[],
              "eventCursor":1,"rawOutputCursor":0,"changeCursor":2,"deletedEventIds":[],
              "deletedRawOutputIds":[],"resetRequired":true,"hasMore":false}
            """.utf8
        )
        let page = try JSONDecoder().decode(TranscriptPage.self, from: data)
        let items = TranscriptProjection.project(events: page.events)
        guard case .user(let message) = try XCTUnwrap(items.first) else { return XCTFail("expected user") }
        XCTAssertEqual(message.attachments.first?.filePath, "/tmp/image.png")
        XCTAssertEqual(message.text, "See image")
        XCTAssertEqual(page.changeCursor, 2)
    }

    func testNativeAgentLifecycleOverridesTheLaunchTransportReceipt() throws {
        let launch: [String: TranscriptJSONValue] = [
            "id": .string("spawn-1"),
            "name": .string("spawn_agent"),
            "providerInvocationId": .string("invocation-1")
        ]
        let lifecycle: [String: TranscriptJSONValue] = [
            "agentRunId": .string("spawn-1"),
            "providerInvocationId": .string("invocation-1"),
            "providerChildSessionId": .string("child-1"),
            "providerParentConversationId": .string("parent-1")
        ]
        let session = TranscriptSessionMetadata(
            id: "session-1", workspaceId: "workspace-1", provider: "codex",
            modelLabel: "GPT", modelId: "gpt-5", prompt: "Start",
            state: .running, attention: .normal, reasoningEffort: nil, agentMode: "auto"
        )

        let running = try XCTUnwrap(firstAgent(TranscriptProjection.project(events: [
            event("launch", "command.started", "spawn_agent", 1, launch),
            event("receipt", "command.completed", "spawn_agent", 2, launch),
            event("started", "agent.started", "Agent started", 3, lifecycle)
        ], session: session)))
        XCTAssertEqual(running.status, .running)
        XCTAssertNil(running.completedAt)
        XCTAssertEqual(running.providerChildSessionId, "child-1")

        var completedLifecycle = lifecycle
        completedLifecycle["status"] = .string("completed")
        let completed = try XCTUnwrap(firstAgent(TranscriptProjection.project(events: [
            event("launch", "command.started", "spawn_agent", 1, launch),
            event("receipt", "command.completed", "spawn_agent", 2, launch),
            event("started", "agent.started", "Agent started", 3, lifecycle),
            event("completed", "agent.completed", "Agent completed", 4, completedLifecycle)
        ], session: session)))
        XCTAssertEqual(completed.status, .done)
        XCTAssertEqual(completed.completedAt, "2026-01-01T00:00:04.000Z")

        var failedLifecycle = lifecycle
        failedLifecycle["status"] = .string("failed")
        let failed = try XCTUnwrap(firstAgent(TranscriptProjection.project(events: [
            event("launch", "command.started", "spawn_agent", 1, launch),
            event("started", "agent.started", "Agent started", 2, lifecycle),
            event("failed", "agent.completed", "Agent failed", 3, failedLifecycle)
        ], session: session)))
        XCTAssertEqual(failed.status, .failed)

        let interrupted = try XCTUnwrap(firstAgent(TranscriptProjection.project(events: [
            event("launch", "command.started", "spawn_agent", 1, launch),
            event("started", "agent.started", "Agent started", 2, lifecycle),
            event("exit", "session.cancelled", "Session cancelled", 3)
        ], session: session)))
        XCTAssertEqual(interrupted.status, .failed)
        XCTAssertEqual(interrupted.completedAt, "2026-01-01T00:00:03.000Z")
    }

    /// A cancelled call is an interruption — the user stopped the turn, or the
    /// provider dropped an in-flight call — not something that failed.
    func testCancelledToolCallsAreNotFailures() throws {
        let items = TranscriptProjection.project(events: [
            event("read", "command.started", "Read", 1, ["id": .string("tool-1"), "name": .string("Read")]),
            event("read-end", "command.completed", "stopped", 2, [
                "tool_use_id": .string("tool-1"),
                "status": .string("cancelled")
            ]),
            event("bash", "command.started", "Bash", 3, ["id": .string("tool-2"), "name": .string("Bash")]),
            event("bash-end", "command.completed", "boom", 4, [
                "tool_use_id": .string("tool-2"),
                "status": .string("failed")
            ])
        ])
        let tools = items.compactMap { item -> TranscriptToolGroup? in
            guard case .tools(let group) = item else { return nil }
            return group
        }.flatMap(\.tools)
        XCTAssertEqual(tools.map(\.status), [.done, .failed])
        XCTAssertNil(tools.first?.error)
        XCTAssertEqual(tools.map(\.activitySummary), ["File read cancelled", "Command failed"])
    }

    private func firstTool(_ items: [TranscriptItem]) -> TranscriptTool? {
        items.compactMap { item -> TranscriptTool? in
            guard case .tools(let group) = item else { return nil }
            return group.tools.first
        }.first
    }

    private func firstAgent(_ items: [TranscriptItem]) -> TranscriptAgent? {
        items.compactMap { item -> TranscriptAgent? in
            guard case .agents(let group) = item else { return nil }
            return group.agents.first
        }.first
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
}
