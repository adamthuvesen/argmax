import UIKit

// The attributed string behind every code surface on the phone: a file's diff,
// and a file's text.
//
// Both are the same shape — a gutter of line numbers, then the line — so they
// are one builder. Nothing here is coloured by grammar: see the note on
// `Theme.diffAddLineColor` for why a diff's only colour is its wash.

/// What a code surface is showing, and the identity that decides when the
/// string behind it has to be built again.
struct CodeDocument: Sendable {
    enum Content: Sendable {
        /// A parsed unified diff, blocks in draw order.
        case diff([ParsedDiffBlock])
        /// A whole file, numbered from one.
        case file(String)
    }

    let content: Content
    /// Cheap to compare, and distinct whenever the string would differ: the
    /// path, plus whatever else changes the bytes (the scope and the context
    /// rung for a diff).
    let key: String

    struct Built: @unchecked Sendable {
        // Builders return an immutable copy with immutable attributes. No view/layout crosses executors.
        let string: NSAttributedString
        let gutterWidth: CGFloat
    }

    func build(font: UIFont) -> Built {
        switch content {
        case .diff(let blocks): return Self.buildDiff(blocks, font: font)
        case .file(let text): return Self.buildFile(text, font: font)
        }
    }

    // MARK: - Diff

    private static func buildDiff(_ blocks: [ParsedDiffBlock], font: UIFont) -> Built {
        let digits = blocks.reduce(1) { widest, block in
            guard case .hunk(_, _, let lines) = block else { return widest }
            return lines.reduce(widest) { max($0, digitCount($1.displayLineNumber)) }
        }
        let gutterWidth = CodeMetrics.gutterWidth(font: font, digits: digits)
        let body = paragraphStyle(hangingAt: gutterWidth, font: font)
        // Markers and hunk headers start on the code column rather than in
        // the gutter, so the gutter reads as one unbroken strip down the
        // screen instead of a ladder with rungs missing.
        let aside = paragraphStyle(hangingAt: gutterWidth, font: font, indent: gutterWidth)
        let output = NSMutableAttributedString()

        for block in blocks {
            switch block {
            case .hunk(_, let header, let lines):
                // The header carries git's own `@@ -1,7 +1,9 @@` plus the
                // enclosing function, which is the one piece of context worth
                // its line on a screen this size.
                output.append(NSAttributedString(string: header + "\n", attributes: [
                    .font: font,
                    .foregroundColor: Theme.mutedColor,
                    .paragraphStyle: aside,
                    .codeWash: Theme.raisedColor,
                    .codeGutterWash: Theme.raisedColor
                ]))
                for line in lines {
                    output.append(diffLine(line, font: font, digits: digits, style: body))
                }
            case .omitted(_, let count):
                output.append(marker(
                    "⋯  \(count) unmodified line\(count == 1 ? "" : "s")",
                    font: font,
                    style: aside
                ))
            case .truncated(_, let droppedBytes):
                // Never silently: a capped diff has whole hunks missing, and
                // a screen that does not say so is a confidently wrong one.
                output.append(marker(
                    "Diff too large to show in full — \(formatBytes(droppedBytes)) of changes "
                        + "were dropped. Open the file to see the rest.",
                    font: font,
                    style: aside,
                    tint: Theme.amberColor
                ))
            }
        }
        return Built(string: NSAttributedString(attributedString: output), gutterWidth: gutterWidth)
    }

    private static func diffLine(
        _ line: ParsedDiffLine,
        font: UIFont,
        digits: Int,
        style: NSParagraphStyle
    ) -> NSAttributedString {
        let number = line.displayLineNumber.map(String.init) ?? ""
        let gutter = " " + String(repeating: " ", count: max(0, digits - number.count)) + number + " "
        let marker: String
        let wash: UIColor?
        let gutterWash: UIColor
        let numberInk: UIColor
        switch line.kind {
        case .addition:
            marker = "+"
            wash = Theme.diffAddLineColor
            gutterWash = Theme.diffAddGutterColor
            numberInk = Theme.diffAddInkColor
        case .deletion:
            marker = "-"
            wash = Theme.diffDelLineColor
            gutterWash = Theme.diffDelGutterColor
            numberInk = Theme.diffDelInkColor
        case .context:
            marker = " "
            wash = nil
            gutterWash = Theme.raisedColor
            numberInk = Theme.mutedColor
        }

        var lineAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .paragraphStyle: style,
            .codeGutterWash: gutterWash
        ]
        if let wash { lineAttributes[.codeWash] = wash }

        let output = NSMutableAttributedString()
        output.append(NSAttributedString(
            string: gutter,
            attributes: lineAttributes.merging([.foregroundColor: numberInk]) { _, new in new }
        ))
        // The `+`/`-` is not decoration: it is what survives a screenshot, a
        // colour-blind reader, and a copy-paste out of the selection.
        output.append(NSAttributedString(
            string: marker + " " + line.content + "\n",
            attributes: lineAttributes.merging([.foregroundColor: Theme.inkColor]) { _, new in new }
        ))
        return output
    }

    // MARK: - File

    private static func buildFile(_ text: String, font: UIFont) -> Built {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        // A file that ends in a newline splits to a trailing empty element,
        // which is not a line anyone numbered.
        let count = lines.count > 1 && lines.last?.isEmpty == true ? lines.count - 1 : lines.count
        let digits = digitCount(max(count, 1))
        let gutterWidth = CodeMetrics.gutterWidth(font: font, digits: digits)
        let style = paragraphStyle(hangingAt: gutterWidth, font: font)
        let output = NSMutableAttributedString()
        for index in 0..<count {
            let number = String(index + 1)
            let gutter = " " + String(repeating: " ", count: digits - number.count) + number + " "
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .paragraphStyle: style,
                .codeGutterWash: Theme.raisedColor
            ]
            output.append(NSAttributedString(
                string: gutter,
                attributes: attributes.merging([.foregroundColor: Theme.mutedColor]) { _, new in new }
            ))
            output.append(NSAttributedString(
                string: String(lines[index]) + "\n",
                attributes: attributes.merging([.foregroundColor: Theme.inkColor]) { _, new in new }
            ))
        }
        return Built(string: NSAttributedString(attributedString: output), gutterWidth: gutterWidth)
    }

    // MARK: - Shared

    /// Wrapped lines hang under the code column so a long line still reads as
    /// one line rather than as a second row starting in the gutter.
    private static func paragraphStyle(
        hangingAt indent: CGFloat,
        font: UIFont,
        indent firstLine: CGFloat = 0
    ) -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.headIndent = indent
        style.firstLineHeadIndent = firstLine
        style.lineBreakMode = .byCharWrapping
        // 1.35, a touch tighter than the desktop's 1.65: a phone's lines are
        // short and its screen is not, so the leading that opens a wide diff
        // up only costs rows here.
        style.lineHeightMultiple = 1.0
        style.minimumLineHeight = ceil(font.lineHeight * 1.35)
        style.maximumLineHeight = ceil(font.lineHeight * 1.35)
        return style
    }

    private static func marker(
        _ text: String,
        font: UIFont,
        style: NSParagraphStyle,
        tint: UIColor = Theme.mutedColor
    ) -> NSAttributedString {
        NSAttributedString(string: text + "\n", attributes: [
            .font: font,
            .foregroundColor: tint,
            .paragraphStyle: style,
            .codeWash: Theme.raisedColor
        ])
    }

    private static func digitCount(_ value: Int?) -> Int {
        guard let value, value > 0 else { return 1 }
        return String(value).count
    }

    /// `src/renderer/lib/formatBytes.ts`, ported so the truncation notice
    /// quotes the same number on both clients.
    static func formatBytes(_ bytes: Int) -> String {
        guard bytes > 0 else { return "0 B" }
        let units = ["B", "KB", "MB", "GB"]
        var value = Double(bytes)
        var unit = 0
        while value >= 1024, unit < units.count - 1 {
            value /= 1024
            unit += 1
        }
        if unit == 0 { return "\(Int(value.rounded())) B" }
        return value >= 100
            ? String(format: "%.0f %@", value, units[unit])
            : String(format: "%.1f %@", value, units[unit])
    }
}
