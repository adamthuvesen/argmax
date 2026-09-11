import Foundation

struct UnresolvedRemoteOperation: Codable, Equatable, Sendable {
    let channel: String
    let input: Data
    let identity: RemoteOperation
    var uncertain = false
    var hostInterrupted = false
}

/// Durable submitted actions, separate from evictable content. Owned by the bridge actor.
struct RemoteOperationStore {
    let directory: URL
    let scope: String

    init(scope: String, directory: URL? = nil) {
        self.scope = scope
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory,
            in: .userDomainMask)[0].appendingPathComponent("argmax-operations-v1", isDirectory: true)
    }

    private var file: URL { directory.appendingPathComponent(scope).appendingPathExtension("json") }

    func load() throws -> [UnresolvedRemoteOperation] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 16 * 1_024 * 1_024 else { throw storageFailure }
        return try JSONDecoder().decode([UnresolvedRemoteOperation].self, from: Data(contentsOf: file))
    }

    func save(_ operations: [UnresolvedRemoteOperation]) throws {
        let data = try JSONEncoder().encode(operations)
        // Refuse new submissions instead of forgetting an unresolved action.
        guard operations.count <= 64, data.count <= 16 * 1_024 * 1_024 else { throw storageFailure }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
    }

    private var storageFailure: BridgeError {
        .host(code: "SERVICE_ERROR", subCode: "REMOTE_RECOVERY_STORAGE_FULL",
              message: "Resolve pending remote actions before sending more.")
    }
}

/// Injectable socket boundary for deterministic dropped-reply and stale-callback tests.
protocol BridgeSocket: Sendable {
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
}

extension URLSessionWebSocketTask: BridgeSocket {}
