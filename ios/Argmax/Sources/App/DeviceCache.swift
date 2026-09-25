import CryptoKit
import Foundation
import OSLog

/// Disposable, pairing-scoped content. All disk I/O and coding run on this actor.
/// Mutation recovery uses a durable journal instead of this evictable cache.
actor DeviceCache {
    static let shared = DeviceCache()
    private let directory: URL
    private let byteLimit: Int
    private let entryLimit: Int
    private let maximumAge: TimeInterval
    private static let log = Logger(subsystem: "com.argmax.remote", category: "cache")

    init(directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("argmax-content-v1", isDirectory: true),
         byteLimit: Int = 32 * 1_024 * 1_024, entryLimit: Int = 32,
         maximumAge: TimeInterval = 7 * 24 * 60 * 60) {
        self.directory = directory
        self.byteLimit = byteLimit
        self.entryLimit = entryLimit
        self.maximumAge = maximumAge
    }

    private func url(scope: String, key: String) -> URL {
        let digest = SHA256.hash(data: Data((scope + "\u{0}" + key).utf8))
            .map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(digest).appendingPathExtension("json")
    }

    func read<T: Decodable & Sendable>(_ type: T.Type, scope: String, key: String) -> T? {
        let file = url(scope: scope, key: key)
        do {
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            guard let size = values.fileSize, size <= byteLimit / 2,
                  let date = values.contentModificationDate,
                  Date().timeIntervalSince(date) <= maximumAge else {
                try FileManager.default.removeItem(at: file)
                return nil
            }
            return try NativePerformance.measure("Content cache decode") {
                try JSONDecoder().decode(type, from: Data(contentsOf: file))
            }
        } catch {
            if FileManager.default.fileExists(atPath: file.path) {
                Self.log.notice("Discarding unreadable content cache")
                try? FileManager.default.removeItem(at: file)
            }
            return nil
        }
    }

    func write<T: Encodable & Sendable>(_ value: T, scope: String, key: String) {
        do {
            write(encoded: try JSONEncoder().encode(value), scope: scope, key: key)
        } catch {
            Self.log.error("Content cache encode failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// A value its owner already encoded, to size it, so it is not encoded twice.
    func write(encoded data: Data, scope: String, key: String) {
        do {
            guard data.count <= byteLimit / 2 else { return }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: url(scope: scope, key: key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            try trim()
        } catch {
            Self.log.error("Content cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func remove(scope: String, key: String) {
        try? FileManager.default.removeItem(at: url(scope: scope, key: key))
    }

    private func trim() throws {
        let files = try FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
        let entries = try files.map { file in
            (file, try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]))
        }.sorted { ($0.1.contentModificationDate ?? .distantPast) > ($1.1.contentModificationDate ?? .distantPast) }
        var bytes = 0
        for (index, entry) in entries.enumerated() {
            bytes += entry.1.fileSize ?? 0
            if index >= entryLimit || bytes > byteLimit {
                try FileManager.default.removeItem(at: entry.0)
            }
        }
    }
}
