import XCTest

@MainActor
final class TranscriptHeaderUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        launch()
    }

    func testCenteredHeaderStaysVisibleWhileConversationScrolls() {
        let title = app.staticTexts["transcript-title"]
        let subtitle = app.staticTexts["transcript-subtitle"]
        let menu = app.buttons["Chat actions"]
        XCTAssertTrue(app.otherElements["transcript-header"].exists)
        XCTAssertEqual(title.label, "Repository overview")
        XCTAssertEqual(subtitle.label, "argmax · main")
        XCTAssertTrue(menu.exists)
        XCTAssertEqual(app.buttons.matching(identifier: "Chat actions").count, 1)
        XCTAssertFalse(app.buttons["Files and changes"].exists)
        XCTAssertFalse(app.staticTexts["Idle"].exists)
        XCTAssertFalse(app.staticTexts["Running"].exists)
        XCTAssertLessThan(abs(title.frame.midX - app.frame.midX), 5)
        let originalFrame = title.frame
        screenshot("transcript-header-light")

        let scroll = app.scrollViews["native-transcript"]
        XCTAssertTrue(scroll.exists)
        scroll.swipeDown()
        scroll.swipeDown()
        XCTAssertEqual(title.frame, originalFrame)
        XCTAssertEqual(subtitle.label, "argmax · main")
        XCTAssertTrue(menu.isHittable)
        screenshot("transcript-header-light-scrolled")
    }

    func testActionsMenuOpensTheWorkspaceReviewAndBackReturnsToChat() {
        app.buttons["Chat actions"].tap()
        let changes = app.buttons["Files and changes (3)"]
        XCTAssertTrue(changes.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Fork chat"].exists)
        XCTAssertTrue(app.buttons["New chat here"].exists)
        changes.tap()

        XCTAssertTrue(app.buttons["Changes"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Files"].exists)
        XCTAssertFalse(app.buttons["Chat actions"].exists)
        screenshot("transcript-header-review")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["Chat actions"].waitForExistence(timeout: 5))
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["Open chat"].waitForExistence(timeout: 5))
    }

    func testDarkHeaderAfterScroll() {
        app.terminate()
        launch(["-scenario-dark"])
        XCTAssertEqual(app.staticTexts["transcript-subtitle"].label, "argmax · main")
        screenshot("transcript-header-dark")
        app.scrollViews["native-transcript"].swipeDown()
        screenshot("transcript-header-dark-scrolled")
    }

    func testLargeTypeAndScratchChatKeepActionsAvailable() {
        app.terminate()
        launch(["-scenario-large", "-scenario-scratch"])
        XCTAssertEqual(app.staticTexts["transcript-subtitle"].label, "Chat")
        XCTAssertTrue(app.buttons["Chat actions"].isHittable)
        app.scrollViews["native-transcript"].swipeDown()
        screenshot("transcript-header-large-scratch-scrolled")
        app.buttons["Chat actions"].tap()
        XCTAssertFalse(app.buttons["Files and changes"].exists)
        XCTAssertFalse(app.buttons["Files and changes (3)"].exists)
        XCTAssertTrue(app.buttons["New chat here"].exists)
    }

    private func launch(_ extraArguments: [String] = []) {
        app.launchArguments = ["-argmax-transcript-header-scenario"] + extraArguments
        app.launch()
        XCTAssertTrue(app.staticTexts["transcript-title"].waitForExistence(timeout: 10))
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
