import Foundation

// Port of `mergeDashboardDelta` in src/renderer/lib/snapshot.ts, narrowed to
// the three slices the phone keeps. The renderer's event, raw-output,
// approval, check and pending-message merges have no native reader yet — the
// transcript is still a web view — so they are deliberately absent rather
// than half-ported.
//
// Two differences from the TypeScript, both forced by value semantics:
//
//   * The renderer returns the *same array reference* when nothing changed,
//     which is how React skips a render. Swift arrays are values, so the
//     equivalent is `==`; `DashboardStore` compares before publishing.
//   * `upsertById` there detects change by object identity, which is always
//     true for freshly parsed JSON. Here it is value equality, so a delta
//     that re-sends an identical row does not trigger a re-sort. Same
//     observable result, less work.

/// Apply one `dashboard:delta` to a snapshot.
func mergeDashboardDelta(_ incoming: DashboardSnapshot, _ delta: DashboardDelta) -> DashboardSnapshot {
    var snapshot = incoming

    // Removals first: the sync pruner deletes imported sessions in the
    // background, and the rest of the delta protocol has no way to say "gone".
    let removedSessions = Set(delta.removedSessionIds ?? [])
    let removedWorkspaces = Set(delta.removedWorkspaceIds ?? [])
    if !removedSessions.isEmpty || !removedWorkspaces.isEmpty {
        snapshot.workspaces = snapshot.workspaces.filter { !removedWorkspaces.contains($0.id) }
        snapshot.sessions = snapshot.sessions.filter {
            !removedSessions.contains($0.id) && !removedWorkspaces.contains($0.workspaceId)
        }
    }

    if let projects = delta.projects {
        let merged = upsertById(snapshot.projects, projects)
        if merged != snapshot.projects {
            // Projects sort on their own field, and a null last activity
            // sorts last — `latestActivityAt ?? ""` in the renderer.
            snapshot.projects = sortedNewestFirst(merged) { $0.latestActivityAt ?? "" }
        }
    }
    snapshot.workspaces = mergeSlice(snapshot.workspaces, delta.workspaces) { $0.lastActivityAt }
    snapshot.sessions = mergeSlice(snapshot.sessions, delta.sessions) { $0.lastActivityAt }
    return snapshot
}

/// Upsert then re-sort, but only when the upsert actually changed something —
/// an unchanged slice keeps whatever order the host sent it in.
private func mergeSlice<T: Identifiable & Equatable>(
    _ current: [T],
    _ updates: [T]?,
    timestamp: (T) -> String
) -> [T] where T.ID == String {
    guard let updates else { return current }
    let merged = upsertById(current, updates)
    guard merged != current else { return current }
    return sortedNewestFirst(merged, timestamp: timestamp)
}

/// Replace rows that share an id, append the rest, keep the existing order.
private func upsertById<T: Identifiable & Equatable>(_ current: [T], _ updates: [T]) -> [T]
where T.ID == String {
    guard !updates.isEmpty else { return current }
    var indexByID: [String: Int] = [:]
    indexByID.reserveCapacity(current.count)
    for (index, item) in current.enumerated() { indexByID[item.id] = index }

    var merged = current
    var changed = false
    for item in updates {
        if let index = indexByID[item.id] {
            if merged[index] != item {
                merged[index] = item
                changed = true
            }
        } else {
            indexByID[item.id] = merged.count
            merged.append(item)
            changed = true
        }
    }
    return changed ? merged : current
}

/// Newest first, ties broken by the order the rows already had.
///
/// `Array.sort` in JavaScript is stable and `Swift.sort` is not, and rows
/// minted in the same millisecond are common — an unstable sort would let two
/// chats swap places on every unrelated delta. Hence the index decoration.
func sortedNewestFirst<T>(_ items: [T], timestamp: (T) -> String) -> [T] {
    items.enumerated()
        .sorted { left, right in
            let leftStamp = timestamp(left.element)
            let rightStamp = timestamp(right.element)
            if leftStamp != rightStamp { return leftStamp > rightStamp }
            return left.offset < right.offset
        }
        .map(\.element)
}
