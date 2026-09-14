import CryptoKit
import ImageIO
import UIKit

/// Shared by inline and expanded images. Keep useful previews warm without retaining full decodes.
actor NativeImageCache {
    static let shared = NativeImageCache()
    private let images = NSCache<NSString, UIImage>()
    private var pending: [String: Task<UIImage, Error>] = [:]

    init() {
        images.totalCostLimit = 48 * 1_024 * 1_024
        images.countLimit = 32
    }

    func image(for request: URLRequest, pixels: Int, revision: String = "") async throws -> UIImage {
        let identity = (request.url?.absoluteString ?? "") + "\u{0}"
            + (request.value(forHTTPHeaderField: "Authorization") ?? "") + "\u{0}" + revision
        let key = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined() + "-\(pixels)"
        if let image = images.object(forKey: key as NSString) { return image }
        if let task = pending[key] { return try await task.value }
        let task = Task.detached(priority: .userInitiated) {
            // Download to disk so an oversized original never becomes a large Data allocation.
            let (file, response) = try await URLSession.shared.download(for: request)
            defer { try? FileManager.default.removeItem(at: file) }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size <= 25 * 1_024 * 1_024 else { throw BridgeError.malformedResponse }
            return try NativePerformance.measure("Image thumbnail preparation") {
                guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true,
                        kCGImageSourceThumbnailMaxPixelSize: pixels
                      ] as CFDictionary) else { throw BridgeError.malformedResponse }
                return UIImage(cgImage: image)
            }
        }
        pending[key] = task
        defer { pending[key] = nil }
        let image = try await task.value
        let cost = (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0)
        images.setObject(image, forKey: key as NSString, cost: cost)
        return image
    }
}
