import XCTest
@testable import Argmax

final class ChatDateGroupsTests: XCTestCase {
    func testDesktopRecencyBucketsKeepEachChatOnceInActivityOrder() throws {
        let now = try XCTUnwrap(parseWireTimestamp("2026-09-12T10:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let stamps = ["2026-09-04T12:00:00Z", "2026-09-11T23:59:00Z", "2026-09-12T08:00:00Z", "2026-09-05T12:00:00Z", "2026-09-12T09:00:00Z"]
        let rows = stamps.enumerated().map { index, at in
            ChatRow(workspace: makeWorkspace(id: "w-\(index)", lastActivityAt: at), session: makeSession(id: "s-\(index)", workspaceId: "w-\(index)"), projectName: nil, attention: nil, working: false)
        }
        let groups = groupChatsByDate(rows, now: now, calendar: calendar)
        XCTAssertEqual(groups.map(\.label), ["Today", "Yesterday", "Last 7 Days", "Older"])
        XCTAssertEqual(groups[0].rows.map(\.id), ["w-4", "w-2"])
        XCTAssertEqual(groups[2].rows.map(\.id), ["w-3"])
        XCTAssertEqual(groups.flatMap(\.rows).count, rows.count)
        XCTAssertTrue(groupChatsByDate([], now: now).isEmpty)
    }
}
