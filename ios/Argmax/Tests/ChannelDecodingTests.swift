import XCTest
@testable import Argmax

/// The two reads the New chat sheet makes, pinned against real payloads.
///
/// `Tests/Fixtures/providers-discover.json` and `projects-list.json` are
/// trimmed captures of `node scripts/bridge.mjs call <channel> '{}'` — see
/// the README for how to take fresh ones. Both carry columns this app never
/// reads (`goalSupport`, `settings`, `counts`), which is half of what they
/// are here to prove.
final class ChannelDecodingTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: name, withExtension: "json"),
            "\(name).json is not in the test bundle"
        )
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    // MARK: - providers:discover

    func testDecodesACapturedProviderReport() throws {
        let providers = try fixture("providers-discover", as: [ProviderCapability].self)
        XCTAssertEqual(providers.map(\.provider), ["claude", "codex", "cursor", "opencode", "grok"])
        let claude = try XCTUnwrap(providers.first)
        XCTAssertEqual(claude.displayName, "Claude Code")
        XCTAssertTrue(claude.installed)
        XCTAssertEqual(claude.authenticated, true)
        XCTAssertTrue(providers.allSatisfy(\.usable))
    }

    /// `authenticated` is tri-state, and only an explicit `false` means the
    /// sheet should say so. An inconclusive probe is not a reason to hide a
    /// provider that works.
    func testAvailabilityIsAdvisoryNotAGate() throws {
        let payload = Data(
            """
            [
              {"provider":"claude","displayName":"Claude Code","installed":true,"authenticated":null,
               "setupGuidance":null},
              {"provider":"codex","displayName":"Codex","installed":true,"authenticated":false,
               "setupGuidance":"Run `codex login`."},
              {"provider":"grok","displayName":"Grok Build","installed":false,"authenticated":null,
               "setupGuidance":null}
            ]
            """.utf8
        )
        let providers = try JSONDecoder().decode([ProviderCapability].self, from: payload)
        XCTAssertTrue(providers[0].usable, "an inconclusive probe still leaves the provider offerable")
        XCTAssertFalse(providers[1].usable)
        XCTAssertEqual(providers[1].setupGuidance, "Run `codex login`.")
        XCTAssertFalse(providers[2].usable)
    }

    // MARK: - projects:list

    func testDecodesACapturedProjectList() throws {
        let projects = try fixture("projects-list", as: [ProjectSummary].self)
        XCTAssertEqual(projects.map(\.name), ["argmax", "dotfiles", "Side chats"])
        let argmax = try XCTUnwrap(projects.first)
        XCTAssertEqual(argmax.currentBranch, "main")
        XCTAssertEqual(argmax.defaultBranch, "main")
        XCTAssertFalse(argmax.repoPath.isEmpty)
    }

    /// The launcher's project picker never offers the hidden singleton every
    /// side chat belongs to, which `projects:list` does return.
    func testTheSideChatsProjectIsInTheListAndNotAChoice() throws {
        let projects = try fixture("projects-list", as: [ProjectSummary].self)
        XCTAssertTrue(projects.contains { $0.id == scratchProjectID })
        let offerable = projects.filter { $0.id != scratchProjectID }
        XCTAssertEqual(offerable.map(\.name), ["argmax", "dotfiles"])
    }

    // MARK: - usage:summary

    /// Shaped after the real `usage:summary` payload (`bindings.d.ts`
    /// `UsageSummary`): hero totals, provider cards, series, models, days —
    /// plus one unknown top-level column, which must decode to nothing.
    func testDecodesAUsageSummary() throws {
        let summary = try fixture("usage-summary", as: UsageSummary.self)
        XCTAssertEqual(summary.window, "30d")
        XCTAssertEqual(summary.sessions, 3106)
        XCTAssertEqual(summary.costUsd, 18196.95, accuracy: 0.001)
        XCTAssertEqual(summary.tokens.cacheRead, 21800000000, accuracy: 1)
        XCTAssertEqual(summary.providers.map(\.provider), ["claude", "codex", "cursor"])
        XCTAssertFalse(summary.providers.last?.available ?? true)
        XCTAssertEqual(summary.series.count, 3)
        XCTAssertEqual(summary.models.map(\.modelId), ["claude-opus-5", "gpt-5.6-sol"])
        XCTAssertEqual(summary.days.count, 2)
        XCTAssertEqual(summary.previous?.sessions, 2890)
        XCTAssertEqual(summary.scanPhase, "idle")
    }

    // MARK: - activity:summary
    /// Shaped after the real `activity:summary` payload: totals, repos,
    /// series, heatmap, streaks, cadence, PRs, reviews — plus one unknown
    /// column, which must decode to nothing.
    func testDecodesAnActivitySummary() throws {
        let summary = try fixture("activity-summary", as: ActivitySummary.self)
        XCTAssertEqual(summary.window, "30d")
        XCTAssertEqual(summary.totals.commits, 1557)
        XCTAssertEqual(summary.totals.prsMerged, 226)
        XCTAssertEqual(summary.repositories.map(\.name), ["argmax", "revops-backoffice"])
        XCTAssertEqual(summary.series.count, 2)
        XCTAssertEqual(summary.heatmap.count, 19)
        XCTAssertEqual(summary.streaks.currentDays, 23)
        XCTAssertEqual(summary.streaks.busiestDay?.commits, 136)
        XCTAssertEqual(summary.cadence.byWeekday.count, 7)
        XCTAssertEqual(summary.cadence.byHour.count, 24)
        XCTAssertEqual(summary.pullRequests.count, 2)
        XCTAssertEqual(summary.pullRequests.first?.cycleSeconds, 1080)
        XCTAssertEqual(summary.reviews.map(\.state), ["approved", "commented"])
        XCTAssertEqual(summary.medianCycleSeconds, 540)
        XCTAssertTrue(summary.github.available)
        XCTAssertEqual(summary.scanPhase, "complete")
    }

    // MARK: - Disk cache round-trips

    /// The Insights disk cache encodes what it decoded. A lossy mirror would
    /// paint last week's numbers as this week's, so the trip there and back
    /// is pinned on the fixtures.
    func testUsageSummaryRoundTripsThroughCache() throws {
        let summary = try fixture("usage-summary", as: UsageSummary.self)
        let again = try JSONDecoder().decode(
            UsageSummary.self, from: JSONEncoder().encode(summary)
        )
        XCTAssertEqual(again.window, "30d")
        XCTAssertEqual(again.costUsd, 18196.95, accuracy: 0.001)
        XCTAssertEqual(again.providers.map(\.provider), ["claude", "codex", "cursor"])
        XCTAssertEqual(again.models.map(\.modelId), ["claude-opus-5", "gpt-5.6-sol"])
        XCTAssertEqual(again.scanPhase, "idle")
    }

    func testActivitySummaryRoundTripsThroughCache() throws {
        let summary = try fixture("activity-summary", as: ActivitySummary.self)
        let again = try JSONDecoder().decode(
            ActivitySummary.self, from: JSONEncoder().encode(summary)
        )
        XCTAssertEqual(again.window, "30d")
        XCTAssertEqual(again.totals.commits, 1557)
        XCTAssertEqual(again.repositories.map(\.name), ["argmax", "revops-backoffice"])
        XCTAssertEqual(again.heatmap.count, 19)
        XCTAssertEqual(again.cadence.byHour.count, 24)
        XCTAssertEqual(again.scanPhase, "complete")
    }
}
