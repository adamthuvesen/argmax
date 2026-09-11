import Foundation
@testable import Argmax

// Builders for the two rows every test here needs. Defaults are the boring
// case — a finished chat on a git checkout that needs nobody — so each test
// names only what it is about.

func makeWorkspace(
    id: String,
    projectId: String = "p-1",
    taskLabel: String = "A chat",
    state: WorkspaceState = .complete,
    kind: WorkspaceKind = .git,
    lastActivityAt: String = "2026-09-10T12:00:00.000Z",
    pinned: Bool = false,
    priorityDismissedAt: String? = nil,
    priorityAddedAt: String? = nil,
    prState: String? = nil,
    prCheckState: String? = nil,
    prActivityAt: String? = nil,
    icon: String? = nil,
    iconColor: String? = nil
) -> WorkspaceSummary {
    WorkspaceSummary(
        id: id,
        projectId: projectId,
        taskLabel: taskLabel,
        branch: "main",
        baseRef: "main",
        path: "/tmp/\(id)",
        state: state,
        kind: kind,
        sharedWorkspace: false,
        dirty: false,
        changedFiles: 0,
        lastActivityAt: lastActivityAt,
        pinned: pinned,
        priorityDismissedAt: priorityDismissedAt,
        priorityAddedAt: priorityAddedAt,
        prState: prState,
        prNumber: prState == nil ? nil : 1,
        prCheckState: prCheckState,
        prActivityAt: prActivityAt,
        icon: icon,
        iconColor: iconColor
    )
}

func makeSession(
    id: String,
    workspaceId: String,
    state: SessionState = .complete,
    attention: AttentionState = .normal,
    attentionChangedAt: String? = "2026-09-10T12:00:00.000Z",
    lastActivityAt: String = "2026-09-10T12:00:00.000Z",
    launchKind: String = "agent",
    launchedBySessionId: String? = nil
) -> SessionSummary {
    SessionSummary(
        id: id,
        workspaceId: workspaceId,
        provider: "claude",
        modelLabel: "Opus 5",
        modelId: "claude-opus-5",
        prompt: "do the thing",
        state: state,
        attention: attention,
        attentionChangedAt: attentionChangedAt,
        startedAt: "2026-09-10T11:00:00.000Z",
        completedAt: nil,
        lastActivityAt: lastActivityAt,
        imported: false,
        launchKind: launchKind,
        launchedBySessionId: launchedBySessionId
    )
}

func makeProject(
    id: String,
    name: String = "argmax",
    latestActivityAt: String? = "2026-09-10T12:00:00.000Z"
) -> ProjectSummary {
    ProjectSummary(
        id: id,
        name: name,
        repoPath: "/tmp/\(id)",
        currentBranch: "main",
        defaultBranch: "main",
        latestActivityAt: latestActivityAt
    )
}

/// The clock every grouping test runs against: one minute after the default
/// row activity, so nothing has aged out yet.
let testNow = ISO8601DateFormatter.withMilliseconds.date(from: "2026-09-10T12:01:00.000Z")!
