import Foundation

// The model catalogue, read rather than retyped.
//
// `Resources/providerModels.json` is written from
// `src/shared/providerModels.ts` by `npm run export:provider-models`, which
// project.yml bundles. Half of what a launcher needs there is a function —
// Codex's effort ladder depends on the model id, Grok's stops at Extra High —
// so the ladders are resolved at export time and arrive here as data. A Swift
// copy would be a second source, and its first drift would be the phone
// offering a rung the CLI rejects.
//
// Re-run the exporter after any catalogue change. `ProviderCatalogTests`
// fails when the file is missing, which is the only reminder that works.

/// A reasoning effort, low → high. Open like the wire enums in `Models.swift`:
/// a level added to the catalogue must not blank the phone's model picker.
struct ReasoningEffort: RawRepresentable, Codable, Hashable, Sendable {
    var rawValue: String

    init(rawValue: String) { self.rawValue = rawValue }

    // Written out, because a `RawRepresentable` *struct* gets the memberwise
    // Codable — `{"rawValue":"high"}` — where the enums in `Models.swift` get
    // the transparent one. The catalogue and the wire both carry a bare
    // string.
    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    static let low = ReasoningEffort(rawValue: "low")
    static let medium = ReasoningEffort(rawValue: "medium")
    static let high = ReasoningEffort(rawValue: "high")
}

/// One model in a provider's list, with the effort levels it actually offers.
struct CatalogModel: Codable, Hashable, Sendable, Identifiable {
    var label: String
    var modelId: String
    /// Empty for a fast model — Haiku, Cursor Composer — which has no effort
    /// control at all rather than a one-rung one.
    var reasoningEfforts: [ReasoningEffort]
    var defaultEffort: ReasoningEffort?
    /// Tokens the model can hold, or nil where the catalogue does not say.
    /// Optional rather than defaulted so a bundle written before the
    /// exporter carried the field still decodes — the picker's trailing
    /// column goes blank rather than the whole sheet failing.
    var contextWindow: Int?

    var id: String { modelId }
    var supportsReasoningEffort: Bool { !reasoningEfforts.isEmpty }

    /// "1M", "200K", "272K" — the desktop model menu's own shorthand, and
    /// blank where there is no number. Rounded to whole units: the column
    /// is there to rank models against each other, not to budget a turn.
    var contextWindowLabel: String? {
        guard let contextWindow, contextWindow > 0 else { return nil }
        if contextWindow >= 1_000_000 {
            // To one decimal first: 1_048_576 is a megabyte's worth of
            // tokens and reads as "1M", where 1_500_000 keeps its half.
            let millions = (Double(contextWindow) / 100_000).rounded() / 10
            return millions == millions.rounded()
                ? "\(Int(millions))M"
                : String(format: "%.1fM", millions)
        }
        return "\(Int((Double(contextWindow) / 1000).rounded()))K"
    }
}

/// A model chosen for a launch: what `providers:launch` carries, and nothing
/// of the catalogue metadata around it.
struct ModelSelection: Codable, Hashable, Sendable {
    var provider: String
    var label: String
    var modelId: String
    var reasoningEffort: ReasoningEffort?
}

struct CatalogProvider: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var displayName: String
    /// Whether the CLI can fork a resumed conversation. Cursor cannot, and
    /// `fork_session` refuses it host-side.
    var forkCapable: Bool
    /// The cheap model that mints a chat's name from its prompt.
    var titleModelId: String
    var defaultModel: ModelSelection
    var models: [CatalogModel]
}

/// Names the bundle the app's code lives in. A class only because
/// `Bundle(for:)` takes one.
private final class CatalogBundleMarker {}

struct ProviderCatalog: Codable, Sendable {
    /// Every level the catalogue knows, low → high. The ladder an effort is
    /// clamped down when a model is missing a rung.
    var efforts: [ReasoningEffort]
    var effortLabels: [String: String]
    var defaultEffort: ReasoningEffort
    /// Providers in the order the launcher falls back through: Claude first,
    /// then Codex, Cursor, OpenCode, Grok Build.
    var launchPriority: [String]
    /// The unpersisted pick when nothing else is known.
    var factoryModel: ModelSelection
    /// Last resort when no CLI is installed.
    var fallbackModel: ModelSelection
    var providers: [CatalogProvider]

    /// The bundled catalogue.
    ///
    /// A missing file is a build that skipped the exporter, not a condition
    /// to recover from: every launch path needs a model id, and inventing one
    /// would start a chat on a model the CLI does not have.
    static let bundled: ProviderCatalog = {
        // The bundle this code was compiled into, not `Bundle.main`: under a
        // hosted unit test `main` is the test runner, and the catalogue rides
        // with the app.
        guard let url = Bundle(for: CatalogBundleMarker.self)
            .url(forResource: "providerModels", withExtension: "json")
        else {
            fatalError(
                "providerModels.json is not in the app bundle. Run `npm run export:provider-models` "
                    + "from the repository root, then re-run xcodegen."
            )
        }
        do {
            return try JSONDecoder().decode(ProviderCatalog.self, from: Data(contentsOf: url))
        } catch {
            // Separate from "missing" on purpose: an exporter that grew a
            // field reads as a stale bundle otherwise, which sends the next
            // person to re-run a script that was never the problem.
            fatalError("providerModels.json is bundled but unreadable: \(error)")
        }
    }()

    func provider(_ id: String) -> CatalogProvider? {
        providers.first { $0.id == id }
    }

    func model(provider: String, modelId: String) -> CatalogModel? {
        self.provider(provider)?.models.first { $0.modelId == modelId }
    }

    /// Why a provider's rows in the model picker are dimmed, or nil when the
    /// CLI is usable. Availability is advisory — a dimmed row stays pickable
    /// (`PickerOption.dimmed`'s doc comment) — and shared by `NewChatSheet`
    /// and `TranscriptComposer` so the two pickers never drift on the wording.
    func unavailability(_ provider: String, among discovered: [ProviderCapability]) -> String? {
        guard let capability = discovered.first(where: { $0.provider == provider }), !capability.usable else {
            return nil
        }
        return capability.installed ? "Not signed in" : "Not installed"
    }

    /// "Extra High", not "xhigh". Falls back to the raw level so a catalogue
    /// that grows a rung still reads as something.
    func label(for effort: ReasoningEffort) -> String {
        effortLabels[effort.rawValue] ?? effort.rawValue
    }

    /// The highest-priority provider whose CLI is installed and not known to
    /// be logged out, mirroring `preferredLaunchProvider` in the renderer.
    /// Nil when the host reports none — the sheet then says so rather than
    /// offering a launch that cannot start.
    func preferredProvider(among discovered: [ProviderCapability]) -> String? {
        let usable = Set(discovered.filter(\.usable).map(\.provider))
        return launchPriority.first { usable.contains($0) }
    }

    /// Carry an effort onto a model that may not offer it, the way
    /// `clampEffort` does: keep it when supported, else the highest supported
    /// level below it, else the model's lowest. Never promotes.
    func resolveEffort(_ effort: ReasoningEffort?, for model: CatalogModel) -> ReasoningEffort? {
        guard !model.reasoningEfforts.isEmpty else { return nil }
        guard let effort else { return model.defaultEffort }
        if model.reasoningEfforts.contains(effort) { return effort }
        guard let incoming = efforts.firstIndex(of: effort) else { return model.defaultEffort }
        let below = model.reasoningEfforts.filter { (efforts.firstIndex(of: $0) ?? 0) < incoming }
        return below.last ?? model.reasoningEfforts.first
    }
}
