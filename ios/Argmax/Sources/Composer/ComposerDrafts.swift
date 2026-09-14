import CryptoKit
import Foundation

/// Drafts are user input, so they survive content-cache eviction and network loss.
actor ComposerDrafts {
    static let shared = ComposerDrafts()
    private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory,
            in: .userDomainMask)[0].appendingPathComponent("argmax-drafts-v1", isDirectory: true)
    }

    private func file(scope: String, sessionID: String) -> URL {
        let key = SHA256.hash(data: Data((scope + "\u{0}" + sessionID).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key)
    }

    func read(scope: String, sessionID: String) throws -> String {
        let url = file(scope: scope, sessionID: sessionID)
        guard FileManager.default.fileExists(atPath: url.path) else { return "" }
        return try String(contentsOf: url, encoding: .utf8)
    }

    func write(_ text: String, scope: String, sessionID: String) throws {
        let url = file(scope: scope, sessionID: sessionID)
        if text.isEmpty {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        } else {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
