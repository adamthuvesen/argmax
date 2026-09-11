import XCTest
@testable import Argmax

/// The Pinned / Priority / Chats rules, ported from
/// `src/renderer/mobile/MobileApp.tsx` and `src/renderer/lib/priority.ts`.
/// A row lives in exactly one section, and these pin which one.
final class ChatSectionsTests: XCTestCase {
    func testAWorkspaceWithNoChatIsNotARow() {
        // Tapping it would resolve nothing; the launcher's connection-lost
        // path can strand exactly such a workspace.
        let sections = groupChatRows(
            snapshot: DashboardSnapshot(workspaces: [makeWorkspace(id: "w-1")]),
            now: testNow
        )
        XCTAssertTrue(sections.isEmpty)
    }

    func testArchivedAndPopupWorkspacesStayOut() {
        let snapshot = DashboardSnapshot(
            workspaces: [
                makeWorkspace(id: "w-archived", state: .archived),
                makeWorkspace(id: "w-popup", kind: .popup),
                makeWorkspace(id: "w-live")
            ],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-archived"),
                makeSession(id: "s-2", workspaceId: "w-popup"),
                makeSession(id: "s-3", workspaceId: "w-live")
            ]
        )
        XCTAssertEqual(groupChatRows(snapshot: snapshot, now: testNow).chats.map(\.id), ["w-live"])
    }

    /// A multitask belongs to the chat that dispatched it, so it has no row
    /// of its own — but its parent's row stays lit while it runs.
    func testARunningMultitaskHasNoRowAndLightsItsParent() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-parent"), makeWorkspace(id: "w-child")],
            sessions: [
                makeSession(id: "s-parent", workspaceId: "w-parent"),
                makeSession(
                    id: "s-child",
                    workspaceId: "w-child",
                    state: .running,
                    launchKind: "multitask",
                    launchedBySessionId: "s-parent"
                )
            ]
        )
        let sections = groupChatRows(snapshot: snapshot, now: testNow)
        XCTAssertEqual(sections.priority.map(\.id), ["w-parent"])
        XCTAssertTrue(try XCTUnwrap(sections.priority.first).working)
        XCTAssertTrue(sections.chats.isEmpty)
    }

    /// An orphan is the exception: with its launcher gone there is nowhere
    /// left to reach it from.
    func testAnOrphanedMultitaskGetsItsRowBack() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-child")],
            sessions: [
                makeSession(
                    id: "s-child",
                    workspaceId: "w-child",
                    launchKind: "multitask",
                    launchedBySessionId: "s-vanished"
                )
            ]
        )
        XCTAssertEqual(groupChatRows(snapshot: snapshot, now: testNow).chats.map(\.id), ["w-child"])
    }

    /// A pin is a standing placement, so it wins over a live reason.
    func testPinnedWinsOverPriority() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1", pinned: true)],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-1", attention: .approvalNeeded)
            ]
        )
        let sections = groupChatRows(snapshot: snapshot, now: testNow)
        XCTAssertEqual(sections.pinned.map(\.id), ["w-1"])
        XCTAssertTrue(sections.priority.isEmpty)
        XCTAssertTrue(sections.chats.isEmpty)
        // It still wears what it needs, it just does not move for it.
        XCTAssertEqual(sections.pinned.first?.attention, .approvalNeeded)
    }

    /// Side chats are conversational by nature and never escalate into
    /// triage, and their row carries the hidden singleton project's label.
    func testASideChatStaysOutOfPriorityAndWearsItsProjectName() {
        let snapshot = DashboardSnapshot(
            projects: [makeProject(id: scratchProjectID, name: "Side chats")],
            workspaces: [makeWorkspace(id: "w-1", projectId: scratchProjectID, kind: .scratch)],
            sessions: [makeSession(id: "s-1", workspaceId: "w-1", attention: .approvalNeeded)]
        )
        let sections = groupChatRows(snapshot: snapshot, now: testNow)
        XCTAssertTrue(sections.priority.isEmpty)
        XCTAssertEqual(sections.chats.first?.projectName, "Side chats")
    }

    /// An unread reply is history after thirty minutes; it stays in Chats
    /// but no longer floats.
    func testReviewReadyAgesOutOfPriority() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1")],
            sessions: [makeSession(id: "s-1", workspaceId: "w-1", attention: .reviewReady)]
        )
        XCTAssertEqual(groupChatRows(snapshot: snapshot, now: testNow).priority.map(\.id), ["w-1"])

        let later = testNow.addingTimeInterval(priorityIdleInterval)
        let aged = groupChatRows(snapshot: snapshot, now: later)
        XCTAssertTrue(aged.priority.isEmpty)
        XCTAssertEqual(aged.chats.map(\.id), ["w-1"])
    }

    /// An unanswered question waits for an answer, not for a clock.
    func testAnApprovalNeverAgesOut() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1")],
            sessions: [makeSession(id: "s-1", workspaceId: "w-1", attention: .approvalNeeded)]
        )
        let muchLater = testNow.addingTimeInterval(priorityIdleInterval * 10)
        XCTAssertEqual(groupChatRows(snapshot: snapshot, now: muchLater).priority.map(\.id), ["w-1"])
    }

    /// Reading clears `review-ready` on sight and nothing else.
    func testReadingClearsOnlyReviewReady() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-read"), makeWorkspace(id: "w-asking")],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-read", attention: .reviewReady),
                makeSession(id: "s-2", workspaceId: "w-asking", attention: .questionAsked)
            ]
        )
        let sections = groupChatRows(snapshot: snapshot, now: testNow, unreadWorkspaceIDs: [])
        XCTAssertEqual(sections.priority.map(\.id), ["w-asking"])
        XCTAssertEqual(sections.chats.map(\.id), ["w-read"])
    }

    /// A row from before the attention-changed column existed stays out,
    /// rather than flooding the section with every chat that ever failed.
    func testAReasonWithNoTimestampIsNotYetAReason() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1")],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-1", attention: .failed, attentionChangedAt: nil)
            ]
        )
        XCTAssertTrue(groupChatRows(snapshot: snapshot, now: testNow).priority.isEmpty)
    }

    /// A dismissal covers every reason that was already true when it was
    /// made, and nothing since.
    func testADismissalSpendsItselfOnTheReasonsItSaw() {
        let dismissed = makeWorkspace(id: "w-1", priorityDismissedAt: "2026-09-10T12:00:00.000Z")
        let stale = DashboardSnapshot(
            workspaces: [dismissed],
            sessions: [
                makeSession(
                    id: "s-1",
                    workspaceId: "w-1",
                    attention: .failed,
                    attentionChangedAt: "2026-09-10T11:00:00.000Z"
                )
            ]
        )
        XCTAssertTrue(groupChatRows(snapshot: stale, now: testNow).priority.isEmpty)

        let fresh = DashboardSnapshot(
            workspaces: [dismissed],
            sessions: [
                makeSession(
                    id: "s-1",
                    workspaceId: "w-1",
                    attention: .failed,
                    attentionChangedAt: "2026-09-10T12:00:30.000Z"
                )
            ]
        )
        XCTAssertEqual(groupChatRows(snapshot: fresh, now: testNow).priority.map(\.id), ["w-1"])
    }

    /// An open pull request is the weakest claim there is, and a red check
    /// on it is stronger than a reply nobody has read.
    func testPullRequestReasonsRankBelowTheChatsOwn() {
        let snapshot = DashboardSnapshot(
            workspaces: [
                makeWorkspace(
                    id: "w-pr",
                    prState: "OPEN",
                    prActivityAt: "2026-09-10T12:00:00.000Z"
                ),
                makeWorkspace(
                    id: "w-red",
                    prState: "OPEN",
                    prCheckState: "failure",
                    prActivityAt: "2026-09-10T12:00:00.000Z"
                ),
                makeWorkspace(id: "w-blocked")
            ],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-pr"),
                makeSession(id: "s-2", workspaceId: "w-red"),
                makeSession(id: "s-3", workspaceId: "w-blocked", attention: .blocked)
            ]
        )
        XCTAssertEqual(
            groupChatRows(snapshot: snapshot, now: testNow).priority.map(\.id),
            ["w-blocked", "w-red", "w-pr"]
        )
    }

    /// Working rows are always at the top, whatever anyone else needs.
    func testWorkingRowsLeadPriority() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-asking"), makeWorkspace(id: "w-running")],
            sessions: [
                makeSession(id: "s-1", workspaceId: "w-asking", attention: .approvalNeeded),
                makeSession(id: "s-2", workspaceId: "w-running", state: .running)
            ]
        )
        XCTAssertEqual(
            groupChatRows(snapshot: snapshot, now: testNow).priority.map(\.id),
            ["w-running", "w-asking"]
        )
    }

    /// Chats is newest-first on the chat's last message.
    func testChatsAreNewestFirst() {
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-old"), makeWorkspace(id: "w-new")],
            sessions: [
                makeSession(
                    id: "s-1",
                    workspaceId: "w-old",
                    attention: .reviewReady,
                    lastActivityAt: "2026-09-09T12:00:00.000Z"
                ),
                makeSession(
                    id: "s-2",
                    workspaceId: "w-new",
                    attention: .reviewReady,
                    lastActivityAt: "2026-09-10T12:00:00.000Z"
                )
            ]
        )
        // Far enough past both last messages that neither still floats.
        let later = testNow.addingTimeInterval(priorityIdleInterval)
        XCTAssertEqual(groupChatRows(snapshot: snapshot, now: later).chats.map(\.id), ["w-new", "w-old"])
    }

    /// The captured payload groups without throwing anything away.
    func testTheCapturedSnapshotGroupsIntoSections() throws {
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "dashboard-list", withExtension: "json")
        )
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self, from: Data(contentsOf: url))
        let sections = groupChatRows(snapshot: snapshot, now: testNow)
        let rows = sections.pinned + sections.priority + sections.chats
        // Two of the nine workspaces are archived and one chat is a
        // multitask whose launcher is in the payload, so six rows remain.
        XCTAssertEqual(rows.count, 6)
        XCTAssertEqual(Set(rows.map(\.id)).count, rows.count, "a row must live in exactly one section")
        XCTAssertEqual(sections.pinned.count, 1)
    }
}
