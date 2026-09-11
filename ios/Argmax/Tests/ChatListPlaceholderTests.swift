import XCTest
@testable import Argmax

/// Which full-screen state the list shows, and when it shows none.
final class ChatListPlaceholderTests: XCTestCase {
    private let dropped = BridgeConnection.reconnecting(since: Date(timeIntervalSince1970: 0))

    func testRowsWinOverEveryStateButARefusedToken() {
        XCTAssertNil(chatListPlaceholder(connection: .live, hasRows: true, loadedOnce: true, failed: false))
        // Stale chats read better than an empty screen while the Mac is away.
        XCTAssertNil(chatListPlaceholder(connection: dropped, hasRows: true, loadedOnce: true, failed: true))
        XCTAssertEqual(
            chatListPlaceholder(connection: .unauthorized, hasRows: true, loadedOnce: true, failed: false),
            .unauthorized,
            "retrying cannot fix a refused token, so it takes the screen"
        )
    }

    /// The gap this was written for: the socket authenticates a round trip
    /// before the first snapshot, and "No chats yet. Start one" in that
    /// window is a lie told to a phone with a hundred chats on it.
    func testAnEmptyListBeforeTheFirstSnapshotIsStillConnecting() {
        XCTAssertEqual(
            chatListPlaceholder(connection: .live, hasRows: false, loadedOnce: false, failed: false),
            .connecting
        )
        XCTAssertEqual(
            chatListPlaceholder(connection: .live, hasRows: false, loadedOnce: true, failed: false),
            .noChats,
            "once the list has answered, empty means empty"
        )
    }

    func testEachConnectionStateHasItsOwnEmptyScreen() {
        XCTAssertEqual(
            chatListPlaceholder(connection: .connecting, hasRows: false, loadedOnce: false, failed: false),
            .connecting
        )
        XCTAssertEqual(
            chatListPlaceholder(connection: dropped, hasRows: false, loadedOnce: true, failed: false),
            .unreachable
        )
        XCTAssertEqual(
            chatListPlaceholder(connection: .live, hasRows: false, loadedOnce: true, failed: true),
            .unreachable,
            "a load that failed is unreachable, not empty"
        )
    }
}
