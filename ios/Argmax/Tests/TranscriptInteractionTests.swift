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
    func testQuestionResponseStopsBeforeSendingAndPreservesMode() async {
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

        let sent = await coordinator.answerQuestion("Scope: iPhone", context: context)
        let calls = await client.calls
        XCTAssertTrue(sent)
        XCTAssertEqual(calls, ["stop:session-1", "send:Scope: iPhone:plan"])
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
