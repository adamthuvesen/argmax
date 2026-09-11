import Foundation

struct TranscriptMarkdownKey: Hashable, Sendable {
    let text: String
    let workspacePath: String?
    let isThinking: Bool
}

/// Reuse completed prose across row mounts while preparing changed text away from SwiftUI.
@MainActor
final class TranscriptMarkdownCache {
    static let shared = TranscriptMarkdownCache()
    private final class Entry: NSObject {
        let document: TranscriptMarkdownDocument
        init(_ document: TranscriptMarkdownDocument) { self.document = document }
    }
    private let documents = NSCache<NSString, Entry>()
    private var pending: [TranscriptMarkdownKey: Task<TranscriptMarkdownDocument, Never>] = [:]

    init() {
        documents.totalCostLimit = 12 * 1_024 * 1_024
        documents.countLimit = 128
    }

    private func cacheKey(_ key: TranscriptMarkdownKey) -> NSString {
        // Length prefixes keep embedded delimiters in prose or paths unambiguous.
        "\(key.workspacePath?.utf8.count ?? 0):\(key.workspacePath ?? ""):\(key.isThinking):\(key.text)" as NSString
    }

    func cached(_ key: TranscriptMarkdownKey) -> TranscriptMarkdownDocument? {
        documents.object(forKey: cacheKey(key))?.document
    }

    /// Prepare away from the main actor, for rows about to paint; hand the
    /// result to `store` before they do.
    nonisolated static func prepare(_ keys: [TranscriptMarkdownKey]) -> [(TranscriptMarkdownKey, TranscriptMarkdownDocument)] {
        keys.map { key in
            (key, NativePerformance.measure("Markdown preparation") {
                TranscriptMarkdownDocument(markdown: key.text,
                    workspacePath: key.workspacePath, isThinking: key.isThinking)
            })
        }
    }

    func store(_ prepared: [(TranscriptMarkdownKey, TranscriptMarkdownDocument)]) {
        for (key, value) in prepared where cached(key) == nil {
            documents.setObject(Entry(value), forKey: cacheKey(key), cost: key.text.utf8.count * 4 + 512)
        }
    }

    func document(_ key: TranscriptMarkdownKey) async throws -> TranscriptMarkdownDocument {
        while pending.count >= 2, pending[key] == nil {
            try await Task.sleep(for: .milliseconds(5))
        }
        try Task.checkCancellation()
        if let value = cached(key) { return value }
        if let task = pending[key] { return await task.value }
        let task = Task.detached(priority: .userInitiated) {
            NativePerformance.measure("Markdown preparation") {
                TranscriptMarkdownDocument(markdown: key.text,
                    workspacePath: key.workspacePath, isThinking: key.isThinking)
            }
        }
        pending[key] = task
        let value = await task.value
        pending[key] = nil
        documents.setObject(Entry(value), forKey: cacheKey(key), cost: key.text.utf8.count * 4 + 512)
        return value
    }
}
