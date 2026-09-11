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
}
