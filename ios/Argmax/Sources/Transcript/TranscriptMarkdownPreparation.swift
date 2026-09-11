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

    private static func replacingInlineMath(
        in line: String,
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
            if line[cursor] == "$", (cursor == line.startIndex || line[line.index(before: cursor)] != "\\") {
                let bodyStart = line.index(after: cursor)
                if let end = unescapedDollar(after: bodyStart, in: line) {
                    let body = String(line[bodyStart..<end])
                    if !looksLikeCurrency(body) {
                        let key = marker()
                        math[key] = TranscriptMath(source: body, display: false)
                        output += key
                        cursor = line.index(after: end)
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
            if text[cursor] == "$", text[text.index(before: cursor)] != "\\" { return cursor }
            cursor = text.index(after: cursor)
        }
        return nil
    }

    private static func looksLikeCurrency(_ value: String) -> Bool {
        guard value.first?.isNumber == true else { return false }
        return value.rangeOfCharacter(from: CharacterSet(charactersIn: "+-=*/^\\")) == nil &&
            value.rangeOfCharacter(from: .whitespaces) != nil
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
