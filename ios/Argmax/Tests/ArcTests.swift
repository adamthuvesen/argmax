import XCTest
@testable import Argmax

/// Arcs on the phone: the wire shapes, which arcs the list shows, and what a
/// timeline row says. The fixtures are trimmed `arc:get` and `arc:timeline`
/// captures with the names changed.
final class ArcTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testDecodesACapturedArcDetail() throws {
        let detail = try fixture("arc-get", as: ArcDetail.self)
        XCTAssertEqual(detail.arc.state, .active)
        XCTAssertEqual(detail.arc.coordinatorSessionId, "s-coordinator")
        // The one field whose wire spelling is pinned by hand on the host.
        XCTAssertEqual(detail.launchesLast24h, 5)
        XCTAssertEqual(detail.limits.maxLaunchesPerDay, 40)
        XCTAssertEqual(detail.members.map(\.isCoordinator), [true, false])
        XCTAssertNil(detail.members[1].modelLabel)
    }

    func testDecodesACapturedTimelinePage() throws {
        let page = try fixture("arc-timeline", as: ArcTimelinePage.self)
        XCTAssertEqual(page.events.map(\.kind), [.notesUpdated, .memberLaunched, .prMerged, .created])
        XCTAssertEqual(page.nextCursor, ArcTimelineCursor(occurredAt: "2026-09-16T19:27:15.395Z", seq: 1))
    }

    func testAnUnknownEventKindStillDecodes() throws {
        let kind = try JSONDecoder().decode([ArcEventKind].self, from: Data(#"["goal_met"]"#.utf8))
        XCTAssertEqual(kind, [.unknown("goal_met")])
        XCTAssertEqual(kind[0].rawWire, "goal_met")
    }

    /// Arc rows and a session's `arcId` ride `dashboard:list`, and a snapshot
    /// cached before the phone read them still decodes.
    func testDashboardCarriesArcsAndOlderSnapshotsStillDecode() throws {
        let payload = Data(
            """
            {"arcs": [{"id": "arc-1", "name": "Forecast", "state": "paused", "homeProjectId": "p-1",
              "coordinatorSessionId": null, "dir": "/tmp/arc", "memberCount": 2,
              "updatedAt": "2026-09-16T19:27:15.408Z", "lastEventAt": null}],
             "sessions": [{"id": "s-1", "workspaceId": "w-1", "provider": "claude",
              "modelLabel": "Opus 5", "modelId": "claude-opus-5", "prompt": "hi",
              "state": "running", "attention": "normal", "startedAt": "2026-01-01T00:00:00Z",
              "lastActivityAt": "2026-01-01T00:00:00Z", "imported": false, "launchKind": "agent",
              "arcId": "arc-1"}]}
            """.utf8
        )
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self, from: payload)
        XCTAssertEqual(snapshot.arcs.first?.state, .paused)
        XCTAssertEqual(snapshot.sessions.first?.arcId, "arc-1")

        let cached = try JSONEncoder().encode(DashboardSnapshot())
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: cached) as? [String: Any])
        legacy.removeValue(forKey: "arcs")
        let decoded = try JSONDecoder().decode(
            DashboardSnapshot.self,
            from: JSONSerialization.data(withJSONObject: legacy)
        )
        XCTAssertEqual(decoded.arcs, [])
    }

    func testTheTimelineReadSendsANullCursorForTheNewestPage() throws {
        let data = try JSONEncoder().encode(ArcTimelineInput(arcId: "arc-1", before: nil, limit: 60))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["arcId", "before", "limit"])
        XCTAssertTrue(object["before"] is NSNull)
    }

    func testTheArcReadsAreNotJournaledAsMutations() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "remoteReadChannels", withExtension: "json"))
        let reads = try JSONDecoder().decode([String].self, from: Data(contentsOf: url))
        XCTAssertTrue(Set(["arc:list", "arc:get", "arc:timeline"]).isSubset(of: reads))
        XCTAssertFalse(reads.contains("arc:set-state"))
    }

    // MARK: - The list

    func testTheListShowsLiveArcsActiveFirstThenMostRecent() {
        func arc(_ id: String, _ state: ArcState, _ updatedAt: String) -> ArcSummary {
            ArcSummary(id: id, name: id, state: state, homeProjectId: "p-1", coordinatorSessionId: nil,
                       memberCount: 1, updatedAt: updatedAt, lastEventAt: nil)
        }
        let arcs = [
            arc("paused-new", .paused, "2026-09-17T10:00:00.000Z"),
            arc("done", .done, "2026-09-17T11:00:00.000Z"),
            arc("active-old", .active, "2026-09-10T10:00:00.000Z"),
            arc("active-new", .active, "2026-09-16T10:00:00.000Z"),
            arc("future", .unknown("archived"), "2026-09-17T12:00:00.000Z")
        ]
        XCTAssertEqual(liveArcs(arcs).map(\.id), ["active-new", "active-old", "paused-new"])
    }

    func testAMemberChatRowNamesItsArc() {
        var member = makeSession(id: "s-1", workspaceId: "w-1")
        member.arcId = "arc-1"
        let snapshot = DashboardSnapshot(
            workspaces: [makeWorkspace(id: "w-1"), makeWorkspace(id: "w-2")],
            sessions: [member, makeSession(id: "s-2", workspaceId: "w-2")],
            arcs: [ArcSummary(id: "arc-1", name: "Forecast", state: .active, homeProjectId: "p-1",
                              coordinatorSessionId: nil, memberCount: 1,
                              updatedAt: "2026-09-10T12:00:00.000Z", lastEventAt: nil)]
        )
        let rows = groupChatRows(snapshot: snapshot, now: Date()).chats
        XCTAssertEqual(rows.first { $0.id == "w-1" }?.arcName, "Forecast")
        XCTAssertNil(rows.first { $0.id == "w-2" }?.arcName)
    }

    // MARK: - The timeline

    func testTimelineRowsSayWhatHappened() throws {
        let events = try fixture("arc-timeline", as: ArcTimelinePage.self).events
        let notes = presentArcEvent(events[0])
        XCTAssertEqual(notes.subject, "“Dependencies: latest versions, lock file, lint, types, tests.”")
        XCTAssertEqual(notes.badge, "+3 −1")
        XCTAssertTrue(notes.detailIsQuote)
        XCTAssertEqual(presentArcEvent(events[2]).subject, "#214 Add the data loader")
        XCTAssertEqual(presentArcEvent(events[2]).glyph, .merged)

        var finished = events[1]
        finished.kind = .memberFinished
        finished.status = "failed"
        XCTAssertEqual(presentArcEvent(finished).verb, "Failed")
        finished.status = "cancelled"
        XCTAssertEqual(presentArcEvent(finished).verb, "Stopped")
        finished.status = nil
        XCTAssertEqual(presentArcEvent(finished).verb, "Finished")

        XCTAssertTrue(arcEventShowsProject(events[1]))
        XCTAssertFalse(arcEventShowsProject(events[3]))
    }

    func testTimelineGroupsByLocalDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Europe/Stockholm"))
        let events = try fixture("arc-timeline", as: ArcTimelinePage.self).events
        let now = try XCTUnwrap(parseWireTimestamp("2026-09-17T12:00:00.000Z"))
        let days = groupArcTimelineByDay(events, now: now, calendar: calendar)
        XCTAssertEqual(days.map(\.label).prefix(2), ["Today", "Yesterday"])
        XCTAssertEqual(days.map(\.events.count), [2, 2])
    }
}
