import XCTest

@MainActor
final class TranscriptUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-argmax-transcript-scenario", "-argmax-unpaired"]
        app.launch()
        XCTAssertTrue(app.scrollViews["native-transcript"].waitForExistence(timeout: 10))
    }

    func testStreamingDetachesPreservesHistoryAndJumpsBack() {
        let scroll = app.scrollViews["native-transcript"]
        app.buttons["Stream"].tap()
        let firstEnd = app.staticTexts["Stream end 1"]
        XCTAssertTrue(firstEnd.waitForExistence(timeout: 5))
        XCTAssertTrue(firstEnd.isHittable)
        XCTAssertFalse(app.buttons["Jump to latest"].exists)

        scroll.swipeDown(velocity: .slow)
        XCTAssertTrue(app.buttons["Jump to latest"].waitForExistence(timeout: 5))
        let anchor = visibleAnswer(in: scroll)
        let label = anchor.label
        let y = anchor.frame.minY
        app.buttons["Stream"].tap()
        assertPosition(label: label, y: y)
        app.buttons["Prepend"].tap()
        assertPosition(label: label, y: y)
        screenshot("detached-after-stream-and-history")

        app.buttons["Jump to latest"].tap()
        let latest = app.staticTexts["Stream end 2"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        XCTAssertTrue(latest.isHittable)
        XCTAssertFalse(app.buttons["Jump to latest"].exists)
        app.buttons["Stream"].tap()
        XCTAssertTrue(app.staticTexts["Stream end 3"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Stream end 3"].isHittable)
        screenshot("following-stream")
    }

    func testKeyboardResizeAndDynamicTypeKeepLatestReachable() {
        app.buttons["Stream"].tap()
        let composer = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("A draft that stays here")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Stream end 1"].isHittable)
        screenshot("keyboard-open")

        let scroll = app.scrollViews["native-transcript"]
        scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
            .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        if app.buttons["Jump to latest"].exists { app.buttons["Jump to latest"].tap() }
        app.buttons["Size"].tap()
        XCTAssertTrue(app.staticTexts["Stream end 1"].isHittable)
        screenshot("accessibility-type")
    }

    func testNativeRichContentInLightAndDarkAndExpanded() {
        app.buttons["Rich"].tap()
        let scroll = app.scrollViews["native-transcript"]
        scroll.swipeDown(velocity: .slow)
        screenshot("rich-light")
        openAndClose("View full equation")
        openAndClose("View full diagram")
        app.buttons["Theme"].tap()
        screenshot("rich-dark")
        app.buttons["Size"].tap()
        screenshot("rich-dark-accessibility")
    }

    func testWideContentKeepsZoomControlsReachable() {
        app.terminate()
        app.launchArguments.append("-scenario-wide")
        app.launch()
        XCTAssertTrue(app.buttons["Rich"].waitForExistence(timeout: 10))
        app.buttons["Rich"].tap()
        openAndClose("View full equation")
        openAndClose("View full diagram")
    }

    private func openAndClose(_ label: String) {
        let button = app.buttons[label]
        for _ in 0..<4 where !button.isHittable {
            app.scrollViews["native-transcript"].swipeDown(velocity: .slow)
        }
        XCTAssertTrue(button.isHittable, label)
        button.tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Zoom in"].isHittable)
        app.buttons["Zoom in"].tap()
        let canvas = app.descendants(matching: .any).matching(identifier: "Rich content canvas").firstMatch
        XCTAssertTrue(canvas.exists, app.debugDescription)
        canvas.pinch(withScale: 1.5, velocity: 1)
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.05, thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.6)))
        XCTAssertTrue(app.buttons["Reset zoom"].isHittable)
        app.buttons["Reset zoom"].tap()
        screenshot(label)
        app.buttons["Done"].tap()
        XCTAssertTrue(app.scrollViews["native-transcript"].waitForExistence(timeout: 5))
    }

    private func visibleAnswer(in scroll: XCUIElement) -> XCUIElement {
        let answers = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Answer "))
        let visible = answers.allElementsBoundByIndex.first {
            $0.isHittable && $0.frame.minY >= scroll.frame.minY + 10
                && $0.frame.maxY < scroll.frame.maxY - 50
        }
        XCTAssertNotNil(visible, "Expected a fully visible answer to track while reading")
        return visible ?? answers.firstMatch
    }

    private func assertPosition(label: String, y: CGFloat) {
        let anchor = app.staticTexts[label]
        XCTAssertTrue(anchor.isHittable)
        XCTAssertEqual(anchor.frame.minY, y, accuracy: 3, "Updating content moved the reading position")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
