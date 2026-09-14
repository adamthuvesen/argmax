import XCTest
@testable import Argmax

/// The same cases `src/renderer/lib/diff.test.ts` runs, ported line for line.
///
/// Both clients read the same `review:load-diff` bytes, so a disagreement here
/// is a hunk one of them silently does not draw. That is worth two copies of
/// the same test.
final class DiffParserTests: XCTestCase {
    private func hunk(_ oldStart: Int, _ newStart: Int, _ body: [String]) -> [String] {
        ["@@ -\(oldStart),\(body.count) +\(newStart),\(body.count) @@"] + body
    }

    func testCountsUnmodifiedLinesGitLeftOutBetweenTwoHunks() {
        let content = ([
            "diff --git a/a.ts b/a.ts",
            "--- a/a.ts",
            "+++ b/a.ts"
        ] + hunk(1, 1, [" one", "-two", "+TWO"]) + hunk(20, 20, ["-twenty", "+TWENTY"]))
            .joined(separator: "\n")

        let blocks = DiffParser.parse(content)

        // The first hunk covers old lines 1–2 (context + deletion), so the gap
        // to the second hunk's line 20 is 17 lines.
        XCTAssertEqual(blocks.map(kind), ["hunk", "omitted", "hunk"])
        XCTAssertEqual(blocks[1], .omitted(id: "omitted-1", count: 17))
    }

    func testDoesNotInventAGapAcrossAFileBoundary() {
        let content = (["diff --git a/a.ts b/a.ts"] + hunk(100, 100, ["-a", "+A"])
            + ["diff --git a/b.ts b/b.ts"] + hunk(200, 200, ["-b", "+B"]))
            .joined(separator: "\n")

        XCTAssertEqual(DiffParser.parse(content).map(kind), ["hunk", "hunk"])
    }

    func testReportsTheBytesACappedDiffDropped() {
        let content = (hunk(1, 1, ["-a", "+A"])
            + ["[diff truncated at 1048576 bytes; dropped 4096 bytes]", ""])
            .joined(separator: "\n")

        XCTAssertEqual(DiffParser.parse(content).last, .truncated(id: "truncated", droppedBytes: 4096))
    }

    func testLeavesAnUntruncatedDiffWithoutATruncationBlock() {
        let blocks = DiffParser.parse(hunk(1, 1, ["-a", "+A"]).joined(separator: "\n"))
        XCTAssertFalse(blocks.contains { kind($0) == "truncated" })
    }

    func testAssignsBothLineNumbersToContextAndOneSideToChanges() {
        let blocks = DiffParser.parse(hunk(5, 9, [" keep", "-drop", "+add"]).joined(separator: "\n"))
        guard case .hunk(_, _, let lines) = blocks.first else {
            return XCTFail("expected a hunk")
        }
        XCTAssertEqual(lines, [
            ParsedDiffLine(kind: .context, oldLineNumber: 5, newLineNumber: 9, content: "keep"),
            ParsedDiffLine(kind: .deletion, oldLineNumber: 6, newLineNumber: nil, content: "drop"),
            ParsedDiffLine(kind: .addition, oldLineNumber: nil, newLineNumber: 10, content: "add")
        ])
    }

    /// A hunk with no `,count` is git's spelling for a single line, and the
    /// header scanner has to accept it or the whole hunk disappears.
    func testAcceptsAHunkHeaderWithoutLineCounts() {
        let blocks = DiffParser.parse("@@ -3 +3 @@\n-a\n+A")
        guard case .hunk(_, _, let lines) = blocks.first else {
            return XCTFail("expected a hunk")
        }
        XCTAssertEqual(lines.map(\.content), ["a", "A"])
        XCTAssertEqual(lines.first?.oldLineNumber, 3)
    }

    /// Addition content that itself starts with `+` arrives as `+++ foo`, and
    /// dropping it would silently delete a line of the change.
    func testKeepsAdditionContentThatLooksLikeAFileHeader() {
        let blocks = DiffParser.parse("@@ -1,1 +1,2 @@\n+++ foo\n+--- bar")
        guard case .hunk(_, _, let lines) = blocks.first else {
            return XCTFail("expected a hunk")
        }
        XCTAssertEqual(lines.map(\.content), ["++ foo", "--- bar"])
        XCTAssertEqual(lines.map(\.kind), [.addition, .addition])
    }

    func testSkipsTheNoNewlineMarker() {
        let blocks = DiffParser.parse("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+A")
        guard case .hunk(_, _, let lines) = blocks.first else {
            return XCTFail("expected a hunk")
        }
        XCTAssertEqual(lines.map(\.content), ["a", "A"])
    }

    func testClimbsTheLadderFromGitsDefaultAndStopsAtTheTop() {
        let first = DiffParser.contextSteps[0]
        let last = DiffParser.contextSteps[DiffParser.contextSteps.count - 1]

        XCTAssertEqual(DiffParser.nextContext(after: nil), first)
        XCTAssertEqual(DiffParser.nextContext(after: first), last)
        XCTAssertNil(DiffParser.nextContext(after: last))
    }

    /// `MAX_DIFF_CONTEXT_LINES` in `src-tauri/src/ipc/validation.rs` rejects
    /// anything larger, so a rung above it would be an error, not a wider diff.
    func testStaysWithinTheBoundTheRustValidatorEnforces() {
        for step in DiffParser.contextSteps {
            XCTAssertLessThanOrEqual(step, 100_000)
        }
    }

    private func kind(_ block: ParsedDiffBlock) -> String {
        switch block {
        case .hunk: return "hunk"
        case .omitted: return "omitted"
        case .truncated: return "truncated"
        }
    }
}
