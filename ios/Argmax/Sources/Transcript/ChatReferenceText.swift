import Foundation

/// Chat references in a queued message, for one-line display.
///
/// The desktop composer writes a chat it attached as
/// `[title](argmax://chat/<session id>?v=1)` and that string is the message
/// (see src/renderer/lib/composerContext.ts). The phone does not draw chips, so
/// the queue row reads the reference as its title; the message that is edited or
/// sent still carries the link. The grammar is the composer's: a bracketed title
/// of 1 to 120 UTF-16 units (JavaScript's count, not ICU's code points), an id
/// of up to 64 of `A-Za-z0-9_-` ending at `?` or `)`, a `v` that is exactly `1`
/// or absent, and an `e`, when present, that is a valid id. Anything else stays
/// as written.
enum ChatReferenceText {
    private static let reference = try! NSRegularExpression(
        pattern: #"\[([^\[\]\n]+)\]\(argmax://chat/[A-Za-z0-9_-]{1,64}(?:\?([A-Za-z0-9_=&.-]*))?\)"#
    )

    static func titlesOnly(_ text: String) -> String {
        guard text.contains("argmax://chat/") else { return text }
        let source = text as NSString
        var result = ""
        var cursor = 0
        for match in reference.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            let query = match.range(at: 2).location == NSNotFound
                ? nil
                : source.substring(with: match.range(at: 2))
            let title = source.substring(with: match.range(at: 1))
            guard title.utf16.count <= 120, queryIsReadable(query) else { continue }
            result += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
            result += title
            cursor = match.range.location + match.range.length
        }
        return result + source.substring(from: cursor)
    }

    /// The first `v` wins and must be `1` (or absent); the first `e` must be an id.
    private static func queryIsReadable(_ query: String?) -> Bool {
        guard let query else { return true }
        var versionSeen = false
        var eventSeen = false
        for pair in query.split(separator: "&", omittingEmptySubsequences: false) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            let value = parts.count == 2 ? String(parts[1]) : ""
            if parts.first == "v", !versionSeen {
                versionSeen = true
                if value != "1" { return false }
            } else if parts.first == "e", !eventSeen {
                eventSeen = true
                if value.isEmpty || value.utf8.count > 64 || value.contains(where: { !isIdCharacter($0) }) {
                    return false
                }
            }
        }
        return true
    }

    private static func isIdCharacter(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-")
    }
}
