import XCTest
@testable import Argmax

/// A code card's header has one line, and what it spends it on comes from the
/// fence. A citation that stops resolving to a file name is how the header
/// goes back to wrapping a whole path across the card.
final class TranscriptCodeFenceTests: XCTestCase {
    func testACitationNamesTheFileAndKeepsThePathToOpen() {
        let fence = TranscriptCodeFence.parse("1375:1378:src/renderer/styles/overlays-review-files.css")

        XCTAssertEqual(fence.title, "overlays-review-files.css")
        XCTAssertEqual(fence.path, "src/renderer/styles/overlays-review-files.css")
        XCTAssertEqual(fence.range, "1375–1378")
        XCTAssertEqual(fence.spokenLabel, "src/renderer/styles/overlays-review-files.css, lines 1375 to 1378")
    }

    /// One cited line reads as a number, not as a range against itself.
    func testASingleCitedLineDropsTheRange() {
        let fence = TranscriptCodeFence.parse("42:42:App.swift")

        XCTAssertEqual(fence.range, "42")
        XCTAssertEqual(fence.spokenLabel, "App.swift, line 42")
    }

    /// A language tag is the label, and there is no file behind it to tap.
    func testALanguageTagStaysTheLabel() {
        let fence = TranscriptCodeFence.parse("swift")

        XCTAssertEqual(fence.title, "swift")
        XCTAssertNil(fence.path)
        XCTAssertNil(fence.range)
    }

    func testAnEmptyFenceFallsBackToCode() {
        XCTAssertEqual(TranscriptCodeFence.parse(nil).title, "Code")
        XCTAssertEqual(TranscriptCodeFence.parse("").title, "Code")
    }

    /// Anything colon-shaped that is not a citation is shown as written rather
    /// than mangled into a file name: a Windows path, a tag that happens to
    /// carry colons, a range with no numbers.
    func testColonsAloneDoNotMakeACitation() {
        for info in ["c:\\tmp\\main.swift", "ts:1:2", "1:2", "1:2:", "12:4:App.swift"] {
            let fence = TranscriptCodeFence.parse(info)
            XCTAssertEqual(fence.title, info, "\(info) should be shown as written")
            XCTAssertNil(fence.path, "\(info) has no file to open")
        }
    }
}
