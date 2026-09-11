import Foundation

/// "adams-macbook-pro.taildece7e.ts.net" → "MacBook Pro".
///
/// The tailnet hostname is the Mac's own name, lowercased and hyphenated, with
/// the owner's name in front more often than not. The header wants the machine,
/// not the possessive, in Apple's casing.
enum MacName {
    private static let words: [String: String] = [
        "macbook": "MacBook", "imac": "iMac", "mac": "Mac", "pro": "Pro", "air": "Air",
        "mini": "Mini", "studio": "Studio"
    ]

    static func from(host: String?) -> String {
        guard let host, let label = host.split(separator: ".").first else { return "Mac" }
        let parts = label.split(separator: "-").map(String.init)
        // Everything from the first product word on; the owner's name precedes it.
        guard let start = parts.firstIndex(where: { words[$0.lowercased()] != nil }) else { return "Mac" }
        let named = parts[start...].compactMap { words[$0.lowercased()] }
        return named.isEmpty ? "Mac" : named.joined(separator: " ")
    }
}
