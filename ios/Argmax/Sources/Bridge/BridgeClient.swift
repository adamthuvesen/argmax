import Foundation

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
// What it deliberately does not port is operation *replay*: the renderer
// persists an unresolved operation's identity and reuses it after a reload so
// the host can recognise the retry. The phone mints a fresh identity per
// attempt and never retries a mutation on its own, which is the same posture
// scripts/bridge.mjs takes.

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
struct RemoteOperation: Encodable, Sendable {
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

    private let token: String
    private let urlSession: URLSession
    private let eventContinuation: AsyncStream<BridgeEvent>.Continuation
    private let connectionContinuation: AsyncStream<BridgeConnection>.Continuation

    private var socket: URLSessionWebSocketTask?
    private var receiveLoop: Task<Void, Never>?
    private var heartbeatLoop: Task<Void, Never>?
    private var reconnectTimer: Task<Void, Never>?
    private var pongTimer: Task<Void, Never>?

    private var connection: BridgeConnection = .connecting
    private var authenticated = false
    private var stopped = true
    private var reconnectAttempt = 0
    private var droppedAt: Date?

    private var nextRequestID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var inFlight = 0
    private var slotWaiters: [CheckedContinuation<Void, Never>] = []
    private var authWaiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    init(pairingURL: URL, urlSession: URLSession = .shared) throws {
        guard let socketURL = PairingLink.socketURL(for: pairingURL),
              let token = PairingLink.token(in: pairingURL)
        else { throw BridgeError.unusablePairingLink }
        self.socketURL = socketURL
        self.token = token
        self.urlSession = urlSession
        (events, eventContinuation) = AsyncStream.makeStream(of: BridgeEvent.self)
        (connectionStates, connectionContinuation) = AsyncStream.makeStream(of: BridgeConnection.self)
    }

    deinit {
        eventContinuation.finish()
        connectionContinuation.finish()
    }

    // MARK: - Lifecycle

    /// Open the socket and keep it open. Idempotent, and a no-op once the
    /// host has rejected the token — only a new pairing link fixes that.
    func connect() {
        guard connection != .unauthorized else { return }
        guard stopped || socket == nil else { return }
        stopped = false
        openSocket()
    }

    /// Close the socket and stop reconnecting. Pending calls fail.
    func disconnect() {
        stopped = true
        teardown(failPendingWith: .disconnected)
        publish(.connecting)
    }

    /// Try again right now, whatever the backoff had planned.
    ///
    /// Backgrounding kills the socket without closing it — a phone radio drops
    /// the NAT mapping — so a return to the foreground should not wait out a
    /// timer that is counting to eight seconds.
    func reconnectNow() {
        guard connection != .unauthorized else { return }
        reconnectAttempt = 0
        reconnectTimer?.cancel()
        reconnectTimer = nil
        guard !authenticated else { return }
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
        let payload = try await send(channel: channel, input: input)
        do {
            return try JSONDecoder().decode(Output.self, from: payload)
        } catch {
            throw BridgeError.malformedResponse
        }
    }

    private func send(channel: String, input: some Encodable & Sendable) async throws -> Data {
        await acquireSlot()
        defer { releaseSlot() }
        try await waitUntilAuthenticated()
        guard let socket else { throw BridgeError.disconnected }

        let id = nextRequestID
        nextRequestID += 1
        let text = String(decoding: try Self.encodeRequestFrame(id: id, channel: channel, input: input), as: UTF8.self)

        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task {
                do {
                    try await socket.send(.string(text))
                } catch {
                    self.failPending(id, with: .disconnected)
                }
            }
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
        try await withCheckedThrowingContinuation { authWaiters[waiter] = $0 }
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
        publish(droppedAt.map { .reconnecting(since: $0) } ?? .connecting)

        let socket = urlSession.webSocketTask(with: socketURL)
        self.socket = socket
        socket.resume()

        // The host drops a client that has not authenticated within five
        // seconds, so this goes first and everything else waits behind it.
        Task {
            do {
                try await socket.send(.string(#"{"type":"auth","token":"\#(token)"}"#))
            } catch {
                self.socketFailed()
            }
        }

        receiveLoop = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    await self?.receive(message)
                } catch {
                    guard !Task.isCancelled else { return }
                    await self?.socketFailed()
                    return
                }
            }
        }
    }

    private func receive(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return
        }
        guard let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = frame["type"] as? String
        else { return }

        switch type {
        case "auth-ok":
            authenticated = true
            reconnectAttempt = 0
            droppedAt = nil
            publish(.live)
            let waiters = authWaiters.values
            authWaiters.removeAll()
            for waiter in waiters { waiter.resume() }
            startHeartbeat()
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
                continuation.resume(with: encoded.map { .success($0) } ?? .failure(BridgeError.malformedResponse))
            } else {
                continuation.resume(throwing: Self.hostError(frame["error"]))
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

    private func socketFailed() {
        // The receive loop, the auth send and the pong deadline can all
        // notice the same dead socket. `teardown` clears it, so the second
        // report is a no-op rather than a second reconnect.
        guard !stopped, socket != nil else { return }
        if droppedAt == nil { droppedAt = Date() }
        teardown(failPendingWith: .disconnected)
        publish(.reconnecting(since: droppedAt ?? Date()))
        scheduleReconnect()
    }

    /// Same backoff the renderer uses: doubling from 500 ms to 8 s, then half
    /// to full jitter so a Mac waking up does not meet every client at once.
    private func scheduleReconnect() {
        let base = min(Self.minReconnect * pow(2, Double(reconnectAttempt)), Self.maxReconnect)
        reconnectAttempt += 1
        let delay = base * Double.random(in: 0.5...1.0)
        reconnectTimer?.cancel()
        reconnectTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.openSocket()
        }
    }

    /// An app-level heartbeat, because a mobile radio drops the NAT mapping
    /// without closing the socket and nothing else would notice.
    private func startHeartbeat() {
        heartbeatLoop?.cancel()
        heartbeatLoop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.heartbeat)
                guard !Task.isCancelled else { return }
                await self?.ping()
            }
        }
    }

    private func ping() async {
        guard let socket, authenticated else { return }
        pongTimer?.cancel()
        pongTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.pongDeadline)
            guard !Task.isCancelled else { return }
            await self?.socketFailed()
        }
        try? await socket.send(.string(#"{"type":"ping"}"#))
    }

    private func teardown(failPendingWith error: BridgeError?) {
        authenticated = false
        receiveLoop?.cancel()
        receiveLoop = nil
        heartbeatLoop?.cancel()
        heartbeatLoop = nil
        pongTimer?.cancel()
        pongTimer = nil
        reconnectTimer?.cancel()
        reconnectTimer = nil
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

    private func publish(_ next: BridgeConnection) {
        guard next != connection else { return }
        connection = next
        connectionContinuation.yield(next)
    }
}
