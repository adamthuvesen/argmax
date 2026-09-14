import XCTest

@MainActor
final class NativePerformanceUITests: XCTestCase {
    func testLaunchToResponsiveTranscript() {
        let app = XCUIApplication()
        app.launchArguments = ["-argmax-transcript-scenario", "-argmax-unpaired"]
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)], options: options) {
            app.launch()
            XCTAssertTrue(app.scrollViews["native-transcript"].waitForExistence(timeout: 10))
            app.terminate()
        }
    }

    func testTranscriptScrollHitchesAndMemory() {
        let app = XCUIApplication()
        app.launchArguments = ["-argmax-transcript-scenario", "-argmax-unpaired"]
        app.launch()
        let scroll = app.scrollViews["native-transcript"]
        XCTAssertTrue(scroll.waitForExistence(timeout: 10))
        let options = XCTMeasureOptions()
        options.iterationCount = 3
        measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric, XCTMemoryMetric(application: app)], options: options) {
            scroll.swipeDown()
            scroll.swipeUp()
        }
        app.terminate()
    }
}
