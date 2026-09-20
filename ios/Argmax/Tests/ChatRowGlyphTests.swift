import UIKit
import XCTest
@testable import Argmax

/// The one order the leading column resolves in, and how far each of the two
/// switches over it — "Chat icons" and "Provider marks" — reaches.
final class ChatRowGlyphTests: XCTestCase {
    func testRunningShowsTheNestOverAnIconAndOverTheMark() {
        let row = makeRow(working: true, icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .nest(tint: "clay"))
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: false, providerMarks: true), .nest(tint: "clay"))
    }

    /// No pick, no colour: the nest is the accent, which is what the running
    /// mark is everywhere else in the app.
    func testARunningChatWithNoIconColourTakesTheAccent() {
        XCTAssertEqual(ChatRowGlyph(row: makeRow(working: true), chatIcons: true, providerMarks: true), .nest(tint: nil))
    }

    func testAnIdleChatShowsItsOwnIcon() {
        let row = makeRow(icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .icon(name: "Flame", tint: "clay"))
    }

    /// Off, "Chat icons" takes the whole column below the nest: a picked icon
    /// goes with the CLI's badge, because "no icons" is the ask and a
    /// running turn is the one thing left worth a glyph.
    func testChatIconsOffHidesEveryGlyphButTheNest() {
        let picked = makeRow(icon: "Flame", iconColor: "clay")
        XCTAssertEqual(ChatRowGlyph(row: picked, chatIcons: false, providerMarks: true), .empty)

        let unpicked = makeRow()
        XCTAssertEqual(ChatRowGlyph(row: unpicked, chatIcons: true, providerMarks: true), .providerMark(provider: "claude"))
        // Empty, not absent: the column stays so the titles keep their column.
        XCTAssertEqual(ChatRowGlyph(row: unpicked, chatIcons: false, providerMarks: true), .empty)
    }

    /// The narrower switch reaches the bare mark and nothing above it: a
    /// picked icon and a PR are the chat's own state, not the CLI's badge.
    func testProviderMarksOffHidesTheMarkAlone() {
        let unpicked = makeRow()
        XCTAssertEqual(ChatRowGlyph(row: unpicked, chatIcons: true, providerMarks: false), .empty)

        let picked = makeRow(icon: "Flame", iconColor: "clay")
        XCTAssertEqual(
            ChatRowGlyph(row: picked, chatIcons: true, providerMarks: false),
            .icon(name: "Flame", tint: "clay")
        )

        let merged = makeRow(prState: "MERGED", prNumber: 42)
        XCTAssertEqual(ChatRowGlyph(row: merged, chatIcons: true, providerMarks: false), .prMerged(number: 42))

        let running = makeRow(working: true)
        XCTAssertEqual(ChatRowGlyph(row: running, chatIcons: true, providerMarks: false), .nest(tint: nil))
    }

    /// The Mac's picker offers 262 icons and this build maps a subset, so a
    /// name with no SF Symbol has to read as "no icon" rather than as a hole.
    func testAnUnmappedIconNameFallsThroughToTheMark() {
        let row = makeRow(icon: "Squirrel", iconColor: "teal")
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .providerMark(provider: "claude"))
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: false, providerMarks: true), .empty)
    }

    /// A merged PR beats the bare provider mark — the same precedence the
    /// sidebar's `statusOverlayFor` gives it — but loses to a picked icon and
    /// to a running turn, which both say more about the chat right now.
    func testAMergedPRBeatsTheMarkButLosesToAnIconOrARunningTurn() {
        let row = makeRow(prState: "MERGED", prNumber: 42)
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .prMerged(number: 42))
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: false, providerMarks: true), .empty)

        let withIcon = makeRow(icon: "Flame", iconColor: "clay", prState: "MERGED")
        XCTAssertEqual(ChatRowGlyph(row: withIcon, chatIcons: true, providerMarks: true), .icon(name: "Flame", tint: "clay"))

        let running = makeRow(working: true, prState: "MERGED")
        XCTAssertEqual(ChatRowGlyph(row: running, chatIcons: true, providerMarks: true), .nest(tint: nil))
    }

    func testAnOpenPRBeatsTheMarkTooAndTheTwoStatesDontMix() {
        let row = makeRow(prState: "OPEN", prNumber: 7)
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .prOpen(number: 7))
    }

    func testTheComposerPillShowsOnlyAnOpenOrMergedNumberedPR() {
        var open = makeWorkspace(id: "open", prState: "OPEN")
        open.prNumber = 7
        var merged = makeWorkspace(id: "merged", prState: "MERGED")
        merged.prNumber = 42
        XCTAssertEqual(
            ChatPullRequest(workspace: open),
            .open(number: 7)
        )
        XCTAssertEqual(
            ChatPullRequest(workspace: merged),
            .merged(number: 42)
        )
        XCTAssertNil(ChatPullRequest(workspace: makeWorkspace(id: "closed", prState: "CLOSED")))
        var unresolved = makeWorkspace(id: "unresolved", prState: "OPEN")
        unresolved.prNumber = nil
        XCTAssertNil(ChatPullRequest(workspace: unresolved))
    }


    /// A closed-and-not-merged PR (or a workspace with none at all) is not a
    /// live signal — the row falls all the way through to the mark.
    func testAClosedPRIsNotShownAsAGlyph() {
        let row = makeRow(prState: "CLOSED")
        XCTAssertEqual(ChatRowGlyph(row: row, chatIcons: true, providerMarks: true), .providerMark(provider: "claude"))
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

    func testWorkingNestHaloMetricsOnPixelGrid() {
        // Size 24: used for page and section loading
        let m24 = WorkingNest.metrics(for: 24)
        XCTAssertEqual(m24.ringInset, 3)
        XCTAssertEqual(m24.coreInset, 8)
        XCTAssertEqual(m24.baseRingDiameter, 18)
        XCTAssertEqual(m24.coreDiameter, 8)

        // Size 18: used for agent cards and multitask rows
        let m18 = WorkingNest.metrics(for: 18)
        XCTAssertEqual(m18.ringInset, 2)
        XCTAssertEqual(m18.coreInset, 6)
        XCTAssertEqual(m18.baseRingDiameter, 14)
        XCTAssertEqual(m18.coreDiameter, 6)

        // Size 14: used for arc rows and status marks
        let m14 = WorkingNest.metrics(for: 14)
        XCTAssertEqual(m14.ringInset, 2)
        XCTAssertEqual(m14.coreInset, 5)
        XCTAssertEqual(m14.baseRingDiameter, 10)
        XCTAssertEqual(m14.coreDiameter, 4)

        // Size 12: used for chat row glyphs and turn tool rows
        let m12 = WorkingNest.metrics(for: 12)
        XCTAssertEqual(m12.ringInset, 1)
        XCTAssertEqual(m12.coreInset, 4)
        XCTAssertEqual(m12.baseRingDiameter, 10)
        XCTAssertEqual(m12.coreDiameter, 4)
    }

    func testWorkingNestHaloRingDynamics() {
        // Cycle is 2.6s
        XCTAssertEqual(WorkingNest.cycle, 2.6)

        // At phase 0 (and full cycles): ring at resting scale (0.8) and low opacity (0.35)
        let rest = WorkingNest.ringDynamics(elapsed: 0, active: true, reduceMotion: false)
        XCTAssertEqual(rest.scale, 0.8, accuracy: 0.001)
        XCTAssertEqual(rest.opacity, 0.35, accuracy: 0.001)

        // At half cycle (1.3s): ring breathes to full scale (1.0) and high opacity (0.9)
        let peak = WorkingNest.ringDynamics(elapsed: 1.3, active: true, reduceMotion: false)
        XCTAssertEqual(peak.scale, 1.0, accuracy: 0.001)
        XCTAssertEqual(peak.opacity, 0.9, accuracy: 0.001)

        // When inactive (settled mark): stays steady at (1.0, 0.9)
        let inactive = WorkingNest.ringDynamics(elapsed: 0.5, active: false, reduceMotion: false)
        XCTAssertEqual(inactive.scale, 1.0)
        XCTAssertEqual(inactive.opacity, 0.9)

        // When reduceMotion: no animation, steady at (1.0, 0.9) for active
        let reduced = WorkingNest.ringDynamics(elapsed: 0.5, active: true, reduceMotion: true)
        XCTAssertEqual(reduced.scale, 1.0)
        XCTAssertEqual(reduced.opacity, 0.9)
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
