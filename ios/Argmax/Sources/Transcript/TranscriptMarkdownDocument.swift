import Foundation

enum TranscriptMarkdownBlock: Sendable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case listItem(ordinal: Int?, depth: Int, AttributedString)
    case quote(AttributedString)
    case code(language: String?, source: String)
    case table(TranscriptTable)
    case image(TranscriptMarkdownImageSource)
    case math(source: String, display: Bool)
    case thematicBreak
}

enum TranscriptInlinePiece: Sendable {
    case text(AttributedString)
    case math(TranscriptMath)
}

struct TranscriptMath: Sendable {
    let source: String
    let display: Bool
}

struct TranscriptMarkdownDocument: Sendable {
    let blocks: [TranscriptMarkdownBlock]
    let math: [String: TranscriptMath]

    init(markdown: String, workspacePath: String? = nil, isThinking: Bool = false) {
        let prepared = TranscriptMarkdownPreparation(markdown: markdown)
        math = prepared.math
        guard var attributed = try? AttributedString(
            markdown: prepared.markdown,
            options: .init(interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        ) else {
            blocks = [.paragraph(AttributedString(markdown))]
            return
        }
        Self.linkInlineFileReferences(in: &attributed)
        if isThinking {
            for run in Array(attributed.runs) {
                var intent = run.inlinePresentationIntent
                intent?.remove(.stronglyEmphasized)
                attributed[run.range].inlinePresentationIntent = intent
            }
        }

        var parsed: [TranscriptMarkdownBlock] = []
        var previousIdentity: Int?
        for run in attributed.runs {
            var content = AttributedString(attributed[run.range])
            if let link = run.link, Self.isLocalLink(link) {
                let label = String(content.characters)
                let relative = TranscriptProjection.relativePath(label, workspacePath: workspacePath)
                if relative != label { content = AttributedString(relative, attributes: run.attributes) }
            }
            guard let intent = run.presentationIntent else {
                Self.append(content, as: .paragraph, merge: false, to: &parsed)
                previousIdentity = nil
                continue
            }
            let components = intent.components
            let leaf = components.first
            let identity = leaf?.identity
            let merge = identity == previousIdentity
            let quote = components.contains { if case .blockQuote = $0.kind { true } else { false } }
            let listDepth = components.filter {
                switch $0.kind { case .orderedList, .unorderedList: return true; default: return false }
            }.count
            let isOrdered = components.contains {
                if case .orderedList = $0.kind { return true }
                return false
            }
            let ordinal = isOrdered ? components.compactMap { component -> Int? in
                if case .listItem(let value) = component.kind { return value }
                return nil
            }.first : nil

            let marker = String(content.characters)
            if let lifted = prepared.lifted[marker] {
                parsed.append(lifted)
                previousIdentity = identity
                continue
            }
            if quote {
                Self.append(content, as: .quote, merge: merge, to: &parsed)
            } else if listDepth > 0 {
                Self.append(content, as: .listItem(ordinal: ordinal, depth: listDepth), merge: merge, to: &parsed)
            } else if let leaf {
                switch leaf.kind {
                case .header(let level): Self.append(content, as: .heading(level: level), merge: merge, to: &parsed)
                case .codeBlock(let language):
                    Self.append(content, as: .code(language: language), merge: merge, to: &parsed)
                case .thematicBreak: parsed.append(.thematicBreak)
                default: Self.append(content, as: .paragraph, merge: merge, to: &parsed)
                }
            } else {
                Self.append(content, as: .paragraph, merge: merge, to: &parsed)
            }
            previousIdentity = identity
        }
        blocks = parsed
    }

    private enum BlockShape {
        case paragraph, heading(level: Int), quote
        case listItem(ordinal: Int?, depth: Int)
        case code(language: String?)
    }

    private static func append(
        _ content: AttributedString,
        as shape: BlockShape,
        merge: Bool,
        to blocks: inout [TranscriptMarkdownBlock]
    ) {
        // Inline emphasis and links split Foundation runs. Coalesce runs with
        // the same presentation shape back into one selectable text block.
        if merge, !blocks.isEmpty {
            switch (shape, blocks[blocks.count - 1]) {
            case (.paragraph, .paragraph(var current)):
                current.append(content); blocks[blocks.count - 1] = .paragraph(current); return
            case (.heading(let level), .heading(let previousLevel, var current)) where level == previousLevel:
                current.append(content); blocks[blocks.count - 1] = .heading(level: level, current); return
            case (.quote, .quote(var current)):
                current.append(content); blocks[blocks.count - 1] = .quote(current); return
            case (.listItem(let ordinal, let depth), .listItem(let previousOrdinal, let previousDepth, var current))
                where ordinal == previousOrdinal && depth == previousDepth:
                current.append(content); blocks[blocks.count - 1] = .listItem(ordinal: ordinal, depth: depth, current); return
            case (.code(let language), .code(let previousLanguage, let current)) where language == previousLanguage:
                blocks[blocks.count - 1] = .code(language: language, source: current + String(content.characters)); return
            default: break
            }
        }
        switch shape {
        case .paragraph: blocks.append(.paragraph(content))
        case .heading(let level): blocks.append(.heading(level: level, content))
        case .quote: blocks.append(.quote(content))
        case .listItem(let ordinal, let depth):
            blocks.append(.listItem(ordinal: ordinal, depth: depth, content))
        case .code(let language): blocks.append(.code(language: language, source: String(content.characters)))
        }
    }

    static func inlinePieces(
        _ attributed: AttributedString,
        math: [String: TranscriptMath]
    ) -> [TranscriptInlinePiece] {
        let characters = String(attributed.characters)
        var pieces: [TranscriptInlinePiece] = []
        var cursor = characters.startIndex
        while let start = characters[cursor...].range(of: TranscriptMarkdownPreparation.mathPrefix) {
            if start.lowerBound > cursor {
                pieces.append(.text(slice(attributed, characterRange: cursor..<start.lowerBound, in: characters)))
            }
            guard let end = characters[start.upperBound...].firstIndex(of: "\u{E001}") else { break }
            let key = String(characters[start.lowerBound...end])
            if let item = math[key] { pieces.append(.math(item)) }
            cursor = characters.index(after: end)
        }
        if cursor < characters.endIndex {
            pieces.append(.text(slice(attributed, characterRange: cursor..<characters.endIndex, in: characters)))
        }
        return pieces.isEmpty ? [.text(attributed)] : pieces
    }

    private static func slice(
        _ attributed: AttributedString,
        characterRange: Range<String.Index>,
        in string: String
    ) -> AttributedString {
        let lower = attributed.characters.index(attributed.startIndex, offsetBy: string.distance(from: string.startIndex, to: characterRange.lowerBound))
        let upper = attributed.characters.index(attributed.startIndex, offsetBy: string.distance(from: string.startIndex, to: characterRange.upperBound))
        return AttributedString(attributed[lower..<upper])
    }

    static func isLocalLink(_ url: URL) -> Bool {
        if let scheme = url.scheme {
            return scheme == "file" || scheme == "argmax-asset" || scheme == "argmax-attachment"
        }
        return url.host == nil && !url.path.isEmpty
    }

    static func isAnchorLink(_ url: URL) -> Bool {
        url.scheme == nil && url.host == nil && url.path.isEmpty && url.fragment != nil
    }

    static func httpsURL(forProtocolRelative url: URL) -> URL? {
        guard url.scheme == nil, url.host != nil else { return nil }
        return URL(string: "https:\(url.relativeString)")
    }

    static func localPath(from url: URL) -> String {
        let path: String
        if url.scheme == "file" {
            path = url.path
        } else if url.scheme == "argmax-asset" || url.scheme == "argmax-attachment" {
            path = "/" + url.pathComponents.filter { $0 != "/" && $0 != "file" }.joined(separator: "/")
        } else {
            var relative = url.relativeString
            if let fragment = url.fragment, Self.isLineFragment(fragment),
               relative.hasSuffix("#\(fragment)") {
                relative.removeLast(fragment.count + 1)
            }
            path = relative.removingPercentEncoding ?? relative
        }
        return Self.removingLineSuffix(from: path)
    }

    static func inlineFilePath(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (3...200).contains(trimmed.count), !trimmed.contains(" ") else { return nil }
        let path = Self.removingLineSuffix(from: trimmed)
        guard let first = path.utf8.first, Self.isPathByte(first, first: true),
              path.utf8.allSatisfy({ Self.isPathByte($0, first: false) }),
              let dot = path.lastIndex(of: ".")
        else { return nil }
        let suffix = path[path.index(after: dot)...]
        guard (1...5).contains(suffix.count), suffix.utf8.allSatisfy(Self.isAlphaNumeric) else { return nil }
        return path
    }

    private static func linkInlineFileReferences(in attributed: inout AttributedString) {
        let references = attributed.runs.compactMap { run -> (Range<AttributedString.Index>, URL)? in
            guard run.link == nil,
                  run.inlinePresentationIntent?.contains(.code) == true,
                  let path = Self.inlineFilePath(String(attributed[run.range].characters)),
                  let url = URL(string: path)
            else { return nil }
            return (run.range, url)
        }
        for (range, url) in references {
            attributed[range].link = url
        }
    }

    private static func removingLineSuffix(from value: String) -> String {
        guard let colon = value.lastIndex(of: ":") else { return value }
        let suffix = value[value.index(after: colon)...]
        guard (1...7).contains(suffix.count), suffix.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
            return value
        }
        return String(value[..<colon])
    }

    private static func isLineFragment(_ fragment: String) -> Bool {
        guard fragment.count >= 2, fragment.count <= 8,
              fragment.first == "L" || fragment.first == "l"
        else { return false }
        return fragment.dropFirst().utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
    }

    private static func isPathByte(_ byte: UInt8, first: Bool) -> Bool {
        if Self.isAlphaNumeric(byte) || byte == 95 || byte == 47 || byte == 64 || byte == 45 { return true }
        return !first && byte == 46
    }

    private static func isAlphaNumeric(_ byte: UInt8) -> Bool {
        (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
    }
}
