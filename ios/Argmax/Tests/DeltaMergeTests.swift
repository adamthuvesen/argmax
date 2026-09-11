import XCTest
@testable import Argmax

/// Mirrors the `mergeDashboardDelta` cases in
/// `src/renderer/lib/snapshot.test.ts`, minus the event-stream ones — the
/// phone keeps no events, since the transcript is still a web view.
///
/// The renderer asserts *reference* identity where these assert equality:
/// that is the same guarantee in a language with value types, and it is what
/// `DashboardStore` compares before it publishes.
final class DeltaMergeTests: XCTestCase {
    private var base: DashboardSnapshot {
        DashboardSnapshot(
            projects: [makeProject(id: "p-1")],
            workspaces: [makeWorkspace(id: "w-1")],
            sessions: [makeSession(id: "s-1", workspaceId: "w-1")]
        )
    }

    func testAnEmptyDeltaChangesNothing() {
        XCTAssertEqual(mergeDashboardDelta(base, DashboardDelta()), base)
    }

    func testResendingKnownRowsChangesNothing() {
        let delta = DashboardDelta(workspaces: base.workspaces, sessions: base.sessions)
        XCTAssertEqual(mergeDashboardDelta(base, delta), base)
    }

    func testAChangedRowReplacesItsPredecessor() {
        let running = makeSession(id: "s-1", workspaceId: "w-1", state: .running)
        let merged = mergeDashboardDelta(base, DashboardDelta(sessions: [running]))
        XCTAssertEqual(merged.sessions.count, 1)
        XCTAssertEqual(merged.sessions[0].state, .running)
    }

    func testANewRowIsSortedInNewestFirst() {
        let older = makeSession(
            id: "s-0",
            workspaceId: "w-0",
            lastActivityAt: "2026-09-10T09:00:00.000Z"
        )
        let newer = makeSession(
            id: "s-2",
            workspaceId: "w-2",
            lastActivityAt: "2026-09-10T18:00:00.000Z"
        )
        let merged = mergeDashboardDelta(base, DashboardDelta(sessions: [older, newer]))
        XCTAssertEqual(merged.sessions.map(\.id), ["s-2", "s-1", "s-0"])
    }

    /// JavaScript's `Array.sort` is stable and Swift's is not, so rows
    /// minted in the same millisecond must keep the order they arrived in
    /// rather than swapping places on an unrelated delta.
    func testEqualTimestampsKeepTheirExistingOrder() {
        let stamp = "2026-09-10T12:00:00.000Z"
        let snapshot = DashboardSnapshot(
            sessions: (1...5).map { makeSession(id: "s-\($0)", workspaceId: "w-\($0)", lastActivityAt: stamp) }
        )
        let touched = makeSession(id: "s-3", workspaceId: "w-3", state: .running, lastActivityAt: stamp)
        let merged = mergeDashboardDelta(snapshot, DashboardDelta(sessions: [touched]))
        XCTAssertEqual(merged.sessions.map(\.id), ["s-1", "s-2", "s-3", "s-4", "s-5"])
    }

    func testRemovalsDropSessionsAndTheirWorkspaces() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-imported"), makeWorkspace(id: "w-kept")],
            sessions: [
                makeSession(id: "s-imported", workspaceId: "w-imported"),
                makeSession(id: "s-kept", workspaceId: "w-kept")
            ]
        )
        let merged = mergeDashboardDelta(
            snapshot,
            DashboardDelta(removedSessionIds: ["s-imported"], removedWorkspaceIds: ["w-imported"])
        )
        XCTAssertEqual(merged.sessions.map(\.id), ["s-kept"])
        XCTAssertEqual(merged.workspaces.map(\.id), ["w-kept"])
    }

    /// A removed workspace takes its chats with it even when only the
    /// workspace id is listed — nothing else in the protocol can say "gone".
    func testARemovedWorkspaceTakesItsSessions() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-gone")],
            sessions: [makeSession(id: "s-orphaned", workspaceId: "w-gone")]
        )
        let merged = mergeDashboardDelta(snapshot, DashboardDelta(removedWorkspaceIds: ["w-gone"]))
        XCTAssertTrue(merged.workspaces.isEmpty)
        XCTAssertTrue(merged.sessions.isEmpty)
    }

    /// Projects sort on their own field, and one that has never been touched
    /// sorts last.
    func testProjectsSortByLatestActivityWithNeverUsedLast() {
        let snapshot = DashboardSnapshot(projects: [makeProject(id: "p-1")])
        let merged = mergeDashboardDelta(
            snapshot,
            DashboardDelta(projects: [
                makeProject(id: "p-quiet", latestActivityAt: nil),
                makeProject(id: "p-loud", latestActivityAt: "2026-09-11T00:00:00.000Z")
            ])
        )
        XCTAssertEqual(merged.projects.map(\.id), ["p-loud", "p-1", "p-quiet"])
    }

    /// The store's own seam. No socket is opened: it only connects when
    /// `start()` is called.
    @MainActor
    func testStoreIngestsADeltaAndRegroups() throws {
        let pairingURL = try XCTUnwrap(URL(string: "https://mac.tail.ts.net/mobile.html#token=t"))
        let store = DashboardStore(client: try BridgeClient(pairingURL: pairingURL), now: testNow)
        store.ingest(snapshot: base)
        XCTAssertEqual(store.sections.chats.map(\.id), ["w-1"])
        store.ingest(delta: DashboardDelta(removedWorkspaceIds: ["w-1"]))
        XCTAssertTrue(store.sections.isEmpty)
    }

    /// What a launch relies on: seeding the rows it was answered with makes
    /// the chat's row available in the same call, so the New chat screen can
    /// be replaced by the transcript without a trip back to the list.
    @MainActor
    func testSeedingALaunchedChatMakesItsRowAvailableAtOnce() throws {
        let pairingURL = try XCTUnwrap(URL(string: "https://mac.tail.ts.net/mobile.html#token=t"))
        let store = DashboardStore(client: try BridgeClient(pairingURL: pairingURL), now: testNow)
        store.ingest(snapshot: base)
        XCTAssertNil(store.row(forSessionID: "s-new"))

        store.ingest(
            delta: DashboardDelta(
                workspaces: [makeWorkspace(id: "w-new", taskLabel: "Fresh chat")],
                sessions: [makeSession(id: "s-new", workspaceId: "w-new", state: .running)]
            )
        )

        let row = try XCTUnwrap(store.row(forSessionID: "s-new"))
        XCTAssertEqual(row.workspace.id, "w-new")
        XCTAssertEqual(row.workspace.taskLabel, "Fresh chat")
    }
}
