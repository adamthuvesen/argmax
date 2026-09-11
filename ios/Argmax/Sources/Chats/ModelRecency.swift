import Foundation

/// Recently picked models, most recent first — the phone's mirror of
/// `recencyList.ts` plus `launchModelPreference.ts`'s recency key, so the
/// model picker's "Recent" header matches the desktop composer's. Keys are
/// `provider/modelId`, the same encoding `PickerOption<String>.value` already
/// uses for a model row.
enum ModelRecency {
    private static let key = "argmax.launch.modelRecency"
    private static let cap = 32
    /// The picker's own cap: three recent rows before the catalogue starts.
    static let maxShown = 3

    static func read() -> [String] {
        (UserDefaults.standard.array(forKey: key) as? [String]) ?? []
    }

    static func touch(_ id: String) {
        guard !id.isEmpty else { return }
        var next = read().filter { $0 != id }
        next.insert(id, at: 0)
        if next.count > cap { next.removeLast(next.count - cap) }
        UserDefaults.standard.set(next, forKey: key)
    }

    /// Recent picks duplicated under one "Recent" header ahead of the
    /// catalogue, the composer's own `orderOptionsByRecency` in Swift form.
    /// Catalogue rows are untouched — a recent model still shows up under
    /// its own CLI too, which is the point: it hasn't left that group, it's
    /// just also above the fold.
    static func prefixed(_ options: [PickerOption<String>]) -> [PickerOption<String>] {
        let byValue = Dictionary(options.map { ($0.value, $0) }, uniquingKeysWith: { first, _ in first })
        var seen = Set<String>()
        let recentRows = read()
            .filter { byValue[$0] != nil && seen.insert($0).inserted }
            .prefix(maxShown)
            .compactMap { byValue[$0] }
            .map { option -> PickerOption<String> in
                var row = option
                row.group = "Recent"
                row.groupGlyph = nil
                row.groupDetail = nil
                return row
            }
        guard !recentRows.isEmpty else { return options }
        return recentRows + options
    }
}
