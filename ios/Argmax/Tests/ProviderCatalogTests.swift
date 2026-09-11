import XCTest
@testable import Argmax

/// The bundled model catalogue.
///
/// `Resources/providerModels.json` is written from
/// `src/shared/providerModels.ts` by `npm run export:provider-models`. These
/// tests are the reminder that it has to be re-run: a stale or missing file
/// fails here rather than shipping a phone that offers a model the CLI does
/// not have.
final class ProviderCatalogTests: XCTestCase {
    private let catalog = ProviderCatalog.bundled

    func testTheCatalogueIsBundledAndCoversEveryProvider() {
        XCTAssertEqual(catalog.providers.map(\.id), ["claude", "codex", "cursor", "opencode", "grok"])
        XCTAssertEqual(catalog.launchPriority, catalog.providers.map(\.id))
        XCTAssertTrue(catalog.providers.allSatisfy { !$0.models.isEmpty })
    }

    func testEveryDefaultNamesAModelItsProviderLists() throws {
        for provider in catalog.providers {
            XCTAssertNotNil(
                catalog.model(provider: provider.id, modelId: provider.defaultModel.modelId),
                "\(provider.id)'s default is not in its own list"
            )
            XCTAssertEqual(provider.defaultModel.provider, provider.id)
        }
        let factory = catalog.factoryModel
        XCTAssertNotNil(catalog.model(provider: factory.provider, modelId: factory.modelId))
        XCTAssertNotNil(catalog.model(provider: catalog.fallbackModel.provider, modelId: catalog.fallbackModel.modelId))
    }

    /// The ladders are resolved at export time because they are functions of
    /// the model id in TypeScript. Grok Build's CLI rejects anything above
    /// Extra High, so the phone must not offer Max or Ultra.
    func testEffortLaddersAreThePerModelOnes() throws {
        let grok = try XCTUnwrap(catalog.model(provider: "grok", modelId: "grok-4.6"))
        XCTAssertEqual(grok.reasoningEfforts.map(\.rawValue), ["low", "medium", "high", "xhigh"])

        let opus = try XCTUnwrap(catalog.model(provider: "claude", modelId: "claude-opus-5"))
        XCTAssertEqual(opus.reasoningEfforts.map(\.rawValue), ["low", "medium", "high", "xhigh", "max", "ultra"])

        // A discrete ladder, not a prefix: the OpenCode Go variants expose
        // only the levels their CLI takes.
        let kimi = try XCTUnwrap(catalog.model(provider: "opencode", modelId: "opencode-go/kimi-k3"))
        XCTAssertEqual(kimi.reasoningEfforts.map(\.rawValue), ["max"])
    }

    func testAFastModelHasNoEffortControl() throws {
        let haiku = try XCTUnwrap(catalog.model(provider: "claude", modelId: "claude-haiku-4-5"))
        XCTAssertFalse(haiku.supportsReasoningEffort)
        XCTAssertNil(haiku.defaultEffort)
        XCTAssertNil(catalog.resolveEffort(.high, for: haiku), "there is no rung to carry an effort onto")
    }

    /// Switching model carries the effort down, never up: a Medium selection
    /// moving to a low/high/max ladder becomes Low.
    func testAnEffortClampsDownOntoTheNewModelsLadder() throws {
        let glm = try XCTUnwrap(catalog.model(provider: "opencode", modelId: "opencode-go/glm-5.3"))
        XCTAssertEqual(glm.reasoningEfforts.map(\.rawValue), ["low", "high", "max"])
        XCTAssertEqual(catalog.resolveEffort(.medium, for: glm), .low)
        XCTAssertEqual(catalog.resolveEffort(.high, for: glm), .high)

        let grok = try XCTUnwrap(catalog.model(provider: "grok", modelId: "grok-4.6"))
        XCTAssertEqual(
            catalog.resolveEffort(ReasoningEffort(rawValue: "ultra"), for: grok),
            ReasoningEffort(rawValue: "xhigh"),
            "Ultra clamps to the ceiling the CLI accepts rather than being sent through"
        )
    }

    func testEffortsReadAsWords() {
        XCTAssertEqual(catalog.label(for: ReasoningEffort(rawValue: "xhigh")), "Extra High")
        XCTAssertEqual(catalog.label(for: .medium), "Medium")
        XCTAssertEqual(catalog.label(for: ReasoningEffort(rawValue: "brand-new")), "brand-new")
    }

    /// Mirrors `preferredLaunchProvider`: the highest-priority provider the
    /// Mac can actually run.
    func testThePreferredProviderFollowsTheLaunchPriority() {
        let discovered = [
            ProviderCapability(
                provider: "claude", displayName: "Claude Code", installed: false,
                authenticated: nil, setupGuidance: nil
            ),
            ProviderCapability(
                provider: "codex", displayName: "Codex", installed: true,
                authenticated: false, setupGuidance: nil
            ),
            ProviderCapability(
                provider: "cursor", displayName: "Cursor", installed: true,
                authenticated: nil, setupGuidance: nil
            ),
            ProviderCapability(
                provider: "grok", displayName: "Grok Build", installed: true,
                authenticated: true, setupGuidance: nil
            )
        ]
        XCTAssertEqual(catalog.preferredProvider(among: discovered), "cursor")
        XCTAssertNil(catalog.preferredProvider(among: []))
    }

    /// Cursor cannot fork a resumed conversation, and `fork_session` refuses
    /// it host-side; the row's Fork action reads this.
    func testForkCapabilityMatchesTheHostsGate() {
        XCTAssertEqual(
            catalog.providers.filter(\.forkCapable).map(\.id),
            ["claude", "codex", "opencode", "grok"]
        )
    }

    /// The model picker's trailing column. The exporter has to carry
    /// `contextWindow`, or every row in the sheet loses the one number that
    /// tells two models with the same name apart.
    func testTheCatalogueCarriesContextWindows() throws {
        let opus = try XCTUnwrap(catalog.model(provider: "claude", modelId: "claude-opus-5"))
        XCTAssertEqual(opus.contextWindow, 1_000_000)
        let sonnet = try XCTUnwrap(catalog.model(provider: "claude", modelId: "claude-sonnet-5"))
        XCTAssertEqual(sonnet.contextWindow, 200_000)
        let withWindow = catalog.providers.flatMap(\.models).filter { $0.contextWindow != nil }
        XCTAssertGreaterThan(withWindow.count, 20, "the exporter dropped the field")
    }

    /// "1M", "200K", "272K", and nothing at all where the catalogue is
    /// silent — a blank column, never a "0K".
    func testContextWindowsReadAsTheDesktopsShorthand() {
        XCTAssertEqual(makeModel(contextWindow: 1_000_000).contextWindowLabel, "1M")
        XCTAssertEqual(makeModel(contextWindow: 1_048_576).contextWindowLabel, "1M")
        XCTAssertEqual(makeModel(contextWindow: 1_500_000).contextWindowLabel, "1.5M")
        XCTAssertEqual(makeModel(contextWindow: 272_000).contextWindowLabel, "272K")
        XCTAssertEqual(makeModel(contextWindow: 258_400).contextWindowLabel, "258K")
        XCTAssertEqual(makeModel(contextWindow: 262_144).contextWindowLabel, "262K")
        XCTAssertNil(makeModel(contextWindow: nil).contextWindowLabel)
    }

    /// A bundle written before the exporter grew the field still decodes:
    /// the sheet loses a column, not the catalogue.
    func testAModelWithNoContextWindowStillDecodes() throws {
        let json = Data(#"{"label":"A","modelId":"a","reasoningEfforts":[]}"#.utf8)
        let model = try JSONDecoder().decode(CatalogModel.self, from: json)
        XCTAssertNil(model.contextWindow)
        XCTAssertNil(model.contextWindowLabel)
    }

    private func makeModel(contextWindow: Int?) -> CatalogModel {
        CatalogModel(label: "A", modelId: "a", reasoningEfforts: [], contextWindow: contextWindow)
    }

    /// A title is a handful of tokens, so it rides a cheap model rather than
    /// the chat's own.
    func testEveryProviderNamesATitleModel() {
        for provider in catalog.providers {
            XCTAssertFalse(provider.titleModelId.isEmpty)
        }
        XCTAssertEqual(catalog.provider("claude")?.titleModelId, "claude-sonnet-5")
    }
}
