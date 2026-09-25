import Foundation

/// The client half of `dashboard:changes` (src-tauri/src/remote/dashboard_changes.rs).
///
/// A `dashboardChanged` hint names nothing, so every one used to cost the
/// whole ~700 KB `dashboard:list`. A host that advertises `dashboardChanges`
/// answers with only what differs from the last snapshot this phone merged,
/// named by its digest, or with the full snapshot when it no longer holds
/// that one. Merging here, below the shared read, hands every caller the same
/// full snapshot bytes `dashboard:list` would have.
enum DashboardChanges {
    struct Snapshot {
        let digest: String
        let value: [String: Any]
        /// The host sent the whole snapshot rather than a diff.
        var arrivedWhole = false
    }

    struct Input: Encodable, Sendable {
        let baseDigest: String?
    }

    /// Apply one answer to `base`. Throws when the answer is not a full
    /// snapshot and does not apply to exactly `base`; the caller then asks
    /// again without one rather than guess.
    static func merge(_ reply: Data, into base: Snapshot?) throws -> Snapshot {
        guard let answer = try JSONSerialization.jsonObject(with: reply) as? [String: Any],
              let digest = answer["digest"] as? String
        else { throw BridgeError.malformedResponse }
        if let snapshot = answer["snapshot"] as? [String: Any] {
            return Snapshot(digest: digest, value: snapshot, arrivedWhole: true)
        }
        guard let base, answer["base"] as? String == base.digest,
              let collections = answer["collections"] as? [String: Any],
              let replace = answer["replace"] as? [String: Any],
              let removed = answer["remove"] as? [String]
        else { throw BridgeError.malformedResponse }
        var next = base.value
        for key in removed { next[key] = nil }
        next.merge(replace) { _, new in new }
        for (key, changes) in collections {
            guard let changes = changes as? [String: Any],
                  let rows = next[key] as? [[String: Any]],
                  let upsert = changes["upsert"] as? [[String: Any]],
                  let gone = changes["remove"] as? [String]
            else { throw BridgeError.malformedResponse }
            next[key] = try merge(rows: rows, upsert: upsert, remove: Set(gone), order: changes["order"] as? [String])
        }
        return Snapshot(digest: digest, value: next)
    }

    private static func merge(
        rows: [[String: Any]], upsert: [[String: Any]], remove: Set<String>, order explicit: [String]?
    ) throws -> [[String: Any]] {
        var byID: [String: [String: Any]] = [:]
        var order: [String] = []
        for row in rows {
            guard let id = row["id"] as? String else { throw BridgeError.malformedResponse }
            byID[id] = row
            if !remove.contains(id) { order.append(id) }
        }
        for row in upsert {
            guard let id = row["id"] as? String else { throw BridgeError.malformedResponse }
            byID[id] = row
        }
        // A new row has no place among the old ones, so the host always
        // sends the order with one.
        if let explicit { order = explicit }
        let placed = Set(order)
        guard order.count == placed.count, upsert.allSatisfy({ placed.contains($0["id"] as? String ?? "") })
        else { throw BridgeError.malformedResponse }
        return try order.map { id in
            guard let row = byID[id] else { throw BridgeError.malformedResponse }
            return row
        }
    }
}
