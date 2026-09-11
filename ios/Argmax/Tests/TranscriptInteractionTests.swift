import XCTest
@testable import Argmax

final class TranscriptInteractionTests: XCTestCase {
    func testQuestionAnswerUsesHeadersAndPlainLabelsInQuestionOrder() {
        let questions = [
            TranscriptQuestion(
                question: "Where should it run?",
                header: "Location",
                options: [
                    TranscriptQuestionOption(label: "Current checkout", detail: nil),
                    TranscriptQuestionOption(label: "Worktree", detail: "Keeps it isolated")
                ],
                allowsMultiple: false
            ),
            TranscriptQuestion(
                question: "Which checks?",
                header: "Checks",
                options: [
                    TranscriptQuestionOption(label: "Unit tests", detail: nil),
                    TranscriptQuestionOption(label: "UI tests", detail: nil)
                ],
                allowsMultiple: true
            )
        ]

        XCTAssertEqual(
            transcriptQuestionAnswer(
                questions: questions,
                selections: [[1], [0, 2]],
                otherText: ["", "Run it on a phone too"]
            ),
            "Location: Worktree\nChecks: Unit tests, Run it on a phone too"
        )
    }

    func testCodexQuestionResponseKeepsQuestionIDsAndWireAnswerShapes() {
        let questions = [
            TranscriptQuestion(
                question: "Where should it run?",
                header: "Location",
                options: [TranscriptQuestionOption(label: "Current checkout", detail: nil)],
                allowsMultiple: false,
                responseID: "location",
                allowsOther: false
            ),
            TranscriptQuestion(
                question: "Add context",
                header: "Context",
                options: [],
                allowsMultiple: false,
                responseID: "context",
                allowsOther: true
            )
        ]

        let response = transcriptQuestionResponse(
            questions: questions,
            selections: [[0], [0]],
            otherText: ["", "Keep my draft"]
        )

        XCTAssertEqual(response.answers, [
            "location": ["Current checkout"],
            "context": ["user_note: Keep my draft"]
        ])
    }

    func testSecretQuestionResponseRedactsItsDisplayText() {
        let question = TranscriptQuestion(
            question: "Enter the token",
            header: "Token",
            options: [],
            allowsMultiple: false,
            responseID: "token",
            allowsOther: true,
            isSecret: true
        )

        let response = transcriptQuestionResponse(
            questions: [question],
            selections: [[0]],
            otherText: ["super-secret"]
        )

        XCTAssertEqual(response.answers, ["token": ["user_note: super-secret"]])
        XCTAssertEqual(response.displayText, "Token: (hidden)")
        XCTAssertFalse(response.displayText.contains("super-secret"))
    }

    func testOtherRequiresTextAndMultipleChoiceRequiresAPick() {
        let question = TranscriptQuestion(
            question: "Choose checks",
            header: "Checks",
            options: [TranscriptQuestionOption(label: "Unit", detail: nil)],
            allowsMultiple: true
        )

        XCTAssertFalse(transcriptQuestionIsAnswered(question, selections: [], otherText: ""))
        XCTAssertFalse(transcriptQuestionIsAnswered(question, selections: [1], otherText: "  "))
        XCTAssertTrue(transcriptQuestionIsAnswered(question, selections: [0, 1], otherText: "Lint"))
    }

    func testApprovalActionKeepsShellCommandIntact() {
        XCTAssertEqual(
            transcriptApprovalAction("npm test -- --runInBand"),
            TranscriptApprovalAction(title: "npm test -- --runInBand", arguments: [])
        )
    }

    func testApprovalActionShowsOnlyScalarToolArguments() {
        let action = transcriptApprovalAction(
            "WriteFile\n{\"path\":\"README.md\",\"overwrite\":true,\"body\":{\"large\":\"payload\"}}"
        )

        XCTAssertEqual(action.title, "WriteFile")
        XCTAssertEqual(
            action.arguments,
            [
                TranscriptApprovalAction.Argument(key: "overwrite", value: "true"),
                TranscriptApprovalAction.Argument(key: "path", value: "README.md")
            ]
        )
    }

    func testApprovalResolutionPayloadMatchesHostKeys() throws {
        let data = try JSONEncoder().encode(ResolveTranscriptApprovalInput(
            approvalId: "approval-1",
            status: .rejected
        ))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])

        XCTAssertEqual(body, ["approvalId": "approval-1", "status": "rejected"])
    }

    func testPlanTitleUsesFirstContentLineWithoutHeadingMarker() {
        XCTAssertEqual(transcriptPlanTitle("\n## Native transcript\n\nDetails"), "Native transcript")
        XCTAssertEqual(transcriptPlanTitle("\n\n"), "Plan")
    }

    func testMultitaskPreviewUnwrapsMarkdownAndSkipsPlaceholders() {
        XCTAssertEqual(
            transcriptMultitaskAnswerPreview("## Done\n\n- Renamed `user_id` to **userId**."),
            "Done"
        )
        XCTAssertNil(transcriptMultitaskAnswerPreview("(no answer)"))
        XCTAssertEqual(transcriptMultitaskStatus("blocked").label, "Waiting for you")
        XCTAssertEqual(transcriptMultitaskStatus("cancelled").label, "Stopped")
    }

    func testMultitaskDismissalsPersistNewestTwoHundredChildSessions() throws {
        let suite = "argmax.transcript-dismissals.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        for index in 0..<205 {
            TranscriptMultitaskDismissals.dismiss("child-\(index)", defaults: defaults)
        }

        let stored = TranscriptMultitaskDismissals.read(defaults: defaults)
        XCTAssertEqual(stored.count, 200)
        XCTAssertEqual(stored.first, "child-5")
        XCTAssertEqual(stored.last, "child-204")
        XCTAssertTrue(TranscriptMultitaskDismissals.contains("child-100", defaults: defaults))
    }

    @MainActor
    func testLegacyQuestionResponseStopsBeforeSendingAndPreservesMode() async {
        let client = InteractionClientSpy()
        let coordinator = TranscriptInteractionCoordinator(client: client)
        let context = TranscriptSendContext(
            sessionID: "session-1",
            provider: "claude",
            modelLabel: "Sonnet",
            modelID: "claude-sonnet",
            reasoningEffort: nil,
            agentMode: "plan",
            isRunning: true
        )

        let card = TranscriptQuestionCard(
            id: "question-1",
            toolUseId: "ask-1",
            createdAt: "2026-09-12T08:00:00Z",
            questions: [],
            isOutstanding: true
        )
        let sent = await coordinator.answerQuestion(
            TranscriptQuestionResponse(displayText: "Scope: iPhone", answers: [:]),
            card: card,
            context: context
        )
        let calls = await client.calls
        XCTAssertTrue(sent)
        XCTAssertEqual(calls, ["stop:session-1", "send:Scope: iPhone:plan"])
    }

    @MainActor
    func testCodexQuestionResponseResolvesTheLiveRequestWithoutStoppingTheTurn() async {
        let client = InteractionClientSpy()
        let coordinator = TranscriptInteractionCoordinator(client: client)
        let context = TranscriptSendContext(
            sessionID: "session-context",
            provider: "codex",
            modelLabel: "GPT",
            modelID: "gpt-5",
            reasoningEffort: nil,
            agentMode: "auto",
            isRunning: false
        )
        let card = TranscriptQuestionCard(
            id: "question-1",
            toolUseId: "ask-1",
            createdAt: "2026-09-12T08:00:00Z",
            questions: [],
            isOutstanding: true,
            sessionID: "session-request",
            requestID: "request-1"
        )

        let sent = await coordinator.answerQuestion(
            TranscriptQuestionResponse(
                displayText: "Location: Current checkout",
                answers: ["location": ["Current checkout"]]
            ),
            card: card,
            context: context
        )
        let calls = await client.calls

        XCTAssertTrue(sent)
        XCTAssertEqual(calls, ["question:session-request:request-1:location=Current checkout:answered"])
    }

    @MainActor
    func testDismissingCodexQuestionResolvesWithNoAnswers() async {
        let client = InteractionClientSpy()
        let coordinator = TranscriptInteractionCoordinator(client: client)
        let context = TranscriptSendContext(
            sessionID: "session-1",
            provider: "codex",
            modelLabel: "GPT",
            modelID: "gpt-5",
            reasoningEffort: nil,
            agentMode: "auto",
            isRunning: false
        )
        let card = TranscriptQuestionCard(
            id: "question-1",
            toolUseId: "ask-1",
            createdAt: "2026-09-12T08:00:00Z",
            questions: [],
            isOutstanding: true,
            sessionID: "session-1",
            requestID: "request-1"
        )

        let dismissed = await coordinator.dismissQuestion(card: card, context: context)
        let calls = await client.calls

        XCTAssertTrue(dismissed)
        XCTAssertEqual(calls, ["question:session-1:request-1::dismissed"])
    }

    @MainActor
    func testPlanAcceptanceSwitchesToAutoMode() async {
        let client = InteractionClientSpy()
        let coordinator = TranscriptInteractionCoordinator(client: client)
        let context = TranscriptSendContext(
            sessionID: "session-1",
            provider: "claude",
            modelLabel: "Sonnet",
            modelID: "claude-sonnet",
            reasoningEffort: nil,
            agentMode: "plan",
            isRunning: false
        )

        let sent = await coordinator.acceptPlan(context: context)
        let calls = await client.calls
        XCTAssertTrue(sent)
        XCTAssertEqual(calls, ["send:Proceed with the plan above.:auto"])
    }

    @MainActor
    func testApprovalResolutionUsesTheApprovalBroker() async {
        let client = InteractionClientSpy()
        let coordinator = TranscriptInteractionCoordinator(client: client)

        let resolved = await coordinator.resolveApproval(id: "approval-1", resolution: .approved)
        let calls = await client.calls

        XCTAssertTrue(resolved)
        XCTAssertEqual(calls, ["approval:approval-1:approved"])
    }
}

private actor InteractionClientSpy: TranscriptInteractionClient {
    private(set) var calls: [String] = []

    func sendInput(_ input: SendInputInput) async throws -> SendInputResult {
        calls.append("send:\(input.input):\(input.agentMode)")
        return SendInputResult(ok: true, queued: false)
    }

    func terminateSession(sessionID: String) async throws -> HostOk {
        calls.append("stop:\(sessionID)")
        return HostOk(ok: true)
    }

    func resolveTranscriptQuestion(
        _ input: ResolveTranscriptQuestionInput
    ) async throws -> TranscriptQuestionResolution {
        let answers = input.answers.keys.sorted().map { key in
            "\(key)=\(input.answers[key, default: []].joined(separator: ","))"
        }.joined(separator: ";")
        let status = input.dismissed == true ? "dismissed" : "answered"
        calls.append("question:\(input.sessionId):\(input.requestId):\(answers):\(status)")
        return TranscriptQuestionResolution(
            sessionId: input.sessionId,
            requestId: input.requestId,
            status: status
        )
    }

    func resolveTranscriptApproval(
        approvalID: String,
        resolution: TranscriptApprovalResolution
    ) async throws -> TranscriptApprovalRequest {
        calls.append("approval:\(approvalID):\(resolution.rawValue)")
        return TranscriptApprovalRequest(
            id: approvalID,
            sessionId: "session-1",
            command: "npm test",
            cwd: "/repo",
            provider: "claude",
            providerInvocationId: nil,
            providerRequestId: nil,
            riskLevel: "low",
            status: resolution.rawValue,
            createdAt: "2026-09-12T08:00:00Z",
            resolvedAt: "2026-09-12T08:00:01Z"
        )
    }
}
