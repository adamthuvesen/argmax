import XCTest
@testable import Argmax

final class BridgeRecoveryTests: XCTestCase {
    func testLostReplyReplaysSameIdentityAndSettlesOnce() async throws {
        let first = TestBridgeSocket(), second = TestBridgeSocket()
        let (client, directory) = try makeClient([first, second])
        defer { try? FileManager.default.removeItem(at: directory) }
        let call = Task { try await client.request("session:stop", input: ["sessionId": "s"]) }
        let original = try await request(on: first)
        first.fail()
        let replay = try await request(on: second)
        XCTAssertEqual(original["operation"] as? NSDictionary, replay["operation"] as? NSDictionary)
        XCTAssertEqual(original["input"] as? NSDictionary, replay["input"] as? NSDictionary)
        second.reply(to: replay)
        _ = try await call.value
        XCTAssertTrue(try RemoteOperationStore(scope: client.cacheNamespace, directory: directory).load().isEmpty)
        await client.disconnect()
    }

    func testOldAuthFailureDoesNotCloseReplacement() async throws {
        let first = TestBridgeSocket(holdAuth: true), second = TestBridgeSocket()
        let (client, directory) = try makeClient([first, second])
        defer { try? FileManager.default.removeItem(at: directory) }
        await client.connect()
        try await wait { first.authIsHeld }
        await client.reconnectNow(force: true)
        let call = Task { try await client.request("dashboard:list") }
        let read = try await request(on: second)
        first.releaseAuthFailure()
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertFalse(second.isClosed)
        second.reply(to: read)
        _ = try await call.value
        await client.disconnect()
    }

    func testUnknownOutcomeRequiresAcknowledgementBeforeNewAction() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let call = Task { try await client.request("session:stop") }
        let original = try await request(on: socket)
        socket.reply(to: original, error: "REMOTE_OUTCOME_UNKNOWN", settled: false)
        do { _ = try await call.value; XCTFail("expected unknown outcome") } catch {}
        let journal = RemoteOperationStore(scope: client.cacheNamespace, directory: directory)
        let record = try XCTUnwrap(journal.load().first)
        XCTAssertTrue(record.hostInterrupted)
        do { _ = try await client.request("session:stop"); XCTFail("must inspect first") } catch {}
        XCTAssertEqual(socket.requests.count, 1)
        try await client.acknowledgeOperation(record.identity.operationId)
        XCTAssertTrue(try journal.load().isEmpty)
        await client.disconnect()
    }

    func testRelaunchMatchesCanonicalInputAndSettledErrorClearsJournal() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let identity = RemoteOperation.mint()
        let journal = RemoteOperationStore(scope: client.cacheNamespace, directory: directory)
        try journal.save([.init(channel: "session:stop", input: Data(#"{"z":"last","a":"first"}"#.utf8), identity: identity, uncertain: true)])
        do {
            try await client.acknowledgeOperation(identity.operationId)
            XCTFail("a possibly running operation must retain its replay identity after relaunch")
        } catch {}
        XCTAssertEqual(try journal.load().first?.identity, identity)
        let call = Task { try await client.request("session:stop", input: ["a": "first", "z": "last"]) }
        let sent = try await request(on: socket)
        XCTAssertEqual((sent["operation"] as? [String: String])?["operationId"], identity.operationId)
        socket.reply(to: sent, error: "NOT_FOUND", settled: true)
        do { _ = try await call.value; XCTFail("expected host error") } catch {}
        XCTAssertTrue(try journal.load().isEmpty)
        await client.disconnect()
    }

    func testPendingResponseReusesOperationAndReadsAreNotJournaled() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let call = Task { try await client.request("session:stop") }
        let first = try await request(on: socket)
        socket.reply(to: first, error: "REMOTE_OPERATION_PENDING", settled: false)
        let retry = try await request(on: socket, count: 2)
        XCTAssertEqual(first["operation"] as? NSDictionary, retry["operation"] as? NSDictionary)
        socket.reply(to: retry)
        _ = try await call.value
        let read = Task { try await client.request("dashboard:list") }
        _ = try await request(on: socket, count: 3)
        socket.fail()
        do { _ = try await read.value; XCTFail("read should fail") } catch {}
        XCTAssertTrue(try RemoteOperationStore(scope: client.cacheNamespace, directory: directory).load().isEmpty)
        await client.disconnect()
    }

    func testCancelledRequestDoesNotLeaveAContinuationAndScopeIsIsolated() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let call = Task { try await client.request("dashboard:list") }
        let sent = try await request(on: socket)
        call.cancel()
        do { _ = try await call.value; XCTFail("expected cancellation") } catch {}
        socket.reply(to: sent)
        let store = RemoteOperationStore(scope: client.cacheNamespace, directory: directory)
        try store.save([.init(channel: "session:stop", input: Data("{}".utf8), identity: .mint())])
        XCTAssertTrue(try RemoteOperationStore(scope: "another-mac", directory: directory).load().isEmpty)
        await client.disconnect()
    }

    private func makeClient(_ sockets: [TestBridgeSocket]) throws -> (BridgeClient, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sequence = TestSocketSequence(sockets)
        let client = try BridgeClient(pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=test")),
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in sequence.next() })
        return (client, directory)
    }

    private func request(on socket: TestBridgeSocket, count: Int = 1) async throws -> [String: Any] {
        try await wait { socket.requests.count >= count }
        return try XCTUnwrap(socket.requests.last)
    }

    private func wait(_ condition: () -> Bool) async throws {
        for _ in 0..<500 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Timed out waiting for scripted socket")
        throw BridgeError.disconnected
    }
}

private final class TestSocketSequence: @unchecked Sendable {
    private let lock = NSLock()
    private let sockets: [TestBridgeSocket]
    private var index = 0
    init(_ sockets: [TestBridgeSocket]) { self.sockets = sockets }
    func next() -> TestBridgeSocket {
        lock.withLock {
            let socket = sockets[min(index, sockets.count - 1)]
            index += 1
            return socket
        }
    }
}

private final class TestBridgeSocket: BridgeSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [[String: Any]] = []
    private var queued: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var auth: CheckedContinuation<Void, Error>?
    private var closed = false
    private let holdAuth: Bool
    init(holdAuth: Bool = false) { self.holdAuth = holdAuth }
    var requests: [[String: Any]] { lock.withLock { messages.filter { $0["type"] as? String == "request" } } }
    var isClosed: Bool { lock.withLock { closed } }
    var authIsHeld: Bool { lock.withLock { auth != nil } }
    func resume() {}
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) { fail() }
    func fail() {
        lock.withLock { closed = true }
        deliver(.failure(BridgeError.disconnected))
    }
    func releaseAuthFailure() {
        let continuation = lock.withLock { let value = auth; auth = nil; return value }
        continuation?.resume(throwing: BridgeError.disconnected)
    }
    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: throw BridgeError.malformedResponse
        }
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        lock.withLock { messages.append(frame) }
        if frame["type"] as? String == "auth" {
            if holdAuth { try await withCheckedThrowingContinuation { continuation in lock.withLock { auth = continuation } } }
            else { feed(["type": "auth-ok", "operationReplay": true]) }
        }
    }
    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            let next: Result<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
                if !queued.isEmpty { return queued.removeFirst() }
                if closed { return .failure(BridgeError.disconnected) }
                receiver = continuation
                return nil
            }
            if let next { continuation.resume(with: next) }
        }
    }
    func reply(to frame: [String: Any], error: String? = nil, settled: Bool = true) {
        var response: [String: Any] = ["type": "response", "id": frame["id"]!, "operationSettled": settled]
        if let error { response["error"] = ["code": "SERVICE_ERROR", "sub_code": error, "message": error] }
        else { response["ok"] = ["done": true] }
        feed(response)
    }
    private func feed(_ frame: [String: Any]) {
        do { deliver(.success(.data(try JSONSerialization.data(withJSONObject: frame)))) }
        catch { deliver(.failure(error)) }
    }
    private func deliver(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        let continuation = lock.withLock {
            let value = receiver
            receiver = nil
            if value == nil { queued.append(result) }
            return value
        }
        continuation?.resume(with: result)
    }
}
