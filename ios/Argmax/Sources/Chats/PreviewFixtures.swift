#if DEBUG
import Foundation

// Fixture rows for `#Preview`, and only for it.
//
// The bridge is a real socket to a Mac that a canvas render does not have, so
// a preview seeds the store instead and lets the reads fail quietly behind
// it: the pickers and the row still draw from the snapshot, which is what a
// preview is for. Debug-only so none of it ships.

/// A client pointed at a host that is not there. Nothing connects until
/// something calls `connect()`, which a preview never does.
@MainActor
func previewClient() -> BridgeClient {
    // Force-unwrapped on purpose: a literal that stopped parsing would be a
    // broken preview, not a runtime condition to handle.
    // swiftlint:disable:next force_try
    try! BridgeClient(pairingURL: URL(string: "https://preview.ts.net/mobile.html#token=preview")!)
}

/// A store holding two projects and one chat, enough for every control on
/// the New chat sheet and one list row with actions.
@MainActor
func previewStore() -> DashboardStore {
    let store = DashboardStore(client: previewClient())
    store.ingest(snapshot: previewSnapshot)
    return store
}

@MainActor
let previewSnapshot = DashboardSnapshot(
    projects: [
        ProjectSummary(
            id: "p-argmax",
            name: "argmax",
            repoPath: "/Users/you/dev/argmax",
            currentBranch: "main",
            defaultBranch: "main",
            latestActivityAt: "2026-09-10T12:00:00.000Z"
        ),
        ProjectSummary(
            id: "p-dotfiles",
            name: "dotfiles",
            repoPath: "/Users/you/dotfiles",
            currentBranch: "main",
            defaultBranch: "main",
            latestActivityAt: "2026-09-10T09:00:00.000Z"
        ),
        ProjectSummary(
            id: scratchProjectID,
            name: "Side chats",
            repoPath: "/Users/you/Library/Application Support/com.argmax.rs/local-state/side-chats",
            currentBranch: "main",
            defaultBranch: "main",
            latestActivityAt: "2026-09-10T08:00:00.000Z"
        )
    ],
    workspaces: [previewWorkspace],
    sessions: [previewSession]
)

@MainActor
let previewWorkspace = WorkspaceSummary(
    id: "w-1",
    projectId: "p-argmax",
    taskLabel: "Native chat actions",
    branch: "adam/feat-chat-actions",
    baseRef: "main",
    path: "/Users/you/dev/argmax/.argmax/worktrees/w-1",
    state: .complete,
    kind: .git,
    sharedWorkspace: false,
    dirty: true,
    changedFiles: 3,
    lastActivityAt: "2026-09-10T12:00:00.000Z",
    pinned: false,
    priorityDismissedAt: nil,
    priorityAddedAt: nil,
    prState: nil,
    prNumber: nil,
    prCheckState: nil,
    prActivityAt: nil
)

@MainActor
let previewSession = SessionSummary(
    id: "s-1",
    workspaceId: "w-1",
    provider: "claude",
    modelLabel: "Opus 5",
    modelId: "claude-opus-5",
    prompt: "Add swipe actions to the chat list",
    state: .complete,
    attention: .reviewReady,
    attentionChangedAt: "2026-09-10T12:00:00.000Z",
    startedAt: "2026-09-10T11:00:00.000Z",
    completedAt: "2026-09-10T12:00:00.000Z",
    lastActivityAt: "2026-09-10T12:00:00.000Z",
    imported: false,
    launchKind: "agent",
    launchedBySessionId: nil
)

@MainActor
let previewRow = ChatRow(
    workspace: previewWorkspace,
    session: previewSession,
    projectName: "argmax",
    attention: .reviewReady,
    working: false
)
#endif
