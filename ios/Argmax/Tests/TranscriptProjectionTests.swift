import XCTest
@testable import Argmax

final class TranscriptProjectionTests: XCTestCase {
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
        XCTAssertEqual(agent.children.first?.summary, "Bash · npm test")

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
