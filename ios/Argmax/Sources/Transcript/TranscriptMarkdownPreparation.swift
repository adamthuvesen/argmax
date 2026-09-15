import Foundation

struct TranscriptMarkdownPreparation {
    static let blockPrefix = "\u{E000}ARGMAX_BLOCK_"
    static let mathPrefix = "\u{E000}ARGMAX_MATH_"

    let markdown: String
    let lifted: [String: TranscriptMarkdownBlock]
    let math: [String: TranscriptMath]

    init(markdown source: String) {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var output: [String] = []
        var lifted: [String: TranscriptMarkdownBlock] = [:]
        var math: [String: TranscriptMath] = [:]
        var mathIndex = 0
        var index = 0
        var inFence: Character?

        func blockMarker() -> String { "\(Self.blockPrefix)\(lifted.count)\u{E001}" }
        func mathMarker() -> String {
            defer { mathIndex += 1 }
            return "\(Self.mathPrefix)\(mathIndex)\u{E001}"
        }
        func appendLifted(_ marker: String) {
            if output.last?.isEmpty == false { output.append("") }
            output.append(marker)
            output.append("")
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let fence = Self.fenceCharacter(trimmed) {
                if inFence == fence { inFence = nil } else if inFence == nil { inFence = fence }
                output.append(line)
                index += 1
                continue
            }
            if inFence != nil {
                output.append(line)
                index += 1
                continue
            }

            if let display = Self.displayMath(startingAt: index, lines: lines) {
                let marker = blockMarker()
                lifted[marker] = .math(source: display.source, display: true)
                appendLifted(marker)
                index = display.nextIndex
                continue
            }
            if let table = TranscriptTable.parse(startingAt: index, lines: lines) {
                let marker = blockMarker()
                lifted[marker] = .table(table.table)
                appendLifted(marker)
                index = table.nextIndex
                continue
            }
            if let image = TranscriptMarkdownImageSource(markdownLine: trimmed) {
                let marker = blockMarker()
                lifted[marker] = .image(image)
                appendLifted(marker)
                index += 1
                continue
            }

            output.append(Self.replacingInlineMath(in: line, math: &math, marker: mathMarker))
            index += 1
        }
        self.markdown = output.joined(separator: "\n")
        self.lifted = lifted
        self.math = math
    }

    private static func fenceCharacter(_ line: String) -> Character? {
        guard let first = line.first, first == "`" || first == "~" else { return nil }
        return line.prefix { $0 == first }.count >= 3 ? first : nil
    }

    private static func displayMath(
        startingAt index: Int,
        lines: [String]
    ) -> (source: String, nextIndex: Int)? {
        let first = lines[index].trimmingCharacters(in: .whitespaces)
        if first.hasPrefix("$$") {
            if first.count > 4, first.hasSuffix("$$") {
                return (String(first.dropFirst(2).dropLast(2)).trimmingCharacters(in: .whitespaces), index + 1)
            }
            var body: [String] = first.count > 2 ? [String(first.dropFirst(2))] : []
            var cursor = index + 1
            while cursor < lines.count {
                let line = lines[cursor]
                if let close = line.range(of: "$$") {
                    body.append(String(line[..<close.lowerBound]))
                    return (body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), cursor + 1)
                }
                body.append(line)
                cursor += 1
            }
            return nil
        }
        if first.hasPrefix("\\[") {
            var body = [String(first.dropFirst(2))]
            var cursor = index
            while cursor < lines.count {
                if let close = body[body.count - 1].range(of: "\\]") {
                    body[body.count - 1] = String(body[body.count - 1][..<close.lowerBound])
                    return (body.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), cursor + 1)
                }
                cursor += 1
                if cursor < lines.count { body.append(lines[cursor]) }
            }
        }
        if first.hasPrefix("\\begin{") {
            guard let nameEnd = first.firstIndex(of: "}") else { return nil }
            let name = String(first[first.index(first.startIndex, offsetBy: 7)..<nameEnd])
            let close = "\\end{\(name)}"
            var body: [String] = []
            var cursor = index
            while cursor < lines.count {
                body.append(lines[cursor])
                if lines[cursor].contains(close) {
                    return (body.joined(separator: "\n"), cursor + 1)
                }
                cursor += 1
            }
        }
        return nil
    }

    /// Splits the line into code spans and prose, so a `$` inside `` `export FOO=$BAR` ``
    /// or `` `^a$` `` can never open math or close it.
    private static func replacingInlineMath(
        in line: String,
        math: inout [String: TranscriptMath],
        marker: () -> String
    ) -> String {
        var output = ""
        var cursor = line.startIndex
        var proseStart = cursor
        while cursor < line.endIndex {
            guard line[cursor] == "`", let spanEnd = codeSpanEnd(at: cursor, in: line) else {
                cursor = line.index(after: cursor)
                continue
            }
            output += replacingInlineMathInProse(String(line[proseStart..<cursor]), math: &math, marker: marker)
            output += line[cursor..<spanEnd]
            cursor = spanEnd
            proseStart = cursor
        }
        output += replacingInlineMathInProse(String(line[proseStart...]), math: &math, marker: marker)
        return output
    }

    /// End index of a complete CommonMark code span: an opening backtick run closed
    /// by a run of exactly the same length. Returns nil for an unclosed run.
    private static func codeSpanEnd(at start: String.Index, in line: String) -> String.Index? {
        var openEnd = start
        while openEnd < line.endIndex, line[openEnd] == "`" { openEnd = line.index(after: openEnd) }
        let fence = line.distance(from: start, to: openEnd)
        var cursor = openEnd
        while cursor < line.endIndex {
            guard line[cursor] == "`" else {
                cursor = line.index(after: cursor)
                continue
            }
            var closeEnd = cursor
            while closeEnd < line.endIndex, line[closeEnd] == "`" { closeEnd = line.index(after: closeEnd) }
            if line.distance(from: cursor, to: closeEnd) == fence { return closeEnd }
            cursor = closeEnd
        }
        return nil
    }

    private static func replacingInlineMathInProse(
        _ line: String,
        math: inout [String: TranscriptMath],
        marker: () -> String
    ) -> String {
        var output = ""
        var cursor = line.startIndex
        while cursor < line.endIndex {
            if line[cursor...].hasPrefix("\\(") {
                let bodyStart = line.index(cursor, offsetBy: 2)
                if let end = line[bodyStart...].range(of: "\\)")?.lowerBound {
                    let key = marker()
                    math[key] = TranscriptMath(source: String(line[bodyStart..<end]).trimmingCharacters(in: .whitespaces), display: false)
                    output += key
                    cursor = line.index(end, offsetBy: 2)
                    continue
                }
            }
            if line[cursor] == "$", cursor == line.startIndex || line[line.index(before: cursor)] != "\\" {
                if line[cursor...].hasPrefix("$$"),
                   let bodyStart = line.index(cursor, offsetBy: 2, limitedBy: line.endIndex),
                   let end = line[bodyStart...].range(of: "$$")?.lowerBound,
                   !String(line[bodyStart..<end]).trimmingCharacters(in: .whitespaces).isEmpty {
                    let key = marker()
                    math[key] = TranscriptMath(source: String(line[bodyStart..<end]).trimmingCharacters(in: .whitespaces), display: false)
                    output += key
                    cursor = line.index(end, offsetBy: 2)
                    continue
                }
                let bodyStart = line.index(after: cursor)
                if let end = unescapedDollar(after: bodyStart, in: line) {
                    let body = String(line[bodyStart..<end])
                    let afterEnd = line.index(after: end)
                    let after = afterEnd < line.endIndex ? line[afterEnd] : nil
                    if isInlineMath(body: body, after: after) {
                        let key = marker()
                        math[key] = TranscriptMath(source: body, display: false)
                        output += key
                        cursor = afterEnd
                        continue
                    }
                }
            }
            if line[cursor] == "\\", let greek = greekCommand(at: cursor, in: line) {
                let key = marker()
                math[key] = TranscriptMath(source: greek.command, display: false)
                output += key
                cursor = greek.end
                continue
            }
            output.append(line[cursor])
            cursor = line.index(after: cursor)
        }
        return output
    }

    private static func unescapedDollar(after start: String.Index, in text: String) -> String.Index? {
        var cursor = start
        while cursor < text.endIndex {
            if text[cursor] == "$", cursor == text.startIndex || text[text.index(before: cursor)] != "\\" {
                return cursor
            }
            cursor = text.index(after: cursor)
        }
        return nil
    }

    /// Characters that make a multi-word `$...$` body read as an equation rather than prose.
    private static let mathSignals = CharacterSet(charactersIn: "0123456789=+-*/^_\\{}<>|")
    /// A digit-leading body closing against one of these is a bracketed aside, not an equation.
    private static let asideOpeners: Set<Character> = ["\\", "(", "[", "{"]

    /// Whether `$body$` is an equation rather than a pair of unrelated dollar signs.
    ///
    /// Mirrors `normalizeMathDelimiters.ts` on the desktop side; keep the two in step.
    /// A prose `$` is nearly always currency (`$1.25/1M in and $4.25`) or a shell
    /// variable (`$PATH and $HOME`), and pairing those swallows the text between them.
    private static func isInlineMath(body: String, after: Character?) -> Bool {
        guard let first = body.first, let last = body.last else { return false }
        guard body.rangeOfCharacter(from: CharacterSet.whitespaces.inverted) != nil else { return false }
        // "$5,$10": a closer running straight into another amount closes nothing.
        if let after, after.isNumber { return false }
        if first.isNumber {
            // "$1.25/1M in and $4.25" and "$50 ($x$ ...)": an amount, not an equation.
            if last.isWhitespace || Self.asideOpeners.contains(last) { return false }
            if let after, after.isLetter || after == "\\" { return false }
            return true
        }
        // "$PATH and $HOME": several words with nothing equation-shaped in them.
        if body.rangeOfCharacter(from: .whitespaces) != nil,
           body.rangeOfCharacter(from: Self.mathSignals) == nil {
            return false
        }
        return true
    }

    private static let greek = Set([
        "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa",
        "lambda", "mu", "nu", "xi", "pi", "rho", "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
        "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"
    ])

    private static func greekCommand(at start: String.Index, in text: String) -> (command: String, end: String.Index)? {
        var end = text.index(after: start)
        while end < text.endIndex, text[end].isLetter { end = text.index(after: end) }
        let name = String(text[text.index(after: start)..<end])
        guard greek.contains(name) else { return nil }
        return ("\\" + name, end)
    }
}
