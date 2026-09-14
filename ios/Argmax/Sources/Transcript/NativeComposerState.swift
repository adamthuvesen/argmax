import Foundation

/// Native presentation state derived from the host's session metadata.
struct NativeSession: Hashable, Sendable {
    var sessionId: String
    var title: String
    var state: SessionState
    var attention: AttentionState
}

struct NativeQueuedMessage: Hashable, Sendable {
    var id: String
    var text: String
    var canSteer = false
}

struct NativeComposerState: Hashable, Sendable {
    var sessionId: String
    var provider: String
    var modelId: String
    var modelLabel: String
    var effort: String?
    var efforts: [String]
    var queued: [NativeQueuedMessage]
    var running: Bool
}
