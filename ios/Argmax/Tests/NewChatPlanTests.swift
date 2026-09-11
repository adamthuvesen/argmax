import XCTest
@testable import Argmax

/// What "Start chat" resolves to.
///
/// The web launcher (`src/renderer/mobile/NewSessionScreen.tsx`) is the
/// specification, so these pin the two things that could quietly diverge from
/// it: which `workspaces:create-*` each mode runs, and the exact object
/// `providers:launch` receives.
final class NewChatPlanTests: XCTestCase {
    private let project = makeProject(id: "p-1", name: "argmax")
    private let model = ModelSelection(
        provider: "claude",
        label: "Opus 5",
        modelId: "claude-opus-5",
        reasoningEffort: .medium
    )

    private func plan(
        _ mode: NewChatMode,
        project: ProjectSummary?,
        baseRef: String? = nil,
        prompt: String = "Tidy the chat list"
    ) -> NewChatPlan? {
        NewChatPlan(
            mode: mode,
            project: project,
            baseRef: baseRef,
            model: model,
            titleModelId: "claude-sonnet-5",
            prompt: prompt
        )
    }

    // MARK: - Mode → channel

    func testEachModeRunsItsOwnCreateChannel() throws {
        XCTAssertEqual(try XCTUnwrap(plan(.worktree, project: project)).creation.channel, "workspaces:create-isolated")
        XCTAssertEqual(try XCTUnwrap(plan(.current, project: project)).creation.channel, "workspaces:create-current")
        XCTAssertEqual(
            try XCTUnwrap(plan(.branchFrom, project: project, baseRef: "adam/feat-x")).creation.channel,
            "workspaces:create-isolated"
        )
        XCTAssertEqual(try XCTUnwrap(plan(.sideChat, project: nil)).creation.channel, "workspaces:create-scratch")
    }

    /// The renderer sends the project's current branch rather than null, so
    /// the worktree's base is recorded rather than inferred later.
    func testANewWorktreeBranchesFromTheProjectsCurrentBranch() throws {
        let plan = try XCTUnwrap(plan(.worktree, project: project))
        guard case .isolated(let input) = plan.creation else { return XCTFail("expected an isolated workspace") }
        XCTAssertEqual(input.projectId, "p-1")
        XCTAssertEqual(input.baseRef, "main")
    }

    func testBranchFromCarriesTheChosenBranch() throws {
        let plan = try XCTUnwrap(plan(.branchFrom, project: project, baseRef: "adam/feat-x"))
        guard case .isolated(let input) = plan.creation else { return XCTFail("expected an isolated workspace") }
        XCTAssertEqual(input.baseRef, "adam/feat-x")
    }

    func testBranchFromIsNotALaunchUntilABranchIsChosen() {
        XCTAssertNil(plan(.branchFrom, project: project, baseRef: nil))
    }

    func testARepositoryModeNeedsAProject() {
        XCTAssertNil(plan(.worktree, project: nil))
        XCTAssertNil(plan(.current, project: nil))
        XCTAssertNotNil(plan(.sideChat, project: nil), "a side chat has no repository, which is the point")
    }

    func testAnEmptyPromptIsNotALaunch() {
        XCTAssertNil(plan(.sideChat, project: nil, prompt: "   \n  "))
    }

    // MARK: - The launch payload

    /// The eleven keys `NewSessionScreen` sends, and nothing else: the host's
    /// `ProvidersLaunchInput` is `deny_unknown_fields`, so an extra key is a
    /// rejected launch rather than an ignored one.
    func testTheLaunchPayloadMatchesTheWebLaunchersOwn() throws {
        let plan = try XCTUnwrap(plan(.worktree, project: project))
        let data = try JSONEncoder().encode(plan.launchInput(workspaceID: "w-1"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(
            Set(body.keys),
            [
                "workspaceId", "provider", "prompt", "modelLabel", "modelId", "reasoningEffort",
                "fastMode", "agentMode", "cols", "rows", "attachments"
            ]
        )
        XCTAssertEqual(body["workspaceId"] as? String, "w-1")
        XCTAssertEqual(body["provider"] as? String, "claude")
        XCTAssertEqual(body["prompt"] as? String, "Tidy the chat list")
        XCTAssertEqual(body["modelLabel"] as? String, "Opus 5")
        XCTAssertEqual(body["modelId"] as? String, "claude-opus-5")
        XCTAssertEqual(body["reasoningEffort"] as? String, "medium")
        XCTAssertEqual(body["fastMode"] as? Bool, false)
        XCTAssertEqual(body["agentMode"] as? String, "auto")
        XCTAssertEqual(body["cols"] as? Int, 120)
        XCTAssertEqual(body["rows"] as? Int, 32)
        XCTAssertTrue(body["attachments"] is NSNull, "the sheet takes none, and the key still goes out")
    }

    /// A launch carrying picked images names each file in the prompt and
    /// lists it beside, the way the desktop launcher sends both. The chat's
    /// label stays the words: a screenshot's path is not a name.
    func testALaunchWithImagesNamesThemInThePromptAndBeside() throws {
        let plan = try XCTUnwrap(
            NewChatPlan(
                mode: .sideChat,
                project: nil,
                baseRef: nil,
                model: model,
                titleModelId: "claude-sonnet-5",
                prompt: "Match this mock",
                attachments: [
                    ComposerAttachment(filePath: "/data/attachments/launch-p-1/a.png", mimeType: "image/png", sizeBytes: 12)
                ]
            )
        )
        XCTAssertEqual(plan.taskLabel, "Match this mock")
        XCTAssertEqual(plan.autoTitleInput(workspaceID: "w-1").prompt, "Match this mock")

        let data = try JSONEncoder().encode(plan.launchInput(workspaceID: "w-1"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body["prompt"] as? String, "Match this mock @/data/attachments/launch-p-1/a.png")
        let attachments = try XCTUnwrap(body["attachments"] as? [[String: Any]])
        XCTAssertEqual(attachments.count, 1)
        XCTAssertEqual(Set(attachments[0].keys), ["filePath", "mimeType", "sizeBytes"])
    }

    func testAModelWithoutAnEffortSendsNull() throws {
        let plan = try XCTUnwrap(
            NewChatPlan(
                mode: .sideChat,
                project: nil,
                baseRef: nil,
                model: ModelSelection(
                    provider: "claude",
                    label: "Haiku 4.5",
                    modelId: "claude-haiku-4-5",
                    reasoningEffort: nil
                ),
                titleModelId: "claude-sonnet-5",
                prompt: "Ask something"
            )
        )
        let data = try JSONEncoder().encode(plan.launchInput(workspaceID: "w-1"))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertTrue(body["reasoningEffort"] is NSNull)
    }

    /// Titles ride the provider's cheap model, not the chat's — a title is a
    /// handful of tokens and should not wait on an Opus turn.
    func testTheAutoTitleCallUsesTheProvidersTitleModel() throws {
        let plan = try XCTUnwrap(plan(.worktree, project: project))
        let input = plan.autoTitleInput(workspaceID: "w-1")
        XCTAssertEqual(input.provider, "claude")
        XCTAssertEqual(input.modelId, "claude-sonnet-5")
        XCTAssertEqual(input.prompt, "Tidy the chat list")
    }

    // MARK: - The name a chat starts with

    /// `titleFromPrompt` in `src/renderer/lib/projects.ts`.
    func testTheTaskLabelIsTheFirstLineOfThePrompt() {
        XCTAssertEqual(NewChatPlan.taskLabel(fromPrompt: "Fix the list\n\nand then some"), "Fix the list")
        XCTAssertEqual(NewChatPlan.taskLabel(fromPrompt: "Fix the list\r\nmore"), "Fix the list")
        XCTAssertEqual(NewChatPlan.taskLabel(fromPrompt: "\n\nsecond line"), "Local agent task")
    }

    func testALongFirstLineIsElided() {
        let long = String(repeating: "a", count: 100)
        let label = NewChatPlan.taskLabel(fromPrompt: long)
        XCTAssertEqual(label.count, 64)
        XCTAssertTrue(label.hasSuffix("..."))
    }

    func testTheTaskLabelReachesTheCreateCall() throws {
        let plan = try XCTUnwrap(plan(.sideChat, project: nil, prompt: "  Ask something\nelse  "))
        guard case .scratch(let input) = plan.creation else { return XCTFail("expected a scratch workspace") }
        XCTAssertEqual(input.taskLabel, "Ask something")
        XCTAssertNil(input.kind)
    }
}
