import XCTest
@testable import Argmax

/// The wire shapes, pinned against a real payload.
///
/// `Tests/Fixtures/dashboard-list.json` is a trimmed capture of
/// `node scripts/bridge.mjs call dashboard:list '{}'` — see the README for
/// how to take a fresh one. Hand-written literals would only pin what this
/// app already believes; the capture pins what the host actually sends.
final class ModelDecodingTests: XCTestCase {
    private func loadFixture() throws -> DashboardSnapshot {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: "dashboard-list", withExtension: "json"),
            "dashboard-list.json is not in the test bundle"
        )
        return try JSONDecoder().decode(DashboardSnapshot.self, from: Data(contentsOf: url))
    }

    func testDecodesACapturedDashboardList() throws {
        let snapshot = try loadFixture()
        XCTAssertEqual(snapshot.sessions.count, 9)
        XCTAssertEqual(snapshot.workspaces.count, 9)
        XCTAssertEqual(snapshot.projects.count, 4)
    }

    func testKeepsTheFieldsTheListDrawsFrom() throws {
        let snapshot = try loadFixture()
        let session = try XCTUnwrap(snapshot.sessions.first { $0.launchKind == "multitask" })
        XCTAssertEqual(session.provider, "claude")
        XCTAssertEqual(session.modelLabel, "Opus 5")
        XCTAssertEqual(session.state, .complete)
        XCTAssertEqual(session.attention, .reviewReady)
        // The linkage that keeps a multitask off the list and its parent lit.
        XCTAssertNotNil(session.launchedBySessionId)

        let scratch = try XCTUnwrap(snapshot.workspaces.first { $0.kind == .scratch })
        XCTAssertEqual(scratch.projectId, scratchProjectID)
        XCTAssertEqual(snapshot.projects.first { $0.id == scratchProjectID }?.name, "Side chats")
    }

    /// `TranscriptComposer` carries a follow-up's mode forward from this
    /// rather than defaulting every send to auto.
    func testKeepsTheSessionsAgentMode() throws {
        let snapshot = try loadFixture()
        let session = try XCTUnwrap(snapshot.sessions.first)
        XCTAssertEqual(session.agentMode, "auto")
    }

    /// A row written before the column existed still decodes — `nil`, not a
    /// thrown error — the same tolerance every optional field here gets.
    func testAgentModeIsOptional() throws {
        let payload = Data(
            """
            {"sessions": [{"id": "s-1", "workspaceId": "w-1", "provider": "codex",
              "modelLabel": "GPT-5.6 Terra", "modelId": "gpt-5.6-terra", "prompt": "hi",
              "state": "running", "attention": "normal", "startedAt": "2026-01-01T00:00:00Z",
              "lastActivityAt": "2026-01-01T00:00:00Z", "imported": false, "launchKind": "agent"}]}
            """.utf8
        )
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self, from: payload)
        XCTAssertNil(snapshot.sessions.first?.agentMode)
    }

    /// The host's `dashboard:list` also carries `checks` and
    /// `pendingMessages`, and its rows carry columns the phone never reads.
    /// Decoding must ignore all of it rather than fail.
    func testIgnoresFieldsThePhoneDoesNotRead() throws {
        let payload = Data(
            """
            {
              "checks": [],
              "pendingMessages": {"s-1": []},
              "somethingTheHostGrewLater": 7,
              "workspaces": [],
              "sessions": [],
              "projects": []
            }
            """.utf8
        )
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self, from: payload)
        XCTAssertTrue(snapshot.sessions.isEmpty)
    }

    /// A slice the host omits is "no rows", not a malformed payload.
    func testTreatsAMissingSliceAsEmpty() throws {
        let snapshot = try JSONDecoder().decode(DashboardSnapshot.self, from: Data("{}".utf8))
        XCTAssertTrue(snapshot.projects.isEmpty)
        XCTAssertTrue(snapshot.workspaces.isEmpty)
        XCTAssertTrue(snapshot.sessions.isEmpty)
    }

    /// A host that adds a state must not blank the phone's chat list.
    func testUnknownEnumStringsSurviveAsThemselves() throws {
        XCTAssertEqual(
            try JSONDecoder().decode(SessionState.self, from: Data("\"hibernating\"".utf8)),
            .unknown("hibernating")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(AttentionState.self, from: Data("\"nudged\"".utf8)),
            .unknown("nudged")
        )
        XCTAssertEqual(
            try JSONDecoder().decode(WorkspaceKind.self, from: Data("\"submodule\"".utf8)),
            .unknown("submodule")
        )
        // And they round-trip, so a row can be re-encoded unchanged.
        let encoded = try JSONEncoder().encode(SessionState.unknown("hibernating"))
        XCTAssertEqual(String(decoding: encoded, as: UTF8.self), "\"hibernating\"")
    }

    /// The read-channel manifest is the shared JSON, not a Swift copy.
    func testReadChannelManifestIsBundled() {
        XCTAssertTrue(RemoteChannels.read.contains("dashboard:list"))
        XCTAssertFalse(RemoteChannels.isMutation("dashboard:list"))
        XCTAssertTrue(RemoteChannels.isMutation("sessions:launch"))
    }

    func testPairingLinkAcceptsOnlyWhatTheAppCanLoad() {
        let good = "https://mac.tail.ts.net/mobile.html#token=abc123"
        XCTAssertNotNil(PairingLink.validate(good))
        XCTAssertEqual(PairingLink.token(in: URL(string: good)!), "abc123")
        XCTAssertEqual(
            PairingLink.socketURL(for: URL(string: good)!)?.absoluteString,
            "wss://mac.tail.ts.net/api/ws"
        )
        // Plain http is refused at pairing, but still derives a socket URL —
        // a tailnet without certificates can run the bridge.
        XCTAssertNil(PairingLink.validate("http://mac.tail.ts.net/mobile.html#token=abc"))
        XCTAssertEqual(
            PairingLink.socketURL(for: URL(string: "http://mac.tail.ts.net:8790/mobile.html")!)?
                .absoluteString,
            "ws://mac.tail.ts.net:8790/api/ws"
        )
        XCTAssertNil(PairingLink.validate("https://mac.tail.ts.net/mobile.html"))
        XCTAssertNil(PairingLink.validate("  "))
    }

    func testAHintOnlyDeltaDecodesItsFlags() throws {
        // Captured from the live bridge after a pin toggle: no rows, one flag.
        let payload = Data("""
        {"approvals":[],"dashboardChanged":true,"events":[],"projects":[],"rawOutputs":[],"sessions":[],"workspaces":[]}
        """.utf8)
        let delta = try JSONDecoder().decode(DashboardDelta.self, from: payload)
        XCTAssertEqual(delta.dashboardChanged, true)
        XCTAssertEqual(delta.sessions?.count, 0)
        XCTAssertNil(delta.resyncRequired)
    }
}

