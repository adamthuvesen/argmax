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

    func testLongUserBubbleExpandsAndCollapses() {
        app.terminate()
        app.launchArguments.append("-scenario-user-bubble")
        app.launch()
        let more = app.buttons["Show more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "Show more").count, 1)
        XCTAssertTrue(app.staticTexts["Short prompt"].isHittable)
        XCTAssertEqual(more.value as? String, "Collapsed")
        screenshot("user-bubble-collapsed")
        more.tap()
        let less = app.buttons["Show less"]
        XCTAssertTrue(less.waitForExistence(timeout: 5))
        XCTAssertEqual(less.value as? String, "Expanded")
        let scroll = app.scrollViews["native-transcript"]
        for _ in 0..<6 where !less.isHittable { scroll.swipeUp() }
        XCTAssertTrue(less.isHittable)
        screenshot("user-bubble-expanded")
        less.tap()
        XCTAssertTrue(more.waitForExistence(timeout: 5))
        XCTAssertEqual(more.value as? String, "Collapsed")
        XCTAssertTrue(app.staticTexts["Reply after the prompt"].isHittable)
        app.buttons["Size"].tap()
        XCTAssertTrue(more.exists)
        screenshot("user-bubble-accessibility-type")
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
        XCTAssertEqual(composer.value as? String, "A draft that stays here")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Stream end 1"].isHittable)
        screenshot("keyboard-open")

        let scroll = app.scrollViews["native-transcript"]
        // Drag inside the visible transcript, above the keyboard: a drag that
        // starts on the keyboard's frame is routed to the keyboard window and
        // never reaches the transcript's interactive dismiss. The drag is
        // slow and ends with a hold, so the interactive dismissal tracks the
        // finger for its whole length instead of reading as a fling.
        scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05))
            .press(forDuration: 0.05, thenDragTo: scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)),
                   withVelocity: .slow, thenHoldForDuration: 0.4)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        if app.buttons["Jump to latest"].exists { app.buttons["Jump to latest"].tap() }
        app.buttons["Size"].tap()
        XCTAssertTrue(app.staticTexts["Stream end 1"].isHittable)
        let composerBottom = app.buttons["Stop"].frame.maxY
        let screenBottom = app.windows.firstMatch.frame.maxY
        XCTAssertLessThan(screenBottom - composerBottom, 100)
        screenshot("accessibility-type")
    }

    func testComposerUsesTheStandardEditMenuForTextPaste() {
        let composer = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Paste image"].exists)
        composer.tap()
        composer.typeText("Paste me")

        composer.press(forDuration: 1)
        let selectAll = app.menuItems["Select All"]
        XCTAssertTrue(selectAll.waitForExistence(timeout: 5))
        selectAll.tap()
        let copy = app.menuItems["Copy"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        copy.tap()

        let insertionPoint = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5))
        insertionPoint.tap()
        insertionPoint.press(forDuration: 1)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()

        let duplicated = expectation(
            for: NSPredicate(format: "value == %@", "Paste me Paste me"),
            evaluatedWith: composer
        )
        wait(for: [duplicated], timeout: 5)
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

    func testActivityUsesSemanticColoursAndKeepsIntegrationArtwork() {
        app.terminate()
        app.launchArguments.append("-scenario-activity")
        app.launch()

        let summary = "Read files, edited a file, searched files, viewed an image, loaded tools, activated a skill, ran a command, used a computer, used a tool"
        let summaryButton = app.buttons.matching(NSPredicate(format: "label == %@", summary))
        let collapsed = summaryButton.firstMatch
        XCTAssertTrue(collapsed.waitForExistence(timeout: 10))
        screenshot("activity-colours-collapsed")
        collapsed.tap()

        XCTAssertEqual(summaryButton.count, 1)
        XCTAssertTrue(app.buttons["Edited App.swift, 2 added, 1 removed"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Viewed wireframe.png"].exists)
        screenshot("activity-colours-expanded")

        app.scrollViews["native-transcript"].swipeUp()
        XCTAssertTrue(app.buttons["Used a computer"].waitForExistence(timeout: 5))
        screenshot("activity-computer-use")
        XCTAssertTrue(app.buttons["Used Linear list issues"].waitForExistence(timeout: 5))
        screenshot("activity-integration-artwork")
        app.buttons["Theme"].tap()
        screenshot("activity-colours-dark")
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
