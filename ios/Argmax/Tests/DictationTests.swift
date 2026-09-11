import XCTest
@testable import Argmax

/// How a dictated phrase joins the draft. The recognizer's own behaviour needs
/// a microphone and two grants a test process has neither of, so what is
/// pinned here is the part that decides what the person ends up sending.
final class DictationTests: XCTestCase {
    func testDictationJoinsTheDraftItStartedFrom() {
        XCTAssertEqual(draftWithDictation("", heard: "ship the fix"), "ship the fix")
        XCTAssertEqual(
            draftWithDictation("Look at the diff,", heard: "then ship it"),
            "Look at the diff, then ship it"
        )
        // A draft that already ends in a space keeps its own spacing.
        XCTAssertEqual(draftWithDictation("Look again ", heard: "please"), "Look again please")
        XCTAssertEqual(draftWithDictation("On a new line\n", heard: "do this"), "On a new line\ndo this")
    }

    /// Partial results arrive one after another for the same phrase, so each
    /// one has to rewrite the same tail rather than stack on the last.
    func testPartialResultsRewriteTheSameTail() {
        let draft = "Also"
        XCTAssertEqual(draftWithDictation(draft, heard: "update"), "Also update")
        XCTAssertEqual(draftWithDictation(draft, heard: "update the"), "Also update the")
        XCTAssertEqual(draftWithDictation(draft, heard: "update the changelog"), "Also update the changelog")
    }

    /// Silence leaves the draft exactly as it was — no stray space to delete
    /// before typing the prompt by hand.
    func testSilenceLeavesTheDraftAlone() {
        XCTAssertEqual(draftWithDictation("Look at the diff", heard: ""), "Look at the diff")
        XCTAssertEqual(draftWithDictation("Look at the diff", heard: "   \n "), "Look at the diff")
        XCTAssertEqual(draftWithDictation("", heard: " "), "")
    }
}
