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

    func testLoadingAnimationRevealsCompleteChat() {
        app.terminate()
        app.launchArguments.append("-scenario-loading")
        app.launch()
        let loading = app.activityIndicators["transcript-loading"]
        XCTAssertTrue(loading.waitForExistence(timeout: 5))
        XCTAssertEqual(loading.label, "Loading chat…")
        XCTAssertFalse(app.staticTexts["The complete chat is ready."].exists)
        screenshot("chat-loading")
        app.buttons["Stream"].tap()
        XCTAssertTrue(app.staticTexts["The complete chat is ready."].waitForExistence(timeout: 5))
        XCTAssertFalse(loading.exists)
        screenshot("chat-loaded")
    }

    func testLongMessageCopyMenuUsesCompactPreviewAndCopiesFullText() {
        app.terminate()
        app.launchArguments.append("-scenario-copy-preview")
        app.launch()
        let ending = app.staticTexts["Copy test ending"]
        XCTAssertTrue(ending.waitForExistence(timeout: 10))
        ending.press(forDuration: 1)
        let copy = app.buttons["Copy message"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        screenshot("long-message-copy-preview")
        copy.tap()
        let composer = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        composer.tap()
        composer.press(forDuration: 1)
        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        let pasted = composer.value as? String ?? ""
        XCTAssertTrue(pasted.hasPrefix("Long answer to copy"))
        XCTAssertTrue(pasted.hasSuffix("## Copy test ending"))
        XCTAssertTrue(pasted.contains("| Read | Write |"))
    }

    func testAgentSheetCopyMenuKeepsTheSheetOnScreen() {
        app.terminate()
        // Dark, because the light platter is covered by the transcript's own
        // long-message test and this is the surface the fade reads worst on.
        app.launchArguments += ["-scenario-agent-sheet", "-scenario-dark"]
        app.launch()
        let row = app.buttons["Open agent: Shannon, Completed"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        let answer = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Confirmed: no diffs")
        ).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10))
        let sheet = app.scrollViews.element(boundBy: app.scrollViews.count - 1)
        sheet.swipeUp()
        sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1)
        let copy = app.buttons["Copy message"]
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        screenshot("agent-sheet-copy-menu")
        let source = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "**"))
        XCTAssertEqual(source.count, 0, "The menu preview shows Markdown source, not the message")
        copy.tap()
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
    }

    func testLongUserBubbleExpandsAndCollapses() {
        app.terminate()
        app.launchArguments.append("-scenario-user-bubble")
        app.launch()
        let more = app.buttons["Show more"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(identifier: "Show more").count, 1)
        XCTAssertTrue(more.isHittable)
        XCTAssertEqual(more.value as? String, "Collapsed")
        // Collapsed means the bubble is capped, so measure the cap. Asserting
        // that an earlier message had been pushed off-view tested the
        // simulator's height instead: on a tall phone the capped bubble and
        // its reply no longer fill the screen, and "Short prompt" stays in
        // view with nothing wrong.
        let bubble = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "A long pasted prompt"))
            .firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 5))
        let collapsedHeight = bubble.frame.height
        screenshot("user-bubble-collapsed")
        more.tap()
        let less = app.buttons["Show less"]
        XCTAssertTrue(less.waitForExistence(timeout: 5))
        XCTAssertEqual(less.value as? String, "Expanded")
        XCTAssertGreaterThan(bubble.frame.height, collapsedHeight)
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
        // Scrolling toward older messages dismisses the keyboard immediately;
        // interactive dismissal could strand the composer at a partial inset.
        let scrollFrame = scroll.frame
        let keyboardTop = app.keyboards.firstMatch.frame.minY
        let endY = min(scrollFrame.height - 20, keyboardTop - scrollFrame.minY - 40)
        let start = scroll.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: scrollFrame.width / 2, dy: max(20, endY - 180)))
        let end = scroll.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: scrollFrame.width / 2, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end,
                   withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        let composerBottomAfterDismissal = app.buttons["Stop"].frame.maxY
        let screenBottomAfterDismissal = app.windows.firstMatch.frame.maxY
        XCTAssertLessThan(screenBottomAfterDismissal - composerBottomAfterDismissal, 100)
        if app.buttons["Jump to latest"].exists { app.buttons["Jump to latest"].tap() }
        app.buttons["Size"].tap()
        XCTAssertTrue(app.staticTexts["Stream end 1"].isHittable)
        let composerBottom = app.buttons["Stop"].frame.maxY
        let screenBottom = app.windows.firstMatch.frame.maxY
        XCTAssertLessThan(screenBottom - composerBottom, 100)
        screenshot("accessibility-type")
    }

    func testQuestionOtherAnswerStaysAboveKeyboard() {
        app.terminate()
        app.launchArguments.append("-scenario-ask")
        app.launch()

        let other = app.buttons["Other"]
        XCTAssertTrue(other.waitForExistence(timeout: 10))
        other.tap()

        let answer = app.textFields["Your own answer"]
        XCTAssertTrue(answer.waitForExistence(timeout: 5))
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        answer.typeText("Keep this visible")

        let question = app.otherElements["Question from agent"]
        let send = question.buttons["Send"]
        let keyboardTop = app.keyboards.firstMatch.frame.minY
        XCTAssertLessThan(answer.frame.maxY, keyboardTop)
        XCTAssertLessThan(send.frame.maxY, keyboardTop)
        XCTAssertTrue(answer.isHittable)
        XCTAssertTrue(send.isHittable)
        screenshot("question-other-keyboard-open")
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

    func testStrandedKeyboardInsetClearsOnReturn() {
        app.terminate()
        app.launchArguments.append("-scenario-stranded-keyboard")
        app.launch()
        let composer = app.descendants(matching: .any).matching(identifier: "Message").firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        let screenBottom = app.windows.firstMatch.frame.maxY
        XCTAssertGreaterThan(screenBottom - composer.frame.maxY, 300, "The scenario strands the composer at a keyboard top")
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.scrollViews["native-transcript"].waitForExistence(timeout: 5))
        let returned = NSPredicate { _, _ in screenBottom - composer.frame.maxY < 150 }
        wait(for: [XCTNSPredicateExpectation(predicate: returned, object: nil)], timeout: 5)
        screenshot("stranded-keyboard-cleared")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
