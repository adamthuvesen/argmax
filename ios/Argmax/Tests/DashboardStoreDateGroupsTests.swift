import XCTest
@testable import Argmax

/// `DashboardStore.dateGroups`: the desktop's recency buckets, computed once
/// in the store instead of by `ChatListView` on every render. The cache key
/// is the rows plus the calendar day, not `now` itself — `now` also ticks
/// once a minute for the Priority clock, and a chat still has to move from
/// "Today" to "Yesterday" the moment midnight passes even though nothing
/// about the chat changed.
final class DashboardStoreDateGroupsTests: XCTestCase {
    @MainActor
    func testAChatMovesFromTodayToYesterdayWhenMidnightPassesWithoutAnyOtherChange() async throws {
        // Built off `Calendar.current`, not a fixed UTC instant: the
        // grouping buckets by the local day, so the test has to cross
        // midnight in whatever timezone it runs in.
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: Date())
        let activity = ISO8601DateFormatter.withMilliseconds.string(from: startOfToday.addingTimeInterval(3600))
        let beforeMidnight = startOfToday.addingTimeInterval(23 * 3600)
        let afterMidnight = startOfToday.addingTimeInterval(25 * 3600)

        let (client, directory) = try makeClient()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = DashboardStore(client: client, now: beforeMidnight, cache: DeviceCache(directory: directory))
        store.ingest(snapshot: DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1", lastActivityAt: activity)],
            sessions: [makeSession(id: "s-1", workspaceId: "w-1", lastActivityAt: activity)]
        ))
        XCTAssertEqual(store.dateGroups.map(\.label), ["Today"])

        store.now = afterMidnight

        XCTAssertEqual(store.dateGroups.map(\.label), ["Yesterday"])
        XCTAssertEqual(store.dateGroups.first?.rows.map(\.id), ["w-1"])
        await client.disconnect()
    }

    private func makeClient() throws -> (BridgeClient, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let socket = TestBridgeSocket()
        let client = try BridgeClient(
            pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=test")),
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in socket }
        )
        return (client, directory)
    }
}
