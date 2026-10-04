import Foundation
import XCTest
@testable import Argmax

final class TimelineSemanticsTests: XCTestCase {
    private func fixtureEvents() throws -> [TranscriptEvent] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(
            forResource: "timelineSemanticFixtures", withExtension: "json"
        ))
        return try JSONDecoder().decode([TranscriptEvent].self, from: Data(contentsOf: url))
    }

    func testSharedWireContractKeepsToolOutcomesAndChildIdentity() throws {
        let events = try fixtureEvents()
        XCTAssertEqual(events.count, 6)
        XCTAssertEqual(events[0].toolMeaning?.toolUseId, "toolu_1")
        XCTAssertEqual(events[0].toolMeaning?.outcome, "failed")
        XCTAssertEqual(events[0].timelineContext?.providerInvocationId, "turn-1")
        XCTAssertEqual(events[1].messageMeaning?.role, "assistant")
        XCTAssertEqual(events[1].timelineContext?.parentToolUseId, "tool-1")
        XCTAssertEqual(events[1].timelineContext?.providerThreadId, "child-thread")
        XCTAssertEqual(events[2].toolMeaning?.outcome, "cancelled")
        XCTAssertEqual(events[3].agentMeaning?.phase, "completed")
        XCTAssertEqual(events[3].timelineContext?.providerChildSessionId, "child-1")
        if let meaning = events[4].timelineMeaning, case .multitask(let multitask) = meaning {
            XCTAssertEqual(multitask.childSessionId, "child-2")
            XCTAssertEqual(multitask.phase, "launched")
        } else {
            XCTFail("multitask semantics missing")
        }
        if let meaning = events[5].timelineMeaning, case .error(let error) = meaning {
            XCTAssertEqual(error.code, "delivery-failed")
        } else {
            XCTFail("error semantics missing")
        }
    }

    func testHistoricalRowWithoutSemanticsKeepsLegacyProjection() throws {
        var child = try XCTUnwrap(fixtureEvents().first { $0.id == "cursor-child-message" })
        child.semantic = nil
        XCTAssertNil(child.messageMeaning)
        XCTAssertTrue(TranscriptProjection.project(events: [child]).isEmpty)
        XCTAssertFalse(TranscriptProjection.project(events: [child], includingChildActivity: true).isEmpty)
    }

    func testUnknownFutureKindDoesNotBecomeAChatMessage() throws {
        let data = try Data(contentsOf: XCTUnwrap(Bundle(for: Self.self).url(
            forResource: "timelineSemanticFixtures", withExtension: "json"
        )))
        var rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        var row = rows[1]
        var semantic = try XCTUnwrap(row["semantic"] as? [String: Any])
        semantic["event"] = ["kind": "future-chat-kind", "content": "answer"]
        row["semantic"] = semantic
        rows = [row]
        let changed = try JSONSerialization.data(withJSONObject: rows)
        let events = try JSONDecoder().decode([TranscriptEvent].self, from: changed)
        XCTAssertNotNil(events[0].timelineMeaning)
        XCTAssertFalse(events[0].isAssistantAnswer)
        XCTAssertTrue(TranscriptProjection.project(events: events, includingChildActivity: true).isEmpty)
    }

    func testFutureVersionKeepsLegacyDecoderAvailable() throws {
        var child = try XCTUnwrap(fixtureEvents().first { $0.id == "cursor-child-message" })
        child.semantic?.version = 2
        XCTAssertNil(child.timelineMeaning)
        XCTAssertFalse(TranscriptProjection.project(events: [child], includingChildActivity: true).isEmpty)
    }
}
