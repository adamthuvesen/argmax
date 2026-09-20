import XCTest
@testable import Argmax

/// `ChatRowActionCenter.run(_:_:)`: a successful pin/archive/rename/fork
/// waits for the host's own `dashboard:delta` to land before paying for a
/// full `dashboard:list`, and reloads outright only when nothing arrives —
/// a lagging client — or when the mutation itself threw, since no delta is
/// coming for a call the host never applied.
final class ChatRowActionCenterTests: XCTestCase {
    @MainActor
    func testASuccessfulMutationSkipsReloadWhenItsDeltaArrives() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient(socket)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (store, center, row) = try makeCenter(client: client, directory: directory)

        center.togglePin(row)
        let request = try await waitForRequest(on: socket, channel: "workspaces:set-pinned")
        var pinned = row.workspace
        pinned.pinned = true
        // The host's delta usually lands before the mutation's own response,
        // so it must count even though it arrives while `work()` is pending.
        store.ingest(delta: DashboardDelta(workspaces: [pinned]))
        let repliedAt = Date()
        socket.reply(to: request, ok: try jsonObject(pinned))

        try await waitForBusyToClear(center, row)
        XCTAssertLessThan(Date().timeIntervalSince(repliedAt), 1.0, "controls waited out the grace window")
        XCTAssertFalse(socket.requests.contains { $0["channel"] as? String == "dashboard:list" })
        await client.disconnect()
    }

    @MainActor
    func testASuccessfulMutationReloadsWhenNoDeltaArrivesInTime() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient(socket)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (_, center, row) = try makeCenter(client: client, directory: directory)

        center.togglePin(row)
        let request = try await waitForRequest(on: socket, channel: "workspaces:set-pinned")
        var pinned = row.workspace
        pinned.pinned = true
        socket.reply(to: request, ok: try jsonObject(pinned))
        // No delta follows: a lagging or reconnecting client still has to
        // correct itself, which only the fallback reload does.

        let reload = try await waitForRequest(on: socket, channel: "dashboard:list", timeoutMS: 3000)
        socket.reply(to: reload, ok: [:])
        try await waitForBusyToClear(center, row)
        await client.disconnect()
    }

    @MainActor
    func testAFailedMutationReloadsRightAwayRatherThanWaitingForADelta() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient(socket)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (_, center, row) = try makeCenter(client: client, directory: directory)

        center.togglePin(row)
        let request = try await waitForRequest(on: socket, channel: "workspaces:set-pinned")
        let repliedAt = Date()
        socket.reply(to: request, error: "CHAT_ROW_ACTION_TEST_FAILURE")

        // The host never applied a call that answered with an error, so
        // there is no delta to wait for — this must beat the grace window
        // `waitForDashboardChange` gives a successful mutation by a wide
        // margin.
        let reload = try await waitForRequest(on: socket, channel: "dashboard:list", timeoutMS: 1000)
        XCTAssertLessThan(Date().timeIntervalSince(repliedAt), 1.0)
        socket.reply(to: reload, ok: [:])
        try await waitForBusyToClear(center, row)
        XCTAssertNotNil(center.failure)
        await client.disconnect()
    }

    @MainActor
    func testArchiveAppliesFinalResponseAfterOnlyIntermediateDeltaArrives() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient(socket)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (store, center, row) = try makeCenter(client: client, directory: directory)

        center.archive(row)
        let request = try await waitForRequest(on: socket, channel: "workspaces:archive")
        var archiving = row.workspace
        archiving.state = .archiving
        store.ingest(delta: DashboardDelta(workspaces: [archiving]))

        var archived = archiving
        archived.state = .archived
        socket.reply(to: request, ok: [
            "workspace": try jsonObject(archived),
            "recoveryPath": NSNull(),
        ])

        try await waitForBusyToClear(center, row)
        XCTAssertFalse(store.sections.chats.contains { $0.id == row.id })
        XCTAssertFalse(socket.requests.contains { $0["channel"] as? String == "dashboard:list" })
        await client.disconnect()
    }

    @MainActor
    func testDelayedIntermediateDeltaCannotReviveArchivedRow() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient(socket)
        defer { try? FileManager.default.removeItem(at: directory) }
        let (store, center, row) = try makeCenter(client: client, directory: directory)

        center.archive(row)
        let request = try await waitForRequest(on: socket, channel: "workspaces:archive")
        var archived = row.workspace
        archived.state = .archived
        socket.reply(to: request, ok: [
            "workspace": try jsonObject(archived),
            "recoveryPath": NSNull(),
        ])
        try await waitForBusyToClear(center, row)

        var delayed = archived
        delayed.state = .archiving
        store.ingest(delta: DashboardDelta(workspaces: [delayed]))

        XCTAssertFalse(store.sections.chats.contains { $0.id == row.id })
        await client.disconnect()
    }

    // MARK: - Helpers

    private func makeClient(_ socket: TestBridgeSocket) throws -> (BridgeClient, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let client = try BridgeClient(
            pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=test")),
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in socket }
        )
        return (client, directory)
    }

    @MainActor
    private func makeCenter(
        client: BridgeClient, directory: URL
    ) throws -> (DashboardStore, ChatRowActionCenter, ChatRow) {
        let workspace = makeWorkspace(id: "w-1")
        let session = makeSession(id: "s-1", workspaceId: "w-1")
        let store = DashboardStore(client: client, now: testNow, cache: DeviceCache(directory: directory))
        store.ingest(snapshot: DashboardSnapshot(workspaces: [workspace], sessions: [session]))
        let center = ChatRowActionCenter(store: store, client: client)
        let row = try XCTUnwrap(store.row(forSessionID: "s-1"))
        return (store, center, row)
    }

    private func waitForRequest(
        on socket: TestBridgeSocket, channel: String, timeoutMS: Int = 500
    ) async throws -> [String: Any] {
        for _ in 0..<max(1, timeoutMS / 10) {
            if let match = socket.requests.last(where: { $0["channel"] as? String == channel }) {
                return match
            }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("never saw a \(channel) request")
        throw BridgeError.disconnected
    }

    @MainActor
    private func waitForBusyToClear(_ center: ChatRowActionCenter, _ row: ChatRow) async throws {
        for _ in 0..<300 {
            if !center.isBusy(row) { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("mutation never cleared inFlight")
    }

    private func jsonObject(_ value: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
