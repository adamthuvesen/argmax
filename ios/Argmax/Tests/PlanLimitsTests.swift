import XCTest
@testable import Argmax

/// The Settings plan-limits card: the wire shape, pinned against a real
/// payload, and the two lines a meter carries.
///
/// `Tests/Fixtures/usage-remaining.json` is a capture of
/// `node scripts/bridge.mjs call usage:remaining '{}'` against a Mac signed
/// into all five CLIs.
final class PlanLimitsTests: XCTestCase {
    private func loadFixture() throws -> PlanLimits {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "usage-remaining", withExtension: "json"),
            "usage-remaining.json is not in the test bundle"
        )
        return try JSONDecoder().decode(PlanLimits.self, from: Data(contentsOf: url))
    }

    func testDecodesEveryProviderTheMacReads() throws {
        let limits = try loadFixture()
        XCTAssertEqual(limits.providers.map(\.provider), ["claude", "codex", "cursor", "opencode", "grok"])
    }

    /// The three windows the Claude login reports, Fable's weekly cap among
    /// them — the one the desktop grew a separate row for.
    func testKeepsClaudesWindowsInTheMacsOrder() throws {
        let claude = try XCTUnwrap(loadFixture().providers.first { $0.provider == "claude" })
        XCTAssertEqual(claude.kind, .subscription)
        XCTAssertEqual(claude.planLabel, "Max 20x")
        XCTAssertEqual(claude.windows.map(\.label), ["5-hour", "Weekly Fable", "Weekly"])
        XCTAssertTrue(claude.showsWindows)
    }

    /// A login with no included usage to measure gets its sentence and its
    /// link, never an empty bar that would read as spent.
    func testATeamsLoginCarriesAMessageInsteadOfMeters() throws {
        let cursor = try XCTUnwrap(loadFixture().providers.first { $0.provider == "cursor" })
        XCTAssertEqual(cursor.kind, .enterprise)
        XCTAssertFalse(cursor.showsWindows)
        XCTAssertEqual(cursor.kindLabel, "Teams")
        XCTAssertEqual(cursor.messageUrl, "https://cursor.com/dashboard/spending")
    }

    /// A plan kind added on the Mac must not fail the whole card.
    func testAnUnknownPlanKindSurvives() throws {
        let payload = Data(
            """
            {"fetchedAt":"2026-09-11T10:00:00Z","providers":[{"provider":"claude",
            "kind":"trial","planLabel":null,"windows":[],"message":null,"messageUrl":null}]}
            """.utf8
        )
        let limits = try JSONDecoder().decode(PlanLimits.self, from: payload)
        XCTAssertEqual(limits.providers.first?.kind, .unknown("trial"))
        XCTAssertNil(limits.providers.first?.kindLabel)
    }

    func testRemainingReadsAsTheDesktopWordsIt() {
        XCTAssertEqual(LimitCopy.left(36), "36% left")
        XCTAssertEqual(LimitCopy.left(4.25), "4.3% left")
        XCTAssertEqual(LimitCopy.left(0.04), "<0.1% left")
        XCTAssertEqual(LimitCopy.left(0), "0.0% left")
    }

    func testResetCountsDownThenBecomesADate() {
        let now = try! XCTUnwrap(parseWireTimestamp("2026-09-11T10:00:00.000Z"))
        // Six fractional digits and none at all: both shapes are on the wire.
        XCTAssertEqual(LimitCopy.reset("2026-09-11T10:45:00.554190+00:00", now: now), "resets in 45m")
        XCTAssertEqual(LimitCopy.reset("2026-09-11T13:00:00+00:00", now: now), "resets in 3h")
        XCTAssertEqual(LimitCopy.reset("2026-09-13T10:00:00+00:00", now: now), "resets in 2d")
        XCTAssertEqual(LimitCopy.reset("2026-09-11T09:00:00+00:00", now: now), "resets now")
        XCTAssertNil(LimitCopy.reset(nil, now: now))
        // Past five days the countdown says nothing a date does not.
        XCTAssertEqual(LimitCopy.reset("2026-09-28T12:46:05.845+00:00", now: now)?.hasPrefix("resets Sep 28"), true)
    }
}
