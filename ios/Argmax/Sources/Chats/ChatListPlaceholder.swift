import Foundation

/// What the chat list shows instead of rows.
///
/// One mark, one line, one action — and the choice between them is a rule
/// rather than a view detail, because the states differ by one field each and
/// the wrong one is a sentence that lies to the reader.
enum ChatListPlaceholder: Equatable {
    case connecting
    case noChats
    case unreachable
    case unauthorized
}

/// Nil means "draw the rows".
///
/// The ordering matters more than it looks. A refused token takes the screen
/// whether or not the last snapshot is still on it, because retrying cannot
/// fix it. And "no chats" is only true once a `dashboard:list` has actually
/// come back: the socket reaches `.live` the moment it authenticates, which
/// is a whole round trip before the first snapshot lands, and an empty list
/// in that window means "not yet", not "you have no chats". Saying the latter
/// put "No chats yet. Start one" on screen for a second or two on every cold
/// start, in front of a phone with a hundred chats on it.
func chatListPlaceholder(
    connection: BridgeConnection,
    hasRows: Bool,
    loadedOnce: Bool,
    failed: Bool
) -> ChatListPlaceholder? {
    if connection == .unauthorized { return .unauthorized }
    guard !hasRows else { return nil }
    if failed { return .unreachable }
    switch connection {
    case .live: return loadedOnce ? .noChats : .connecting
    case .connecting: return .connecting
    case .reconnecting: return .unreachable
    case .unauthorized: return .unauthorized
    }
}
