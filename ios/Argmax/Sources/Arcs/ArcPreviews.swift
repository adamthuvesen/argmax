#if DEBUG
import SwiftUI

// An arc for `#Preview`: the dashboard rows and the `arc:get` / `arc:timeline`
// answers a live Mac would send, so the list row and the screen draw without
// one. Debug-only so none of it ships.

@MainActor
func previewArcStore() -> DashboardStore {
    let store = DashboardStore(client: previewClient())
    var coordinator = previewSession
    coordinator.id = "s-arc-coordinator"
    coordinator.arcId = "arc-preview"
    coordinator.state = .running
    var member = previewSession
    member.id = "s-arc-member"
    member.workspaceId = "w-arc-member"
    member.arcId = "arc-preview"
    member.state = .running
    var memberWorkspace = previewWorkspace
    memberWorkspace.id = "w-arc-member"
    memberWorkspace.taskLabel = "Port the timeline to the phone"
    var snapshot = previewSnapshot
    snapshot.workspaces.append(memberWorkspace)
    snapshot.sessions += [coordinator, member]
    snapshot.arcs = [
        ArcSummary(
            id: "arc-preview",
            name: "Arcs on the phone",
            state: .active,
            homeProjectId: "p-argmax",
            coordinatorSessionId: coordinator.id,
            memberCount: 3,
            updatedAt: "2026-09-16T19:27:15.408Z",
            lastEventAt: "2026-09-17T08:56:41.574Z"
        )
    ]
    store.ingest(snapshot: snapshot)
    return store
}

@MainActor
func previewArcDetailStore() -> ArcStore {
    let store = ArcStore(arcID: "arc-preview", client: previewClient())
    let detail = ArcDetail(
        arc: ArcRecord(
            id: "arc-preview",
            name: "Arcs on the phone",
            brief: "Bring arcs to the iPhone app: see what is in flight, open the coordinator and the members working now, read the timeline, and pause or end an arc.\n\nCreating arcs and starting coordinators stay on the Mac.",
            state: .active,
            homeProjectId: "p-argmax",
            coordinatorSessionId: "s-arc-coordinator",
            createdAt: "2026-09-16T19:27:15.395Z",
            updatedAt: "2026-09-16T19:27:15.408Z"
        ),
        members: [
            ArcMemberSummary(sessionId: "s-arc-coordinator", taskLabel: "Arcs on the phone · coordinator",
                             projectName: "argmax", workspaceId: previewWorkspace.id, state: .running,
                             provider: "claude", modelLabel: "Fable 5.1", isCoordinator: true,
                             prNumber: nil, prState: nil),
            ArcMemberSummary(sessionId: "s-arc-member", taskLabel: "Port the timeline to the phone",
                             projectName: "argmax", workspaceId: "w-arc-member", state: .running,
                             provider: "codex", modelLabel: nil, isCoordinator: false,
                             prNumber: 214, prState: "OPEN")
        ],
        membersTruncated: false,
        launchesLast24h: 5,
        limits: ArcLimits(maxActiveMembers: 8, maxLaunchesPerDay: 40)
    )
    func event(_ kind: ArcEventKind, _ at: String, title: String, detail: String? = nil,
               status: String? = nil, pr: Int? = nil, session: String? = nil) -> ArcTimelineEvent {
        ArcTimelineEvent(id: "\(kind.rawWire):\(at)", seq: 0, kind: kind, occurredAt: at, sessionId: session,
                         sessionAvailable: session != nil, projectName: "argmax", title: title, detail: detail,
                         status: status, prNumber: pr, prUrl: pr.map { "https://github.com/example/argmax/pull/\($0)" })
    }
    store.seed(
        detail: detail,
        events: [
            event(.notesUpdated, "2026-09-17T08:56:41.574Z", title: "Phone v1: list section, Arc screen, state menu",
                  detail: "The timeline port runs as its own member. Creating arcs stays on the Mac, since it needs the model picker.",
                  status: "+6 −2", session: "s-arc-coordinator"),
            event(.prChecksPassing, "2026-09-17T08:40:00.000Z", title: "Arc screen", status: "a1b2c3d", pr: 214),
            event(.memberLaunched, "2026-09-17T08:20:11.207Z", title: "Port the timeline to the phone", session: "s-arc-member"),
            event(.memberFinished, "2026-09-16T21:02:00.000Z", title: "Decode arc rows",
                  detail: "Arc rows decode from `dashboard:list`, and a cached snapshot without them still loads.",
                  session: "s-arc-member"),
            event(.coordinatorStarted, "2026-09-16T19:27:15.400Z", title: "Coordinator started"),
            event(.created, "2026-09-16T19:27:15.395Z", title: "Arcs on the phone")
        ],
        cursor: ArcTimelineCursor(occurredAt: "2026-09-16T19:27:15.395Z", seq: 1)
    )
    return store
}

#Preview("Arc") {
    ArcScreen(seeded: previewArcDetailStore())
        .environmentObject(previewArcStore())
}
#endif
