import CryptoKit
import Foundation
import Network

// The phone's half of the remote bridge protocol (docs/remote.md, and
// src-tauri/src/remote/ws.rs for the host's half). JSON text frames over one
// WebSocket:
//
//   client → {"type":"auth","token":"…"}
//            {"type":"request","id":1,"channel":"…","input":{},"operation":{…}}
//            {"type":"ping"}
//   host   → {"type":"auth-ok","operationReplay":true} | {"type":"auth-error"}
//            {"type":"response","id":1,"ok":…} | {"type":"response","id":1,"error":…}
//            {"type":"event","channel":"dashboard:delta","payload":…}
//            {"type":"pong"} | {"type":"resync"}
//
// This is the native equivalent of src/renderer/lib/wsTransport.ts and keeps
// its constants, so both clients age out a dead socket at the same moment.
// Submitted mutations retain their operation identity through reconnect. An
// unresolved result survives app termination and is recovered when the user
// explicitly repeats the same action. New offline actions are never journaled.

/// A push frame from the host.
enum BridgeEvent: Sendable {
    /// `{"type":"event","channel":…,"payload":…}`. `payload` is the raw JSON
    /// so each reader decodes only the shape it knows.
    case push(channel: String, payload: Data)
    /// `{"type":"resync"}` — this client's event receiver lagged and frames
    /// were dropped, so the snapshot has to be reloaded rather than patched.
    case resync
}

/// What the socket is doing, in the terms the chat list shows.
enum BridgeConnection: Equatable, Sendable {
    case connecting
    case live
    /// Dropped and retrying, since when. The list stays on screen; only the
    /// header says anything.
    case reconnecting(since: Date)
    /// The host rejected the token. Retrying cannot fix this, so the client
    /// stops and the app asks to pair again.
    case unauthorized
}

enum BridgeError: Error, Equatable {
    /// `auth-error`: the token is wrong, or the host rotated it.
    case authenticationFailed
    /// The socket closed, or never opened, with the request unanswered.
    case disconnected
    /// The pairing link has no token, or no host to reach.
    case unusablePairingLink
    /// `{"type":"response","error":…}` — an `ArgmaxError` from the host.
    /// `code` is the family (`SERVICE_ERROR`, `INVALID_INPUT`, …) and
    /// `subCode` the leaf within it, as `src-tauri/src/error.rs` serialises them.
    case host(code: String, subCode: String?, message: String)
    /// A frame that parsed as JSON but not as anything the protocol defines.
    case malformedResponse
}

/// An input for a channel that takes none. Encodes as `{}`, which is what the
/// host's dispatcher expects — not `null`.
struct EmptyInput: Encodable, Sendable {}

/// This install's identity, paired with a per-mutation id so the host can
/// recognise a replay of the same action.
///
/// The client id is *not* a credential: it names this phone among the clients
/// of one already-authenticated host, so `UserDefaults` is the right place
/// for it. The token stays in the keychain (`HostCredential`).
struct RemoteOperation: Codable, Equatable, Sendable {
    var clientId: String
    var operationId: String

    private static let defaultsKey = "argmax.remote.clientId"

    /// A fresh operation for this install. Same `UserDefaults` key the
    /// renderer uses in `localStorage`, so the two spellings read alike in a
    /// host-side log.
    static func mint(defaults: UserDefaults = .standard) -> RemoteOperation {
        let clientId = defaults.string(forKey: defaultsKey) ?? {
            let minted = UUID().uuidString
            defaults.set(minted, forKey: defaultsKey)
            return minted
        }()
        return RemoteOperation(clientId: clientId, operationId: UUID().uuidString)
    }
}

/// Which channels are reads, and so need no durable operation record.
///
/// The list is `src/shared/remoteReadChannels.json` itself, bundled by
/// `project.yml` rather than retyped here: the host defaults a channel it has
/// never heard of to requiring an operation, so a copy that drifted would
/// quietly start recording reads in the operations table.
enum RemoteChannels {
    static let read: Set<String> = {
        guard let url = Bundle.main.url(forResource: "remoteReadChannels", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let channels = try? JSONDecoder().decode([String].self, from: data)
        else {
            fatalError(
                "remoteReadChannels.json is not in the app bundle. It is referenced from "
                    + "ios/Argmax/project.yml; re-run xcodegen."
            )
        }
        return Set(channels)
    }()

    static func isMutation(_ channel: String) -> Bool { !read.contains(channel) }
}

/// One authenticated WebSocket to the paired Mac.
///
/// An actor because every piece of state here — the in-flight table, the
/// request counter, the reconnect attempt — is touched from the receive loop,
/// the heartbeat, and whatever view is calling `request`.
actor BridgeClient {
    /// Frames the host pushed. One consumer: `DashboardStore`.
    nonisolated let events: AsyncStream<BridgeEvent>
    /// Every connection transition, in order.
    nonisolated let connectionStates: AsyncStream<BridgeConnection>
    nonisolated let socketURL: URL
    nonisolated let cacheNamespace: String

    // The renderer's constants (src/renderer/lib/wsTransport.ts), so a dead
    // socket is noticed at the same moment in both clients.
    private static let heartbeat: Duration = .seconds(20)
    private static let pongDeadline: Duration = .seconds(8)
    private static let minReconnect = 0.5
    private static let maxReconnect = 8.0
    /// How long a call waits for a usable socket before giving up. The
    /// renderer queues offline requests for the same 15 seconds.
    private static let connectDeadline: Duration = .seconds(15)
    /// The host admits 16 concurrent requests per connection and answers the
    /// 17th with `REMOTE_REQUEST_LIMIT`. Queueing here means a burst waits
    /// instead of failing.
    private static let maxInFlight = 16
    private static let httpTranscriptChannels: Set<String> = [
        "session:events-since", "session:agent-events",
    ]

    private let token: String
    private let monitorNetwork: Bool
    private let makeSocket: @Sendable (URL) -> any BridgeSocket
    private let loadHTTP: @Sendable (URLRequest) async throws -> (Data, URLResponse)
    private let operationStore: RemoteOperationStore
    private var activeOperationIDs: Set<String> = []
    private var operationReplay = false
    private var generation = 0
    private var lifecycle = 0
    private var authTask: Task<Void, Never>?
    private var pathMonitor: NWPathMonitor?
    private var networkPath: PathState?

    struct PathState: Equatable, Sendable {
        let satisfied: Bool
        let interfaces: Int
    }

    private struct RemoteReply: Sendable {
        let value: Data?
        let error: BridgeError?
        let settled: Bool
    }
    private let eventContinuation: AsyncStream<BridgeEvent>.Continuation
    private let connectionContinuation: AsyncStream<BridgeConnection>.Continuation

    private var socket: (any BridgeSocket)?
    private var receiveLoop: Task<Void, Never>?
    private var heartbeatLoop: Task<Void, Never>?
    private var reconnectTimer: Task<Void, Never>?
    private var pongTimer: Task<Void, Never>?
    private var httpFallbacks: [UUID: Task<(Data, URLResponse), Error>] = [:]

    private var connection: BridgeConnection = .connecting
    private var authenticated = false
    private var stopped = true
    private var reconnectAttempt = 0
    private var droppedAt: Date?

    private var nextRequestID = 1
    private var pending: [Int: CheckedContinuation<RemoteReply, Error>] = [:]
    private var inFlight = 0
    private var slotWaiters: [CheckedContinuation<Void, Never>] = []
    private var authWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    init(pairingURL: URL, urlSession: URLSession = .shared,
         operationDirectory: URL? = nil, monitorNetwork: Bool = true,
         socketFactory: (@Sendable (URL) -> any BridgeSocket)? = nil,
         httpLoader: (@Sendable (URLRequest) async throws -> (Data, URLResponse))? = nil) throws {
        guard let socketURL = PairingLink.socketURL(for: pairingURL),
              let token = PairingLink.token(in: pairingURL)
        else { throw BridgeError.unusablePairingLink }
        self.socketURL = socketURL
        self.token = token
        self.cacheNamespace = SHA256.hash(data: Data((socketURL.absoluteString + "\u{0}" + token).utf8))
            .map { String(format: "%02x", $0) }.joined()
        self.monitorNetwork = monitorNetwork
        self.makeSocket = socketFactory ?? { url in
            let task = urlSession.webSocketTask(with: url)
            // The default 1 MiB ceiling closed the socket outright on a long
            // chat's backfill frame. The host now caps the complete transcript
            // response at 768 KiB and redirects an oversized entity through
            // the authenticated HTTP fallback, so this leaves headroom for
            // protocol drift without removing the ceiling.
            task.maximumMessageSize = 4 * 1024 * 1024
            return task
        }
        self.loadHTTP = httpLoader ?? { request in try await urlSession.data(for: request) }
        self.operationStore = RemoteOperationStore(scope: cacheNamespace, directory: operationDirectory)
        (events, eventContinuation) = AsyncStream.makeStream(of: BridgeEvent.self)
        (connectionStates, connectionContinuation) = AsyncStream.makeStream(of: BridgeConnection.self)
    }

    deinit {
        pathMonitor?.cancel()
        authTask?.cancel()
        eventContinuation.finish()
        connectionContinuation.finish()
    }

    /// An authenticated `GET` for one file's bytes.
    ///
    /// The socket carries JSON, so image bytes take the host's own HTTP side
    /// (`/api/workspace-assets/…`, see `docs/remote.md`) — the same endpoint
    /// the transcript's screenshots load through, and the same one
    /// `workspaceAssetUrl` builds for the browser. The token rides in the
    /// header rather than the query so it stays out of any cache key.
    ///
    /// `nonisolated` because it reads nothing but two immutable lets: fetching
    /// an image should not queue behind whatever the actor is decoding.
    nonisolated func assetRequest(absolutePath: String) -> URLRequest? {
        fileRequest(absolutePath: absolutePath, endpoint: "workspace-assets")
    }

    nonisolated func attachmentRequest(absolutePath: String) -> URLRequest? {
        fileRequest(absolutePath: absolutePath, endpoint: "attachments")
    }

    private nonisolated func fileRequest(absolutePath: String, endpoint: String) -> URLRequest? {
        guard var components = URLComponents(url: socketURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.scheme = socketURL.scheme == "wss" ? "https" : "http"
        // Each segment is encoded on its own so a space or a `#` in a path
        // survives the trip and the host's `percent_decode` gets it back.
        let segments = absolutePath.split(separator: "/").map {
            String($0).addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(
                CharacterSet(charactersIn: "-._~")
            )) ?? String($0)
        }
        // `percentEncodedPath`, not `path`: assigning `path` encodes what it
        // is given, so a segment already encoded here comes out doubled — a
        // space becomes `%2520` and the host looks for a file whose name
        // contains the literal characters `%20`.
        components.percentEncodedPath = "/api/\(endpoint)/" + segments.joined(separator: "/")
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    // MARK: - Lifecycle

    /// Open the socket and keep it open. Idempotent, and a no-op once the
    /// host has rejected the token — only a new pairing link fixes that.
    func connect() {
        guard connection != .unauthorized else { return }
        guard stopped || socket == nil else { return }
        stopped = false
        startPathMonitor()
        openSocket()
    }

    /// Close the socket and stop reconnecting. Pending calls fail.
    func disconnect() {
        lifecycle += 1
        stopped = true
        pathMonitor?.cancel()
        pathMonitor = nil
        networkPath = nil
        teardown(failPendingWith: .disconnected)
        publish(.connecting)
    }

    /// Try again right now, whatever the backoff had planned.
    ///
    /// Backgrounding kills the socket without closing it — a phone radio drops
    /// the NAT mapping — so a return to the foreground should not wait out a
    /// timer that is counting to eight seconds.
    func reconnectNow(force: Bool = false) {
        guard connection != .unauthorized else { return }
        reconnectAttempt = 0
        reconnectTimer?.cancel()
        reconnectTimer = nil
        if authenticated, !force {
            let mine = generation
            Task { await ping(generation: mine) }
            return
        }
        if socket != nil { teardown(failPendingWith: .disconnected) }
        stopped = false
        openSocket()
    }

    // MARK: - Requests

    @discardableResult
    func request(_ channel: String) async throws -> Data {
        try await request(channel, input: EmptyInput())
    }

    @discardableResult
    func request(_ channel: String, input: some Encodable & Sendable) async throws -> Data {
        try await send(channel: channel, input: input)
    }

    func request<Output: Decodable>(_ channel: String, as: Output.Type) async throws -> Output {
        try await request(channel, input: EmptyInput(), as: Output.self)
    }

    func request<Output: Decodable>(
        _ channel: String,
        input: some Encodable & Sendable,
        as: Output.Type
    ) async throws -> Output {
        let clock = ContinuousClock()
        let started = clock.now
        let payload = try await send(channel: channel, input: input)
        let received = clock.now
        do {
            let decoded = try JSONDecoder().decode(Output.self, from: payload)
            NativePerformance.log.debug("request \(channel, privacy: .public) bytes=\(payload.count) roundTripMs=\((received - started).milliseconds) decodeMs=\((clock.now - received).milliseconds)")
            return decoded
        } catch {
            throw BridgeError.malformedResponse
        }
    }

    private func send(channel: String, input: some Encodable & Sendable) async throws -> Data {
        let startedLifecycle = lifecycle
        await acquireSlot()
        defer { releaseSlot() }
        try Task.checkCancellation()
        guard startedLifecycle == lifecycle else { throw BridgeError.disconnected }
        try await waitUntilAuthenticated()
        try Task.checkCancellation()
        guard lifecycle == startedLifecycle else { throw BridgeError.disconnected }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(input)
        let isMutation = RemoteChannels.isMutation(channel)
        var operation: UnresolvedRemoteOperation?
        if isMutation {
            guard operationReplay else {
                throw BridgeError.host(code: "SERVICE_ERROR", subCode: "REMOTE_REPLAY_UNSUPPORTED",
                    message: "Update the Argmax host before sending remote actions.")
            }
            var saved = try operationStore.load()
            // Only an explicit repeated action adopts a result left unresolved by an earlier call.
            let match = saved.first { $0.channel == channel && Self.canonicalInput($0.input) == encoded
                && !activeOperationIDs.contains($0.identity.operationId) }
            if let match {
                guard !match.hostInterrupted else { throw Self.unknownOutcome }
                operation = match
            } else {
                let fresh = UnresolvedRemoteOperation(channel: channel, input: encoded, identity: RemoteOperation.mint())
                saved.append(fresh)
                try operationStore.save(saved)
                operation = fresh
            }
            activeOperationIDs.insert(operation!.identity.operationId)
        }
        defer { if let operation { activeOperationIDs.remove(operation.identity.operationId) } }
        // Retry only a submitted logical action, within a finite recovery window.
        let recoveryDeadline = Date().addingTimeInterval(120)
        // A Mac built before a channel joined the read manifest refuses the
        // read for want of an operation. Reads have no side effects, so it is
        // sent once more under a throwaway identity nothing here keeps.
        var olderHostReadIdentity: RemoteOperation?
        do {
            while true {
                try Task.checkCancellation()
                guard lifecycle == startedLifecycle else { throw BridgeError.disconnected }
                do {
                    try await waitUntilAuthenticated()
                    guard lifecycle == startedLifecycle else { throw BridgeError.disconnected }
                    if isMutation, !operationReplay { throw Self.unknownOutcome }
                    let reply = try await sendOnce(
                        channel: channel,
                        encodedInput: encoded,
                        operation: operation?.identity ?? olderHostReadIdentity
                    )
                    if let operation, reply.settled {
                        var saved = try operationStore.load()
                        saved.removeAll { $0.identity == operation.identity }
                        try operationStore.save(saved)
                    }
                    if let error = reply.error {
                        if Self.shouldFetchTranscript(channel: channel, error: error) {
                            return try await fetchTranscript(
                                channel: channel,
                                encodedInput: encoded,
                                startedLifecycle: startedLifecycle,
                                startedGeneration: generation
                            )
                        }
                        if !isMutation, olderHostReadIdentity == nil,
                           case .host(_, let subCode, _) = error, subCode == "REMOTE_OPERATION_REQUIRED" {
                            olderHostReadIdentity = RemoteOperation.mint()
                            continue
                        }
                        if !reply.settled, operation != nil,
                           case .host(_, let subCode, _) = error,
                           subCode == "REMOTE_OPERATION_PENDING", Date() < recoveryDeadline {
                            try await Task.sleep(for: .milliseconds(500))
                            continue
                        }
                        throw error
                    }
                    guard !isMutation || reply.settled else { throw Self.unknownOutcome }
                    guard let value = reply.value else { throw BridgeError.malformedResponse }
                    return value
                } catch BridgeError.disconnected {
                    guard operation != nil, lifecycle == startedLifecycle, !stopped,
                          Date() < recoveryDeadline else { throw BridgeError.disconnected }
                    // Yield to the connection loop. The next auth wait has its own 15s bound.
                    try await Task.sleep(for: .milliseconds(250))
                }
            }
        } catch {
            if let operation {
                var saved = try operationStore.load()
                if let index = saved.firstIndex(where: { $0.identity == operation.identity }) {
                    saved[index].uncertain = true
                    if case BridgeError.host(_, let subCode, _) = error, subCode == "REMOTE_OUTCOME_UNKNOWN" {
                        saved[index].hostInterrupted = true
                    }
                    try operationStore.save(saved)
                    if error as? BridgeError == .disconnected { throw Self.unknownOutcome }
                }
            }
            throw error
        }
    }

    private static var unknownOutcome: BridgeError {
        .host(code: "SERVICE_ERROR", subCode: "REMOTE_OUTCOME_UNKNOWN",
              message: "The action's outcome is unconfirmed. Check the chat before trying again.")
    }

    private static func shouldFetchTranscript(channel: String, error: BridgeError) -> Bool {
        guard httpTranscriptChannels.contains(channel),
              case .host(let code, let subCode, _) = error
        else { return false }
        return code == "SERVICE_ERROR" && subCode == "REMOTE_RESPONSE_TOO_LARGE"
    }

    private func fetchTranscript(
        channel: String,
        encodedInput: Data,
        startedLifecycle: Int,
        startedGeneration: Int
    ) async throws -> Data {
        guard var components = URLComponents(url: socketURL, resolvingAgainstBaseURL: false) else {
            throw BridgeError.malformedResponse
        }
        components.scheme = socketURL.scheme == "wss" ? "https" : "http"
        components.path = "/api/transcript"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw BridgeError.malformedResponse }

        let input = try JSONSerialization.jsonObject(with: encodedInput, options: [.fragmentsAllowed])
        let body = try JSONSerialization.data(
            withJSONObject: ["channel": channel, "input": input],
            options: [.sortedKeys]
        )
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let fallbackID = UUID()
        let loader = loadHTTP
        let fallback = Task { try await loader(request) }
        httpFallbacks[fallbackID] = fallback
        defer { httpFallbacks.removeValue(forKey: fallbackID) }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await withTaskCancellationHandler {
                try await fallback.value
            } onCancel: {
                fallback.cancel()
            }
        } catch is CancellationError {
            if Task.isCancelled { throw CancellationError() }
            if lifecycle != startedLifecycle || generation != startedGeneration {
                throw BridgeError.disconnected
            }
            throw CancellationError()
        }
        try Task.checkCancellation()
        guard lifecycle == startedLifecycle, generation == startedGeneration else {
            throw BridgeError.disconnected
        }
        guard let http = response as? HTTPURLResponse else { throw BridgeError.malformedResponse }
        if http.statusCode == 401 { throw BridgeError.authenticationFailed }
        guard (200..<300).contains(http.statusCode) else {
            throw BridgeError.host(
                code: "SERVICE_ERROR",
                subCode: "REMOTE_HTTP_ERROR",
                message: "Argmax remote transcript request failed (\(http.statusCode))."
            )
        }
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BridgeError.malformedResponse
        }
        if let error = envelope["error"] {
            throw Self.hostError(error)
        }
        guard let value = envelope["ok"],
              let encoded = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
        else { throw BridgeError.malformedResponse }
        return encoded
    }

    private func sendOnce(channel: String, encodedInput: Data, operation: RemoteOperation?) async throws -> RemoteReply {
        guard let socket, authenticated else { throw BridgeError.disconnected }
        let id = nextRequestID
        nextRequestID += 1
        let mine = generation
        var frame: [String: Any] = ["type": "request", "id": id, "channel": channel,
            "input": try JSONSerialization.jsonObject(with: encodedInput, options: [.fragmentsAllowed])]
        if let operation {
            frame["operation"] = ["clientId": operation.clientId, "operationId": operation.operationId]
        }
        let text = String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
        let deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(60)) } catch { return }
            await self?.failPending(id, with: .host(code: "SERVICE_ERROR", subCode: "REMOTE_RESPONSE_TIMEOUT",
                message: "The Mac did not confirm this request in time."))
        }
        defer { deadline.cancel() }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard !Task.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                pending[id] = continuation
                Task {
                    do { try await socket.send(.string(text)) }
                    catch { self.socketFailed(generation: mine) }
                }
            }
        } onCancel: {
            Task { await self.failPending(id, with: .disconnected) }
        }
    }

    /// The bytes one request puts on the socket.
    ///
    /// Split out of `send` so a test can read exactly what a channel sends:
    /// whether `operation` is there is the difference between a read and a
    /// durable mutation, and it is decided here rather than by the caller.
    nonisolated static func encodeRequestFrame(
        id: Int,
        channel: String,
        input: some Encodable & Sendable,
        defaults: UserDefaults = .standard
    ) throws -> Data {
        let frame = RequestFrame(
            id: id,
            channel: channel,
            input: input,
            // A read needs no durable record; every other channel does, and
            // the host refuses one that arrives without it.
            operation: RemoteChannels.isMutation(channel) ? RemoteOperation.mint(defaults: defaults) : nil
        )
        return try JSONEncoder().encode(frame)
    }

    private struct RequestFrame<Input: Encodable>: Encodable {
        let type = "request"
        let id: Int
        let channel: String
        let input: Input
        let operation: RemoteOperation?
    }

    /// Wait for a slot among the host's 16, taking one when it frees.
    private func acquireSlot() async {
        if inFlight < Self.maxInFlight {
            inFlight += 1
            return
        }
        await withCheckedContinuation { slotWaiters.append($0) }
    }

    /// Hand the slot to whoever is queued, or give it back to the pool.
    private func releaseSlot() {
        if slotWaiters.isEmpty {
            inFlight -= 1
        } else {
            slotWaiters.removeFirst().resume()
        }
    }

    private func waitUntilAuthenticated() async throws {
        if authenticated { return }
        if connection == .unauthorized { throw BridgeError.authenticationFailed }
        connect()

        let waiter = UUID()
        let deadline = Task { [weak self] in
            try? await Task.sleep(for: Self.connectDeadline)
            await self?.expireAuthWaiter(waiter)
        }
        defer { deadline.cancel() }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { authWaiters[waiter] = continuation }
            }
        } onCancel: { Task { await self.expireAuthWaiter(waiter) } }
    }

    private func expireAuthWaiter(_ waiter: UUID) {
        authWaiters.removeValue(forKey: waiter)?.resume(throwing: BridgeError.disconnected)
    }

    private func failPending(_ id: Int, with error: BridgeError) {
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    // MARK: - Socket

    private func openSocket() {
        teardown(failPendingWith: nil)
        let mine = generation
        publish(droppedAt.map { .reconnecting(since: $0) } ?? .connecting)

        let socket = makeSocket(socketURL)
        self.socket = socket
        socket.resume()

        // The host drops a client that has not authenticated within five
        // seconds, so this goes first and everything else waits behind it.
        authTask = Task {
            do {
                let auth = try JSONSerialization.data(withJSONObject: ["type": "auth", "token": token])
                try await socket.send(.string(String(decoding: auth, as: UTF8.self)))
            } catch {
                self.socketFailed(generation: mine)
            }
        }

        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    await self?.receive(message, generation: mine)
                } catch {
                    guard !Task.isCancelled else { return }
                    await self?.socketFailed(generation: mine)
                    return
                }
            }
        }
    }

    private func receive(_ message: URLSessionWebSocketTask.Message, generation mine: Int) {
        guard mine == generation else { return }
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        let clock = ContinuousClock()
        let parseStarted = clock.now
        defer {
            if data.count > 64 * 1_024 {
                NativePerformance.log.debug("frame bytes=\(data.count) actorMs=\((clock.now - parseStarted).milliseconds)")
            }
        }
        guard let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = frame["type"] as? String
        else { return }

        switch type {
        case "auth-ok":
            authenticated = true
            operationReplay = frame["operationReplay"] as? Bool == true
            reconnectAttempt = 0
            droppedAt = nil
            publish(.live)
            let waiters = authWaiters.values
            authWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            startHeartbeat(generation: mine)
        case "auth-error":
            // Retrying with the same token only loops, so stop and let the
            // app ask for a new pairing link.
            stopped = true
            teardown(failPendingWith: .authenticationFailed)
            publish(.unauthorized)
        case "pong":
            pongTimer?.cancel()
            pongTimer = nil
        case "resync":
            eventContinuation.yield(.resync)
        case "event":
            guard let channel = frame["channel"] as? String, let payload = frame["payload"] else { return }
            guard let encoded = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed])
            else { return }
            eventContinuation.yield(.push(channel: channel, payload: encoded))
        case "response":
            guard let id = frame["id"] as? Int, let continuation = pending.removeValue(forKey: id) else { return }
            if let ok = frame["ok"] {
                let encoded = (try? JSONSerialization.data(withJSONObject: ok, options: [.fragmentsAllowed]))
                continuation.resume(returning: RemoteReply(value: encoded,
                    error: encoded == nil ? .malformedResponse : nil,
                    settled: frame["operationSettled"] as? Bool == true))
            } else {
                continuation.resume(returning: RemoteReply(value: nil, error: Self.hostError(frame["error"]),
                    settled: frame["operationSettled"] as? Bool == true))
            }
        default:
            return
        }
    }

    /// `{"code":"SERVICE_ERROR","sub_code":…,"message":…}` as `error.rs`
    /// serialises it.
    ///
    /// `INVALID_INPUT` carries neither: its words are in the first `issues`
    /// entry, as `{path, code, message}`. Reading them is what keeps the
    /// screens showing a sentence — before this, a Mac with no APNs key
    /// answered "Send test" with the literal string `INVALID_INPUT`.
    private static func hostError(_ payload: Any?) -> BridgeError {
        guard let payload = payload as? [String: Any], let code = payload["code"] as? String else {
            return .malformedResponse
        }
        let issue = (payload["issues"] as? [[String: Any]])?.first
        return .host(
            code: code,
            subCode: payload["sub_code"] as? String ?? issue?["code"] as? String,
            message: payload["message"] as? String ?? issue?["message"] as? String ?? code
        )
    }

    private func socketFailed(generation mine: Int) {
        // The receive loop, the auth send and the pong deadline can all
        // notice the same dead socket. `teardown` clears it, so the second
        // report is a no-op rather than a second reconnect.
        guard mine == generation, !stopped, socket != nil else { return }
        if droppedAt == nil { droppedAt = Date() }
        teardown(failPendingWith: .disconnected)
        publish(.reconnecting(since: droppedAt ?? Date()))
        scheduleReconnect()
    }

    /// Same backoff the renderer uses: doubling from 500 ms to 8 s, then half
    /// to full jitter so a Mac waking up does not meet every client at once.
    private func scheduleReconnect() {
        guard networkPath?.satisfied != false else { return }
        let mine = generation
        let base = min(Self.minReconnect * pow(2, Double(reconnectAttempt)), Self.maxReconnect)
        reconnectAttempt = min(reconnectAttempt + 1, 8)
        let delay = base * Double.random(in: 0.5...1.0)
        reconnectTimer?.cancel()
        reconnectTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.reconnectIfCurrent(mine)
        }
    }

    /// An app-level heartbeat, because a mobile radio drops the NAT mapping
    /// without closing the socket and nothing else would notice.
    private func startHeartbeat(generation mine: Int) {
        heartbeatLoop?.cancel()
        heartbeatLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.heartbeat)
                guard !Task.isCancelled else { return }
                await self?.ping(generation: mine)
            }
        }
    }

    private func ping(generation mine: Int) async {
        guard mine == generation, let socket, authenticated, pongTimer == nil else { return }
        pongTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.pongDeadline)
            guard !Task.isCancelled else { return }
            await self?.socketFailed(generation: mine)
        }
        try? await socket.send(.string(#"{"type":"ping"}"#))
    }

    private func teardown(failPendingWith error: BridgeError?) {
        generation += 1
        authenticated = false
        operationReplay = false
        authTask?.cancel()
        authTask = nil
        receiveLoop?.cancel()
        receiveLoop = nil
        heartbeatLoop?.cancel()
        heartbeatLoop = nil
        pongTimer?.cancel()
        pongTimer = nil
        reconnectTimer?.cancel()
        reconnectTimer = nil
        let fallbacks = httpFallbacks.values
        httpFallbacks.removeAll()
        for fallback in fallbacks { fallback.cancel() }
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil

        guard let error else { return }
        let waiting = pending.values
        pending.removeAll()
        for continuation in waiting { continuation.resume(throwing: error) }
        let waiters = authWaiters.values
        authWaiters.removeAll()
        for waiter in waiters { waiter.resume(throwing: error) }
    }

    private func reconnectIfCurrent(_ mine: Int) {
        guard generation == mine, !stopped else { return }
        openSocket()
    }

    private static func canonicalInput(_ data: Data) -> Data? {
        guard let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
    }

    func unresolvedOperations() throws -> [UnresolvedRemoteOperation] {
        try operationStore.load().filter { !activeOperationIDs.contains($0.identity.operationId) }
    }

    /// The user has inspected host state. Clearing this record never submits an action.
    func acknowledgeOperation(_ id: String) throws {
        guard !activeOperationIDs.contains(id) else {
            throw BridgeError.host(code: "SERVICE_ERROR", subCode: "REMOTE_OPERATION_PENDING",
                message: "This action is still waiting for the Mac.")
        }
        var saved = try operationStore.load()
        guard !saved.contains(where: { $0.identity.operationId == id && !$0.hostInterrupted }) else {
            throw BridgeError.host(code: "SERVICE_ERROR", subCode: "REMOTE_OPERATION_PENDING",
                message: "Repeat this action to recover its result before clearing its record.")
        }
        saved.removeAll { $0.identity.operationId == id }
        try operationStore.save(saved)
    }

    private func startPathMonitor() {
        guard monitorNetwork, pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        pathMonitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            let interfaces = (path.usesInterfaceType(.wifi) ? 1 : 0)
                | (path.usesInterfaceType(.cellular) ? 2 : 0)
                | (path.usesInterfaceType(.wiredEthernet) ? 4 : 0)
            let state = PathState(satisfied: path.status == .satisfied, interfaces: interfaces)
            Task { await self?.pathChanged(state) }
        }
        monitor.start(queue: DispatchQueue(label: "com.argmax.remote.path"))
    }

    func pathChanged(_ state: PathState) {
        guard !stopped, connection != .unauthorized else { return }
        let previous = networkPath
        networkPath = state
        guard previous != state else { return }
        if !state.satisfied {
            socketFailed(generation: generation)
        } else if previous != nil {
            reconnectNow(force: true)
        }
    }

    private func publish(_ next: BridgeConnection) {
        guard next != connection else { return }
        connection = next
        connectionContinuation.yield(next)
    }
}
