import XCTest
@testable import Argmax

final class DeviceCacheTests: XCTestCase {
    func testRoundTripScopesAndCorruption() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DeviceCache(directory: directory)
        await cache.write("saved", scope: "mac-a", key: "chat")
        let restored = await cache.read(String.self, scope: "mac-a", key: "chat")
        let other = await cache.read(String.self, scope: "mac-b", key: "chat")
        XCTAssertEqual(restored, "saved")
        XCTAssertNil(other)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).first)
        try Data("broken".utf8).write(to: file)
        let corrupt = await cache.read(String.self, scope: "mac-a", key: "chat")
        XCTAssertNil(corrupt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testEvictionExpiryAndOversizedContent() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = DeviceCache(directory: directory, byteLimit: 1_000, entryLimit: 2)
        for key in ["one", "two", "three"] {
            await cache.write(String(repeating: key, count: 40), scope: "mac", key: key)
            try await Task.sleep(for: .milliseconds(10))
        }
        let old = await cache.read(String.self, scope: "mac", key: "one")
        let newest = await cache.read(String.self, scope: "mac", key: "three")
        XCTAssertNil(old)
        XCTAssertNotNil(newest)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 2)
        await cache.write(String(repeating: "x", count: 600), scope: "mac", key: "oversized")
        let oversized = await cache.read(String.self, scope: "mac", key: "oversized")
        XCTAssertNil(oversized)
        let expiredCache = DeviceCache(directory: directory, maximumAge: -1)
        let expired = await expiredCache.read(String.self, scope: "mac", key: "three")
        XCTAssertNil(expired)
    }
}
