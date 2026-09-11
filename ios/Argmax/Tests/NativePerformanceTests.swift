import UIKit
import XCTest
@testable import Argmax

final class NativePerformanceTests: XCTestCase {
    func testLongTranscriptProjectionPerformance() {
        let events = (0..<3_000).map { index in
            TranscriptEvent(id: "event-\(index)", sessionId: "performance", type: index.isMultiple(of: 2) ? "user.message" : "message.completed",
                message: "Message \(index)\n\n" + String(repeating: "Representative transcript content. ", count: 12),
                payload: .object([:]), createdAt: String(format: "%06d", index), rowCursor: Int64(index))
        }
        measure(metrics: [XCTClockMetric(), XCTCPUMetric(), XCTMemoryMetric()]) {
            let items = TranscriptProjection.project(events: events)
            XCTAssertEqual(items.count, 3_000)
        }
    }

    func testLargeWorkspaceTreePerformance() {
        let entries = (0..<10_000).map { WorkspaceFileEntry(path: "source/module-\($0 / 50)/file-\($0).swift") }
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            let root = FileTree.build(entries)
            XCTAssertFalse(root.children.isEmpty)
        }
    }

    func testMarkdownPreparationPerformance() {
        let text = String(repeating: "## Heading\n\nA **bold** paragraph with a [link](https://example.com).\n\n- One\n- Two\n\n", count: 100)
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            let document = TranscriptMarkdownDocument(markdown: text)
            XCTAssertFalse(document.blocks.isEmpty)
        }
    }

    func testLargeReviewPreparationPerformance() {
        let document = CodeDocument(content: .file(String(repeating: "let value = compute()\n", count: 10_000)), key: "large-file")
        let font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()]) {
            let built = document.build(font: font)
            XCTAssertGreaterThan(built.string.length, 200_000)
        }
    }
}
