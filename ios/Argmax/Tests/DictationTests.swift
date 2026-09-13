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
    /// one has to rewrite the same tail rather than stack on the last. The
    /// field is read as it stands and the tail the last update wrote is the
    /// only part of it that moves.
    func testPartialResultsRewriteTheSameTail() {
        var field = "Also"
        var tail = ""
        for heard in ["update", "update the", "update the changelog"] {
            field = draftWithDictation(field, heard: heard, replacing: tail)
            tail = heard
        }
        XCTAssertEqual(field, "Also update the changelog")
    }

    /// A phrase the recognizer shortens on second thought takes back only its
    /// own words.
    func testARevisedPhraseGivesBackTheWordsItRetracted() {
        let field = draftWithDictation("Also update the changelog", heard: "update", replacing: "update the changelog")
        XCTAssertEqual(field, "Also update")
    }

    /// Typing while the mic is open used to be wiped by the next partial
    /// result, which rebuilt the field from a snapshot taken when the mic
    /// opened. Only the dictated tail is rewritten now.
    func testTypingWhileDictatingSurvivesTheNextPartial() {
        var field = draftWithDictation("Also", heard: "update the", replacing: "")
        XCTAssertEqual(field, "Also update the")
        // The person types a word of their own in front of the dictated tail.
        field = "Also please update the"
        field = draftWithDictation(field, heard: "update the changelog", replacing: "update the")
        XCTAssertEqual(field, "Also please update the changelog")
    }

    /// A tail that is no longer at the end of the field — edited, or sent —
    /// is left where it is and the new phrase appends after it.
    func testAnEditedTailIsLeftAloneRatherThanGuessedAt() {
        XCTAssertEqual(
            draftWithDictation("Ship the fix today", heard: "and tell me", replacing: "ship the diff"),
            "Ship the fix today and tell me"
        )
        XCTAssertEqual(draftWithDictation("", heard: "start over", replacing: "old phrase"), "start over")
    }

    /// Opening the mic publishes an empty transcript before anything is heard.
    /// With no tail yet recorded, that must leave the field untouched.
    func testOpeningTheMicLeavesTheFieldAsItIs() {
        XCTAssertEqual(draftWithDictation("Half a prompt", heard: "", replacing: ""), "Half a prompt")
    }

    /// Silence leaves the draft exactly as it was — no stray space to delete
    /// before typing the prompt by hand.
    func testSilenceLeavesTheDraftAlone() {
        XCTAssertEqual(draftWithDictation("Look at the diff", heard: ""), "Look at the diff")
        XCTAssertEqual(draftWithDictation("Look at the diff", heard: "   \n "), "Look at the diff")
        XCTAssertEqual(draftWithDictation("", heard: " "), "")
    }
}
