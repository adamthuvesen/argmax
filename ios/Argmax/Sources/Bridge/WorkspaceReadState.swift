import Foundation

/// `workspaces:mark-viewed` acknowledges the activity the screen observed,
/// rather than the current time, so a delayed request cannot read a new reply.
struct MarkWorkspacesViewedInput: Encodable, Sendable {
    struct Workspace: Encodable, Sendable {
        var workspaceId: String
        var observedActivityAt: String
    }
    var workspaces: [Workspace]
}
