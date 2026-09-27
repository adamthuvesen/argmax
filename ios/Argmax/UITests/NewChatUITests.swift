import XCTest

@MainActor
final class NewChatUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        launch(["-scenario-reset-launch-mode"])
    }

    func testChatAndCodeSwitchPreservesDraftAndKeepsChoicesSeparate() {
        let chat = app.buttons["new-chat-chat"]
        let code = app.buttons["new-chat-code"]
        XCTAssertTrue(chat.isSelected)
        XCTAssertFalse(code.isSelected)
        XCTAssertFalse(app.buttons["argmax"].exists)
        XCTAssertFalse(app.buttons["Current checkout"].exists)
        screenshot("new-chat-chat-light")

        let composer = app.descendants(matching: .any).matching(identifier: "Task").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("A draft survives the switch")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(chat.isHittable)
        XCTAssertTrue(code.isHittable)
        XCTAssertLessThan(composer.frame.maxY, app.keyboards.firstMatch.frame.minY)
        screenshot("new-chat-keyboard-light")

        code.tap()
        XCTAssertTrue(code.isSelected)
        XCTAssertFalse(chat.isSelected)
        XCTAssertTrue(app.buttons["argmax"].exists)
        XCTAssertTrue(app.buttons["Current checkout"].exists)
        XCTAssertEqual(composer.value as? String, "A draft survives the switch")
        screenshot("new-chat-code-keyboard-light")

        app.buttons["Current checkout"].tap()
        XCTAssertTrue(app.staticTexts["Workspace"].waitForExistence(timeout: 5))
        let worktree = app.buttons.containing(.staticText, identifier: "New worktree").firstMatch
        XCTAssertTrue(worktree.exists)
        XCTAssertTrue(app.buttons.containing(.staticText, identifier: "Branch from…").firstMatch.exists)
        // The header's Chat tab remains in the accessibility tree behind
        // the sheet. Only a second Chat button would be a workspace option.
        XCTAssertFalse(app.buttons.matching(
            NSPredicate(format: "label == %@ AND identifier != %@", "Chat", "new-chat-chat")
        ).firstMatch.exists)
        worktree.tap()

        chat.tap()
        XCTAssertTrue(chat.isSelected)
        XCTAssertFalse(app.buttons["argmax"].exists)
        XCTAssertFalse(app.buttons["Current checkout"].exists)
        XCTAssertEqual(composer.value as? String, "A draft survives the switch")
        code.tap()
        XCTAssertTrue(app.buttons["New worktree"].exists)
        XCTAssertEqual(composer.value as? String, "A draft survives the switch")
    }

    func testLastModePersistsAcrossAppRelaunches() {
        app.buttons["new-chat-code"].tap()
        XCTAssertTrue(app.buttons["new-chat-code"].isSelected)

        app.terminate()
        launch()
        XCTAssertTrue(app.buttons["new-chat-code"].isSelected)
        XCTAssertTrue(app.buttons["Current checkout"].exists)

        app.buttons["new-chat-chat"].tap()
        app.terminate()
        launch()
        XCTAssertTrue(app.buttons["new-chat-chat"].isSelected)
        XCTAssertFalse(app.buttons["Current checkout"].exists)
    }

    func testNewChatHereOpensCodeWithBranchChoice() {
        app.terminate()
        launch(["-scenario-reset-launch-mode", "-scenario-new-chat-here"])
        XCTAssertTrue(app.buttons["new-chat-code"].isSelected)
        XCTAssertTrue(app.buttons["argmax"].exists)
        XCTAssertTrue(app.buttons["Branch from…"].exists)
        XCTAssertTrue(app.buttons["adam/feat-chat-actions"].exists)
    }

    func testDarkAppearanceShowsBothModes() {
        app.terminate()
        launch(["-scenario-reset-launch-mode", "-scenario-dark"])
        screenshot("new-chat-chat-dark")
        app.buttons["new-chat-code"].tap()
        screenshot("new-chat-code-dark")
    }

    private func launch(_ extraArguments: [String] = []) {
        app.launchArguments = ["-argmax-new-chat-scenario"] + extraArguments
        app.launch()
        XCTAssertTrue(app.buttons["new-chat-chat"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["new-chat-code"].exists)
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
