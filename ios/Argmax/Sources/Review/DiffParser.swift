import Foundation

// The unified-diff parser, ported from `src/renderer/lib/diff.ts`.
//
// Both sides read the same bytes out of the same `review:load-diff` response,
// so they have to agree line for line: a hunk the phone skips is a change the
// reader never sees, and there is no second source to notice. The port is
// deliberately literal — same branches, same order, same edge cases — and
// `DiffParserTests` runs it against the fixtures the TypeScript tests use.

/// One line inside a hunk. Its two line numbers are the two axes git tracks:
/// an addition has no old number, a deletion has no new one.
struct ParsedDiffLine: Hashable, Sendable {
    enum Kind: Hashable, Sendable {
        case addition
        case deletion
        case context
    }

    var kind: Kind
    var oldLineNumber: Int?
    var newLineNumber: Int?
    var content: String

    /// What the gutter shows: the new axis where there is one, else the old.
    var displayLineNumber: Int? { newLineNumber ?? oldLineNumber }
}

/// A block of the rendered diff. `omitted` is the gap between two hunks, which
/// the reader can open; `truncated` is the tail the host dropped on the floor.
enum ParsedDiffBlock: Hashable, Sendable, Identifiable {
    case hunk(id: String, header: String, lines: [ParsedDiffLine])
    case omitted(id: String, count: Int)
    case truncated(id: String, droppedBytes: Int)

    var id: String {
        switch self {
        case .hunk(let id, _, _): return id
        case .omitted(let id, _): return id
        case .truncated(let id, _): return id
        }
    }
}

enum DiffParser {
    /// The context ladder behind "expand unmodified lines": git's own default
    /// (requested as `nil`, so an untouched diff stays exactly what it was),
    /// then a screenful, then the whole file. The last rung must stay at or
    /// under `MAX_DIFF_CONTEXT_LINES` in `src-tauri/src/ipc/validation.rs`,
    /// which rejects anything larger.
    static let contextSteps: [Int] = [25, 100_000]

    /// The next rung above `current`, or nil when the whole file is shown.
    static func nextContext(after current: Int?) -> Int? {
        contextSteps.first { current == nil || $0 > current! }
    }

    static func parse(_ content: String) -> [ParsedDiffBlock] {
        var blocks: [ParsedDiffBlock] = []
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        var index = 0
        var previousOldEnd: Int?
        var hunkIndex = 0

        while index < lines.count {
            let header = lines[index]
            guard let range = hunkRange(header) else {
                // A new file starts a new line-number axis. Carrying the
                // previous file's end across the boundary would invent a gap
                // out of two unrelated line numbers, and that number is now a
                // control the reader can tap.
                if header.hasPrefix("diff --git ") { previousOldEnd = nil }
                index += 1
                continue
            }

            var oldLineNumber = range.oldStart
            var newLineNumber = range.newStart
            if let previousOldEnd {
                let omittedCount = range.oldStart - previousOldEnd - 1
                if omittedCount > 0 {
                    blocks.append(.omitted(id: "omitted-\(hunkIndex)", count: omittedCount))
                }
            }

            var hunkLines: [ParsedDiffLine] = []
            index += 1
            while index < lines.count, !lines[index].hasPrefix("@@ ") {
                let line = lines[index]
                if line.hasPrefix("diff --git ") { break }
                if line.hasPrefix("\\ No newline") {
                    index += 1
                    continue
                }
                // Inside a hunk body every `+`/`-` line is an addition or a
                // deletion. The file-header lines (`+++ b/f`, `--- a/f`) come
                // before the first `@@` and never reach here, which is why
                // there is no guard against them: addition content that reads
                // as `++ foo` arrives as `+++ foo` and must not be dropped.
                if line.hasPrefix("+") {
                    hunkLines.append(ParsedDiffLine(
                        kind: .addition,
                        oldLineNumber: nil,
                        newLineNumber: newLineNumber,
                        content: String(line.dropFirst())
                    ))
                    newLineNumber += 1
                } else if line.hasPrefix("-") {
                    hunkLines.append(ParsedDiffLine(
                        kind: .deletion,
                        oldLineNumber: oldLineNumber,
                        newLineNumber: nil,
                        content: String(line.dropFirst())
                    ))
                    oldLineNumber += 1
                } else if line.hasPrefix(" ") {
                    hunkLines.append(ParsedDiffLine(
                        kind: .context,
                        oldLineNumber: oldLineNumber,
                        newLineNumber: newLineNumber,
                        content: String(line.dropFirst())
                    ))
                    oldLineNumber += 1
                    newLineNumber += 1
                }
                index += 1
            }

            blocks.append(.hunk(id: "hunk-\(hunkIndex)", header: String(header), lines: hunkLines))
            previousOldEnd = oldLineNumber - 1
            hunkIndex += 1
        }

        // A capped diff loses whole trailing hunks, and every line the parser
        // skipped is invisible by construction. Emit the loss as a block so
        // the surface can say so instead of drawing a confidently incomplete
        // diff.
        if let dropped = droppedBytes(in: content) {
            blocks.append(.truncated(id: "truncated", droppedBytes: dropped))
        }
        return blocks
    }

    /// `@@ -12,7 +12,9 @@ trailing` → the two starts. Hand-scanned rather
    /// than matched with `NSRegularExpression`: this runs once per line of a
    /// diff that can be thousands of lines long, and a regex object per line
    /// is the whole cost of parsing.
    private static func hunkRange(_ line: Substring) -> (oldStart: Int, newStart: Int)? {
        guard line.hasPrefix("@@ -") else { return nil }
        var cursor = line.index(line.startIndex, offsetBy: 4)
        guard let oldStart = scanInt(line, &cursor) else { return nil }
        skipCount(line, &cursor)
        guard cursor < line.endIndex, line[cursor] == " " else { return nil }
        cursor = line.index(after: cursor)
        guard cursor < line.endIndex, line[cursor] == "+" else { return nil }
        cursor = line.index(after: cursor)
        guard let newStart = scanInt(line, &cursor) else { return nil }
        skipCount(line, &cursor)
        guard cursor < line.endIndex, line[cursor] == " " else { return nil }
        cursor = line.index(after: cursor)
        guard line[cursor...].hasPrefix("@@") else { return nil }
        return (oldStart, newStart)
    }

    private static func scanInt(_ line: Substring, _ cursor: inout Substring.Index) -> Int? {
        let start = cursor
        while cursor < line.endIndex, line[cursor].isNumber {
            cursor = line.index(after: cursor)
        }
        guard start < cursor else { return nil }
        return Int(line[start..<cursor])
    }

    /// The optional `,7` after a start. Absent means one line, which the
    /// parser never needs to know — it walks the body instead.
    private static func skipCount(_ line: Substring, _ cursor: inout Substring.Index) {
        guard cursor < line.endIndex, line[cursor] == "," else { return }
        cursor = line.index(after: cursor)
        while cursor < line.endIndex, line[cursor].isNumber {
            cursor = line.index(after: cursor)
        }
    }

    /// The marker `cap_diff` appends in `src-tauri/src/review/git_review.rs`.
    /// Keep in sync with the one in `diff.ts`.
    private static func droppedBytes(in content: String) -> Int? {
        guard let markerStart = content.range(of: "[diff truncated at ", options: .backwards) else {
            return nil
        }
        let tail = content[markerStart.upperBound...]
        guard let droppedRange = tail.range(of: "bytes; dropped ") else { return nil }
        var cursor = droppedRange.upperBound
        let start = cursor
        while cursor < tail.endIndex, tail[cursor].isNumber {
            cursor = tail.index(after: cursor)
        }
        guard start < cursor, tail[cursor...].hasPrefix(" bytes]") else { return nil }
        return Int(tail[start..<cursor])
    }
}
