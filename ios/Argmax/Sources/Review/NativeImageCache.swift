import CryptoKit
import ImageIO
import UIKit

/// Shared by inline and expanded images. Keep useful previews warm without retaining full decodes.
///
/// Originals are downloaded once into Caches and every display size decodes
/// from that file, so the inline preview and the full-screen view of one
/// screenshot cost one transfer, and scrolling back or relaunching costs none.
actor NativeImageCache {
    static let shared = NativeImageCache()
    private let images = NSCache<NSString, UIImage>()
    private var pending: [String: Task<UIImage, Error>] = [:]
    private var downloads: [String: Task<URL, Error>] = [:]
    private let directory: URL

    /// Workspace files can be rewritten in place, so they are kept for as long
    /// as the host's `Cache-Control: max-age` allows. Attachments are
    /// write-once under a fresh id and never go stale.
    private static let workspaceFileLifetime: TimeInterval = 3_600
    private static let diskLimit = 200 * 1_024 * 1_024

    init(directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("images", isDirectory: true)) {
        self.directory = directory
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        images.totalCostLimit = 48 * 1_024 * 1_024
        images.countLimit = 32
    }

    func image(for request: URLRequest, pixels: Int, revision: String = "") async throws -> UIImage {
        let identity = (request.url?.absoluteString ?? "") + "\u{0}"
            + (request.value(forHTTPHeaderField: "Authorization") ?? "") + "\u{0}" + revision
        let original = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        let key = original + "-\(pixels)"
        if let image = images.object(forKey: key as NSString) { return image }
        if let task = pending[key] { return try await task.value }
        let task = Task {
            let file = try await originalFile(for: request, name: original)
            return try await Task.detached(priority: .userInitiated) {
                try NativePerformance.measure("Image thumbnail preparation") {
                    guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                            kCGImageSourceCreateThumbnailFromImageAlways: true,
                            kCGImageSourceCreateThumbnailWithTransform: true,
                            kCGImageSourceShouldCacheImmediately: true,
                            kCGImageSourceThumbnailMaxPixelSize: pixels
                          ] as CFDictionary) else { throw BridgeError.malformedResponse }
                    return UIImage(cgImage: image)
                }
            }.value
        }
        pending[key] = task
        defer { pending[key] = nil }
        let image = try await task.value
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        images.setObject(image, forKey: key as NSString, cost: cost)
        return image
    }

    /// The original on disk, downloading it only when no usable copy is cached.
    private func originalFile(for request: URLRequest, name: String) async throws -> URL {
        let file = directory.appendingPathComponent(name)
        let writeOnce = request.url?.path.hasPrefix("/api/attachments/") == true
        if isUsable(file, writeOnce: writeOnce) {
            // Modification date is the eviction order; creation date the lifetime.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
            return file
        }
        if let task = downloads[name] { return try await task.value }
        let task = Task.detached(priority: .userInitiated) {
            // Download to disk so an oversized original never becomes a large Data allocation.
            let (download, response) = try await URLSession.shared.download(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let size = try download.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size <= 25 * 1_024 * 1_024 else {
                try? FileManager.default.removeItem(at: download)
                throw BridgeError.malformedResponse
            }
            try? FileManager.default.removeItem(at: file)
            try FileManager.default.moveItem(at: download, to: file)
            return file
        }
        downloads[name] = task
        defer { downloads[name] = nil }
        let stored = try await task.value
        evictOverLimit()
        return stored
    }

    private func isUsable(_ file: URL, writeOnce: Bool) -> Bool {
        guard let created = try? file.resourceValues(forKeys: [.creationDateKey]).creationDate else { return false }
        return writeOnce || Date().timeIntervalSince(created) < Self.workspaceFileLifetime
    }

    /// Drop the least recently shown originals once the folder passes its limit.
    private func evictOverLimit() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)
        else { return }
        let entries = files.compactMap { file -> (url: URL, size: Int, used: Date)? in
            guard let values = try? file.resourceValues(forKeys: Set(keys)) else { return nil }
            return (file, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(0) { $0 + $1.size }
        for entry in entries.sorted(by: { $0.used < $1.used }) where total > Self.diskLimit {
            try? FileManager.default.removeItem(at: entry.url)
            total -= entry.size
        }
    }
}
