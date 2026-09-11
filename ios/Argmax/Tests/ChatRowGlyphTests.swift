import UIKit
import XCTest
@testable import Argmax

/// The one order the leading column resolves in, and the one thing the
/// "Provider marks" switch reaches.
final class ChatRowGlyphTests: XCTestCase {
    func testRunningShowsTheNestOverAnIconAndOverTheMark() {
        let row = makeRow(working: true, icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .nest(tint: "clay"))
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: false), .nest(tint: "clay"))
    }

    /// No pick, no colour: the nest is the accent, which is what the running
    /// mark is everywhere else in the app.
    func testARunningChatWithNoIconColourTakesTheAccent() {
        XCTAssertEqual(ChatRowGlyph(row: makeRow(working: true), providerMarks: true), .nest(tint: nil))
    }

    func testAnIdleChatShowsItsOwnIcon() {
        let row = makeRow(icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .icon(name: "Flame", tint: "clay"))
    }

    /// The switch hides the provider's mark. A chat's own icon is the
    /// person's pick, not the CLI's badge, so it stays.
    func testTheSwitchHidesTheMarkAndNotTheIcon() {
        let picked = makeRow(icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: picked, providerMarks: false), .icon(name: "Flame", tint: "clay"))

        let unpicked = makeRow()
        XCTAssertEqual(ChatRowGlyph(row: unpicked, providerMarks: true), .providerMark(provider: "claude"))
        // Empty, not absent: the column stays so the titles keep their column.
        XCTAssertEqual(ChatRowGlyph(row: unpicked, providerMarks: false), .empty)
    }

    /// The Mac's picker offers 262 icons and this build maps a subset, so a
    /// name with no SF Symbol has to read as "no icon" rather than as a hole.
    func testAnUnmappedIconNameFallsThroughToTheMark() {
        let row = makeRow(icon: "Squirrel", iconColor: "teal")
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .providerMark(provider: "claude"))
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: false), .empty)
    }

    /// A merged PR beats the bare provider mark — the same precedence the
    /// sidebar's `statusOverlayFor` gives it — but loses to a picked icon and
    /// to a running turn, which both say more about the chat right now.
    func testAMergedPRBeatsTheMarkButLosesToAnIconOrARunningTurn() {
        let row = makeRow(prState: "MERGED", prNumber: 42)
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .prMerged(number: 42))
        // The switch that hides the provider's mark has nothing to say about
        // a PR glyph — it isn't the mark, it's the workspace's own state.
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: false), .prMerged(number: 42))

        let withIcon = makeRow(icon: "Flame", iconColor: "clay", prState: "MERGED")
        XCTAssertEqual(ChatRowGlyph(row: withIcon, providerMarks: true), .icon(name: "Flame", tint: "clay"))

        let running = makeRow(working: true, prState: "MERGED")
        XCTAssertEqual(ChatRowGlyph(row: running, providerMarks: true), .nest(tint: nil))
    }

    func testAnOpenPRBeatsTheMarkTooAndTheTwoStatesDontMix() {
        let row = makeRow(prState: "OPEN", prNumber: 7)
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .prOpen(number: 7))
    }


    /// A closed-and-not-merged PR (or a workspace with none at all) is not a
    /// live signal — the row falls all the way through to the mark.
    func testAClosedPRIsNotShownAsAGlyph() {
        let row = makeRow(prState: "CLOSED")
        XCTAssertEqual(ChatRowGlyph(row: row, providerMarks: true), .providerMark(provider: "claude"))
    }

    /// A symbol name that this OS does not carry draws nothing at all, which
    /// is why the mapping is checked against the runtime and not just
    /// against itself.
    func testEveryMappedSymbolExistsOnThisOS() {
        for (icon, symbol) in SessionIcon.symbols {
            XCTAssertNotNil(UIImage(systemName: symbol), "\(icon) maps to \(symbol), which is not an SF Symbol here")
        }
    }

    /// The palette is the desktop's nine tokens. A tenth added on the Mac
    /// resolves to nil here and the glyph takes the ink or the accent.
    func testThePaletteCoversTheDesktopTokensAndNothingElse() {
        for token in ["green", "teal", "blue", "violet", "plum", "clay", "amber", "pink", "red"] {
            XCTAssertNotNil(SessionIcon.color(for: token), "\(token) is in the desktop palette")
        }
        XCTAssertNil(SessionIcon.color(for: "chartreuse"))
        XCTAssertNil(SessionIcon.color(for: nil))
    }

    func testIconNamesAreSpokenAsWords() {
        XCTAssertEqual(sessionIconLabel("GitBranch"), "Git Branch")
        XCTAssertEqual(sessionIconLabel("Building2"), "Building2")
        XCTAssertEqual(sessionIconLabel("Flame"), "Flame")
    }

    private func makeRow(
        working: Bool = false,
        icon: String? = nil,
        iconColor: String? = nil,
        prState: String? = nil,
        prNumber: Int? = nil
    ) -> ChatRow {
        var workspace = makeWorkspace(id: "w-1", prState: prState, icon: icon, iconColor: iconColor)
        workspace.prNumber = prNumber
        return ChatRow(
            workspace: workspace,
            session: makeSession(id: "s-1", workspaceId: "w-1"),
            projectName: "argmax",
            attention: nil,
            working: working
        )
    }
}
