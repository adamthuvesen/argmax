import SwiftUI
import WebKit
import XCTest
@testable import Argmax

final class BridgeRecoveryTests: XCTestCase {
    @MainActor
    func testTranscriptClearsDisconnectedFailureAfterARecoveredPage() async throws {
        let first = TestBridgeSocket(), second = TestBridgeSocket()
        let (client, directory) = try makeClient([first, second])
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TranscriptStore(client: client, cache: DeviceCache(directory: directory))
        store.openSession("session-1")

        try await wait {
            first.requests.contains { $0["channel"] as? String == "session:events-since" }
        }
        first.fail()
        for _ in 0..<500 where store.failure == nil {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(store.failure, "Can't reach your Mac.")

        store.receive(connection: .live)
        XCTAssertEqual(store.phase, .loading)
        store.ingest(page: TranscriptPage(
            events: [TranscriptEvent(
                id: "answer-1",
                sessionId: "session-1",
                type: "message.completed",
                message: "Recovered answer",
                payload: .object([:]),
                createdAt: "2026-01-01T00:00:01.000Z",
                rowCursor: 1
            )],
            rawOutputs: [],
            eventCursor: 1,
            rawOutputCursor: 0,
            changeCursor: 1,
            deletedEventIds: [],
            deletedRawOutputIds: [],
            resetRequired: true,
            hasMore: false
        ), for: "session-1", authoritative: true)
        await store.waitForProjection()

        XCTAssertEqual(store.phase, .ready)
        XCTAssertNil(store.failure)
        await client.disconnect()
    }

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

    func testOversizedTranscriptFallsBackToAuthenticatedHTTPWithoutLosingTheBody() async throws {
        let socket = TestBridgeSocket()
        let answer = String(repeating: "x", count: 4 * 1024 * 1024 + 1)
        let responseData = try JSONSerialization.data(withJSONObject: [
            "ok": ["events": [["message": answer]]],
        ])
        let recorder = TestHTTPLoader(result: .success(responseData))
        let (client, directory) = try makeClient([socket], httpLoader: recorder.load)
        defer { try? FileManager.default.removeItem(at: directory) }
        let input = TranscriptEventsSinceInput(
            sessionId: "s-1", eventCursor: 7, rawOutputCursor: 11, changeCursor: 42
        )
        let call = Task { try await client.request("session:events-since", input: input) }
        let sent = try await request(on: socket)
        socket.reply(to: sent, error: "REMOTE_RESPONSE_TOO_LARGE", settled: false)

        let payload = try await call.value
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
        let events = try XCTUnwrap(decoded["events"] as? [[String: Any]])
        XCTAssertEqual(events.first?["message"] as? String, answer)
        XCTAssertGreaterThan(responseData.count, 4 * 1024 * 1024)

        let request = try XCTUnwrap(recorder.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://mac.example/api/transcript")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(envelope["channel"] as? String, "session:events-since")
        XCTAssertEqual(envelope["input"] as? NSDictionary, sent["input"] as? NSDictionary)
        await client.disconnect()
    }

    @MainActor
    func testNativeTweakEditsPersistOutsideWidgetStateAndRestore() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let runtimeURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "visualization-runtime", withExtension: "json"))
        let runtime = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: runtimeURL)) as? [String: Any])
        let script = try XCTUnwrap(runtime["script"] as? String)
        let csp = try XCTUnwrap(runtime["csp"] as? String)
        let artifact = TranscriptVisualizationArtifact(id: "ba83f9e1-cc26-4bb8-b63b-75c41dc6b938", sessionId: "s-1", title: "Design", summary: "", format: "html", runtimeVersion: 1, externalDependencies: [])
        var coordinator: TranscriptVisualizationWeb.Coordinator?
        var groups: [TranscriptVisualizationControls] = []
        func view(value: Int?, identity: String) -> AnyView {
            let storedControls = value.map { "'control-1':\($0)" } ?? ""
            let html = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\"><script>window.__argmaxVisualizationConfig={instanceId:'\(artifact.id)',appearance:{dark:false,variables:{}},controlValues:{\(storedControls)},capabilities:{controls:true}};</script><script>\(script)</script></head><body><div id='design'>Design</div><script>window.settings={gap:14};const t=new Tweak({container:document.getElementById('design'),onChange:()=>{}});t.addSlider(window.settings,'gap',{min:4,max:40,step:1});</script></body></html>"
            let document = TranscriptVisualizationDocument(artifact: artifact, source: "Design", document: html,
                state: .init(modelContent: .null, privateContent: .null), controlValues: value.map { ["control-1": .number(Double($0))] } ?? [:])
            return AnyView(TranscriptVisualizationWeb(document: document, client: client, sessionID: "s-1", appearance: ["dark": false, "variables": [:]],
                height: .constant(240), host: Binding(get: { coordinator }, set: { coordinator = $0 }),
                onFollowUp: { _ in }, onLink: { _ in }, onControls: { groups = $0 },
                onPersistenceFailure: { if let error = $0 { XCTFail(error) } }, onFailure: { XCTFail($0) }).id(identity))
        }
        let controller = UIHostingController(rootView: view(value: nil, identity: "first"))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 400))
        window.rootViewController = controller
        controller.view.frame = window.bounds
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        for _ in 0..<500 {
            if !groups.isEmpty, coordinator?.webView?.isLoading == false { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let first = try XCTUnwrap(coordinator)
        XCTAssertFalse(groups.isEmpty)
        XCTAssertTrue(socket.requests.isEmpty, "Initial control restoration does not write")
        first.send(["type": "argmax:visualization-control", "id": "control-1", "value": 22])
        controller.rootView = AnyView(Text("Paused"))
        let sent = try await request(on: socket)
        XCTAssertEqual(sent["channel"] as? String, "visualization:set-controls")
        let input = try XCTUnwrap(sent["input"] as? [String: Any])
        XCTAssertEqual((input["controlValues"] as? [String: Int])?["control-1"], 22)
        XCTAssertNil(input["state"], "Design edits never replace model/private widget state")
        socket.reply(to: sent, ok: ["control-1": 22])
        await first.flushState()
        groups = []
        controller.rootView = view(value: 22, identity: "restored")
        for _ in 0..<500 {
            if !groups.isEmpty, coordinator?.webView?.isLoading == false { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let restored = try XCTUnwrap(coordinator?.webView)
        let value = try await restored.evaluateJavaScript("window.settings.gap") as? Int
        XCTAssertEqual(value, 22)
        XCTAssertEqual(socket.requests.count, 1, "Restoring saved controls does not write defaults")
        let restoredCoordinator = try XCTUnwrap(coordinator)
        let groupID = try XCTUnwrap(groups.first?.id)
        restoredCoordinator.send(["type": "argmax:visualization-reset", "groupId": groupID])
        controller.rootView = AnyView(Text("Paused"))
        let reset = try await request(on: socket, count: 2)
        let resetInput = try XCTUnwrap(reset["input"] as? [String: Any])
        XCTAssertEqual((resetInput["controlValues"] as? [String: Int])?.count, 0)
        socket.reply(to: reset, ok: [:])
        await restoredCoordinator.flushState()
        groups = []
        controller.rootView = view(value: nil, identity: "reset")
        for _ in 0..<500 {
            if !groups.isEmpty, coordinator?.webView?.isLoading == false { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let resetView = try XCTUnwrap(coordinator?.webView)
        let resetValue = try await resetView.evaluateJavaScript("window.settings.gap") as? Int
        XCTAssertEqual(resetValue, 14, "Reset restores immutable source defaults after immediate eviction")
        await client.disconnect()
    }

    @MainActor
    func testVisualizationPoolRemountWaitsForStateAndReadsFreshDocument() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let pool = TranscriptVisualizationViewers.shared
        for id in pool.active { pool.release(id) }
        let runtimeURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "visualization-runtime", withExtension: "json"))
        let runtime = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: runtimeURL)) as? [String: Any])
        let script = try XCTUnwrap(runtime["script"] as? String)
        let csp = try XCTUnwrap(runtime["csp"] as? String)
        let artifactID = "ba83f9e1-cc26-4bb8-b63b-75c41dc6b938"
        func response(filter: Int) -> [String: Any] {
            let html = "<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"\(csp)\"><script>window.__argmaxVisualizationConfig={instanceId:'\(artifactID)',appearance:{dark:false,variables:{}},state:{modelContent:{filter:\(filter)},privateContent:null}};</script><script>\(script)</script></head><body><p>Filter \(filter)</p></body></html>"
            return ["artifact": ["id": artifactID, "sessionId": "s-1", "title": "Chart", "summary": "Filter", "format": "html", "runtimeVersion": 1, "externalDependencies": []],
                    "source": "<p>Filter</p>", "document": html,
                    "state": ["modelContent": ["filter": filter], "privateContent": NSNull()], "controlValues": [:]]
        }
        func webView(in view: UIView) -> WKWebView? {
            if let webView = view as? WKWebView { return webView }
            return view.subviews.lazy.compactMap { webView(in: $0) }.first
        }
        func reads() -> [[String: Any]] { socket.requests.filter { $0["channel"] as? String == "visualization:read" } }
        let card = TranscriptVisualizationCard(sessionID: "s-1", reference: .artifact(artifactID), title: "Chart", summary: "Filter", client: client)
            .environment(\.visualizationSessionID, "s-1")
        let controller = UIHostingController(rootView: card)
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 640))
        window.rootViewController = controller
        controller.view.frame = window.bounds
        @MainActor func waitUI(_ phase: String, _ condition: @MainActor () -> Bool, line: UInt = #line) async throws {
            let deadline = Date().addingTimeInterval(5)
            while !condition() {
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
                window.layoutIfNeeded()
                guard Date() < deadline else {
                    XCTFail("Timed out waiting for visualization UI phase \(phase). Bounds: \(controller.view.bounds), active: \(pool.active.count), leases: \(pool.leases.count), requests: \(socket.requests.map { $0["channel"] as? String ?? "unknown" }), hierarchy: \(controller.view.subviews.map { String(describing: type(of: $0)) })", line: line)
                    throw BridgeError.disconnected
                }
                try await Task.sleep(for: .milliseconds(10))
            }
        }
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            for id in pool.active { pool.release(id) }
        }
        try await waitUI("first read") { reads().count == 1 }
        let initialResponse = response(filter: 7)
        _ = try JSONDecoder().decode(TranscriptVisualizationDocument.self, from: JSONSerialization.data(withJSONObject: initialResponse))
        socket.reply(to: reads()[0], ok: initialResponse)
        try await waitUI("viewer loaded") { webView(in: controller.view)?.isLoading == false }
        let original = try XCTUnwrap(webView(in: controller.view))
        _ = try await original.evaluateJavaScript("window.openai.setWidgetState({modelContent:{filter:19},privateContent:null});void 0")
        try await waitUI("state write") { socket.requests.contains { $0["channel"] as? String == "visualization:set-state" } }
        let save = try XCTUnwrap(socket.requests.first { $0["channel"] as? String == "visualization:set-state" })
        let cardID = try XCTUnwrap(pool.active.first)
        for _ in 0..<3 { pool.activate(UUID(), replacing: true) }
        try await waitUI("evicted") { webView(in: controller.view) == nil }
        pool.activate(cardID, replacing: true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(reads().count, 1, "Restoring waits for the pending state write")
        XCTAssertNil(webView(in: controller.view), "Cached source cannot mount while restoration waits")
        socket.reply(to: save, ok: ["modelContent": ["filter": 19], "privateContent": NSNull()])
        try await waitUI("restored read") { reads().count == 2 }
        socket.reply(to: reads()[1], ok: response(filter: 19))
        try await waitUI("viewer loaded") { webView(in: controller.view)?.isLoading == false }
        let restored = try XCTUnwrap(webView(in: controller.view))
        XCTAssertFalse(original === restored)
        let filter = try await restored.evaluateJavaScript("window.openai.widgetState.modelContent.filter") as? Int
        XCTAssertEqual(filter, 19)
        window.isHidden = true
        window.rootViewController = nil
        for id in pool.active { pool.release(id) }
        await client.disconnect()
    }

    func testVisualizationReadsAndExportUseAuthenticatedOversizedFallback() async throws {
        let answer = String(repeating: "x", count: 4 * 1024 * 1024 + 1)
        for channel in ["visualization:read", "visualization:export"] {
            let socket = TestBridgeSocket()
            let responseData = try JSONSerialization.data(withJSONObject: ["ok": ["source": answer]])
            let recorder = TestHTTPLoader(result: .success(responseData))
            let (client, directory) = try makeClient([socket], httpLoader: recorder.load)
            defer { try? FileManager.default.removeItem(at: directory) }
            let input = TranscriptVisualizationIdentity(sessionId: "s-1", artifactId: "ba83f9e1-cc26-4bb8-b63b-75c41dc6b938")
            let call = Task { try await client.request(channel, input: input) }
            let sent = try await request(on: socket)
            socket.reply(to: sent, error: "REMOTE_RESPONSE_TOO_LARGE", settled: false)
            let payload = try await call.value
            let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: payload) as? [String: Any])
            XCTAssertEqual(decoded["source"] as? String, answer)
            let http = try XCTUnwrap(recorder.requests.first)
            XCTAssertEqual(http.value(forHTTPHeaderField: "Authorization"), "Bearer test")
            XCTAssertEqual(http.url?.path, "/api/transcript")
            let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(http.httpBody)) as? [String: Any])
            XCTAssertEqual(envelope["channel"] as? String, channel)
            XCTAssertEqual(envelope["input"] as? NSDictionary, sent["input"] as? NSDictionary)
            await client.disconnect()
        }
    }

    func testTranscriptHTTPErrorUsesHostErrorAndMutationDoesNotFallback() async throws {
        let socket = TestBridgeSocket()
        let response = try JSONSerialization.data(withJSONObject: [
            "error": [
                "code": "SERVICE_ERROR",
                "sub_code": "TRANSCRIPT_FAILED",
                "message": "transcript failed",
            ],
        ])
        let recorder = TestHTTPLoader(result: .success(response))
        let (client, directory) = try makeClient([socket], httpLoader: recorder.load)
        defer { try? FileManager.default.removeItem(at: directory) }

        let read = Task { try await client.request("session:agent-events", input: ["sessionId": "s-1"]) }
        let readFrame = try await request(on: socket)
        socket.reply(to: readFrame, error: "REMOTE_RESPONSE_TOO_LARGE", settled: false)
        do {
            _ = try await read.value
            XCTFail("expected the HTTP dispatcher error")
        } catch {
            XCTAssertEqual(error as? BridgeError, .host(
                code: "SERVICE_ERROR", subCode: "TRANSCRIPT_FAILED", message: "transcript failed"
            ))
        }

        let mutation = Task { try await client.request("session:stop", input: ["sessionId": "s-1"]) }
        let mutationFrame = try await request(on: socket, count: 2)
        socket.reply(to: mutationFrame, error: "REMOTE_RESPONSE_TOO_LARGE", settled: true)
        do {
            _ = try await mutation.value
            XCTFail("mutation must not use the transcript endpoint")
        } catch {
            guard case .host(_, let subCode, _) = error as? BridgeError else {
                return XCTFail("expected a host error, got \(error)")
            }
            XCTAssertEqual(subCode, "REMOTE_RESPONSE_TOO_LARGE")
        }
        XCTAssertEqual(recorder.requests.count, 1)
        await client.disconnect()
    }

    func testCancellingTranscriptHTTPFallbackCancelsTheRequest() async throws {
        let socket = TestBridgeSocket()
        let loader = BlockingHTTPLoader()
        let (client, directory) = try makeClient([socket], httpLoader: loader.load)
        defer { try? FileManager.default.removeItem(at: directory) }
        let call = Task { try await client.request("session:events-since", input: ["sessionId": "s-1"]) }
        let sent = try await request(on: socket)
        socket.reply(to: sent, error: "REMOTE_RESPONSE_TOO_LARGE", settled: false)
        try await wait { loader.hasStarted }

        call.cancel()

        do {
            _ = try await call.value
            XCTFail("expected cancellation")
        } catch is CancellationError {}
        XCTAssertTrue(loader.wasCancelled)
        await client.disconnect()
    }

    func testReconnectCancelsTranscriptHTTPFallbackAndAllowsAnAuthoritativeRead() async throws {
        let first = TestBridgeSocket(), second = TestBridgeSocket()
        let loader = BlockingHTTPLoader()
        let (client, directory) = try makeClient([first, second], httpLoader: loader.load)
        defer { try? FileManager.default.removeItem(at: directory) }
        let stale = Task { try await client.request("session:events-since", input: ["sessionId": "s-1"]) }
        let sent = try await request(on: first)
        first.reply(to: sent, error: "REMOTE_RESPONSE_TOO_LARGE", settled: false)
        try await wait { loader.hasStarted }

        await client.reconnectNow(force: true)

        do {
            _ = try await stale.value
            XCTFail("reconnect must cancel the stale HTTP read")
        } catch {
            XCTAssertEqual(error as? BridgeError, .disconnected)
        }
        XCTAssertTrue(loader.wasCancelled)

        let authoritative = Task { try await client.request("session:events-since", input: ["sessionId": "s-1"]) }
        let reread = try await request(on: second)
        second.reply(to: reread)
        _ = try await authoritative.value
        await client.disconnect()
    }

    /// A chat read live in this process catches up through the change feed
    /// after a reconnect instead of downloading itself again.
    @MainActor
    func testReconnectCatchesALiveChatUpFromItsChangeCursor() async throws {
        let first = TestBridgeSocket(), second = TestBridgeSocket()
        let (client, directory) = try makeClient([first, second])
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TranscriptStore(client: client, cache: DeviceCache(directory: directory))
        func transcriptReads(_ socket: TestBridgeSocket) -> [[String: Any]] {
            socket.requests.filter { $0["channel"] as? String == "session:events-since" }
        }
        store.openSession("s-1")
        try await wait { !transcriptReads(first).isEmpty }
        first.reply(to: try XCTUnwrap(transcriptReads(first).first), ok: [
            "events": [["id": "e-1", "sessionId": "s-1", "type": "message.completed", "message": "Hello",
                        "payload": [String: Any](), "createdAt": "2026-01-01T00:00:01.000Z", "rowCursor": 1]],
            "rawOutputs": [Any](), "eventCursor": 1, "rawOutputCursor": 0, "changeCursor": 5,
            "deletedEventIds": [Any](), "deletedRawOutputIds": [Any](), "resetRequired": true, "hasMore": false,
        ])
        try await wait { !store.items.isEmpty }

        store.receive(connection: .reconnecting(since: Date()))
        await client.reconnectNow(force: true)
        store.receive(connection: .live)
        try await wait { !transcriptReads(second).isEmpty }
        let input = try XCTUnwrap(transcriptReads(second).first?["input"] as? [String: Any])
        XCTAssertEqual(input["changeCursor"] as? Int, 5, "A live chat resumes from its change cursor")
        store.closeSession()
        await client.disconnect()
    }

    @MainActor
    func testReturningToAChatHeldInMemoryCatchesUpFromItsChangeCursor() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TranscriptStore(client: client, cache: DeviceCache(directory: directory))
        func transcriptReads() -> [[String: Any]] {
            socket.requests.filter { $0["channel"] as? String == "session:events-since" }
        }
        func page(_ session: String, _ ids: [String], changeCursor: Int, reset: Bool) -> [String: Any] {
            ["events": ids.enumerated().map { index, id in
                ["id": id, "sessionId": session, "type": "message.completed", "message": id,
                 "payload": [String: Any](), "createdAt": "2026-01-01T00:00:0\(index + 1).000Z", "rowCursor": index + 1]
             },
             "rawOutputs": [Any](), "eventCursor": ids.count, "rawOutputCursor": 0, "changeCursor": changeCursor,
             "deletedEventIds": [Any](), "deletedRawOutputIds": [Any](), "resetRequired": reset, "hasMore": false]
        }
        store.openSession("s-1")
        try await wait { transcriptReads().count == 1 }
        socket.reply(to: transcriptReads()[0], ok: page("s-1", ["hello"], changeCursor: 5, reset: true))
        try await wait { !store.items.isEmpty }
        store.openSession("s-2")
        try await wait { transcriptReads().count == 2 }
        socket.reply(to: transcriptReads()[1], ok: page("s-2", ["other"], changeCursor: 9, reset: true))
        await store.flushCache()

        store.openSession("s-1")
        try await wait { transcriptReads().count == 3 }
        let input = try XCTUnwrap(transcriptReads()[2]["input"] as? [String: Any])
        XCTAssertEqual(input["changeCursor"] as? Int, 5, "A chat read live this session resumes from its cursor")
        let before = store.items
        socket.reply(to: transcriptReads()[2], ok: page("s-1", ["hello", "again"], changeCursor: 7, reset: false))
        try await wait { !store.showingCachedContent }
        await store.waitForProjection()
        XCTAssertNotEqual(store.items, before, "The catch-up page lands on the restored rows")
        store.closeSession()
        await client.disconnect()
    }

    func testDashboardReadsShareOneRequestUntilTheHostSignalsAChange() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        var events = client.events.makeAsyncIterator()
        func dashboardReads() -> Int { socket.requests.filter { $0["channel"] as? String == "dashboard:list" }.count }

        let first = Task { try await client.request("dashboard:list") }
        let read = try await request(on: socket)
        let joined = Task { try await client.request("dashboard:list") }
        socket.reply(to: read, ok: ["sessions": []])
        _ = try await first.value
        _ = try await joined.value
        _ = try await client.request("dashboard:list")
        XCTAssertEqual(dashboardReads(), 1, "Readers of the same host state share one read")

        socket.push(["type": "event", "channel": "dashboard:delta", "payload": ["changedSessionIds": ["s"]]])
        _ = await events.next()
        _ = try await client.request("dashboard:list")
        XCTAssertEqual(dashboardReads(), 1, "A streamed chunk does not change the dashboard")

        socket.push(["type": "event", "channel": "dashboard:delta", "payload": ["dashboardChanged": true]])
        _ = await events.next()
        let fresh = Task { try await client.request("dashboard:list") }
        socket.reply(to: try await request(on: socket, count: 2), ok: ["sessions": []])
        _ = try await fresh.value
        XCTAssertEqual(dashboardReads(), 2, "A change hint needs a new read")
        await client.disconnect()
    }

    func testDeflatedFramesFromTheHostReadLikeText() async throws {
        let socket = TestBridgeSocket()
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        let rows = Array(repeating: ["id": "row", "text": "the same words again"], count: 2_000)
        let result = Task { try await client.request("projects:list") }
        let request = try await request(on: socket)
        XCTAssertEqual(socket.authFrame?["compression"] as? String, "deflate")
        socket.pushDeflated(["type": "response", "id": request["id"]!, "ok": rows])
        let data = try await result.value
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? NSArray, rows as NSArray)
        await client.disconnect()
    }

    func testDashboardReadsMergeTheHostsChangesIntoTheLastSnapshot() async throws {
        let socket = TestBridgeSocket(dashboardChanges: true)
        let (client, directory) = try makeClient([socket])
        defer { try? FileManager.default.removeItem(at: directory) }
        var events = client.events.makeAsyncIterator()
        func read(answering answers: [[String: Any]]) async throws -> NSDictionary {
            if !socket.requests.isEmpty {
                socket.push(["type": "event", "channel": "dashboard:delta", "payload": ["dashboardChanged": true]])
                _ = await events.next()
            }
            let before = socket.requests.count
            let result = Task { try await client.request("dashboard:list") }
            for (index, answer) in answers.enumerated() {
                socket.reply(to: try await request(on: socket, count: before + index + 1), ok: answer)
            }
            let data = try await result.value
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
        }
        func baseDigest(_ index: Int) -> String? {
            (socket.requests[index]["input"] as? [String: Any])?["baseDigest"] as? String
        }

        let first = try await read(answering: [["digest": "d1", "snapshot": [
            "sessions": [["id": "a", "state": "idle"], ["id": "b", "state": "idle"]], "arcs": []]]])
        XCTAssertEqual(socket.requests[0]["channel"] as? String, "dashboard:changes")
        XCTAssertNil(baseDigest(0))
        XCTAssertEqual(first, ["sessions": [["id": "a", "state": "idle"], ["id": "b", "state": "idle"]], "arcs": []])

        let changed = try await read(answering: [["digest": "d2", "base": "d1", "remove": [],
            "collections": ["sessions": ["upsert": [["id": "c", "state": "idle"], ["id": "b", "state": "running"]],
                                         "remove": ["a"], "order": ["c", "b"]]],
            "replace": ["arcs": [["id": "x"]]]]])
        XCTAssertEqual(baseDigest(1), "d1")
        XCTAssertEqual(changed, ["sessions": [["id": "c", "state": "idle"], ["id": "b", "state": "running"]],
                                 "arcs": [["id": "x"]]])

        // A diff against anything but what this phone holds is never applied.
        let recovered = try await read(answering: [
            ["digest": "d4", "base": "d3", "collections": [:], "replace": [:], "remove": []],
            ["digest": "d5", "snapshot": ["sessions": [], "arcs": []]],
        ])
        XCTAssertEqual(baseDigest(2), "d2")
        XCTAssertNil(baseDigest(3))
        XCTAssertEqual(recovered, ["sessions": [], "arcs": []])
        await client.disconnect()
    }

    private func makeClient(
        _ sockets: [TestBridgeSocket],
        httpLoader: (@Sendable (URLRequest) async throws -> (Data, URLResponse))? = nil
    ) throws -> (BridgeClient, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sequence = TestSocketSequence(sockets)
        let client = try BridgeClient(pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=test")),
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in sequence.next() },
            httpLoader: httpLoader)
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

private final class TestHTTPLoader: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedRequests: [URLRequest] = []
    private let result: Result<Data, Error>

    init(result: Result<Data, Error>) {
        self.result = result
    }

    var requests: [URLRequest] { lock.withLock { recordedRequests } }

    func load(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { recordedRequests.append(request) }
        let data = try result.get()
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private final class BlockingHTTPLoader: @unchecked Sendable {
    private let lock = NSLock()
    private var started = false
    private var cancelled = false

    var hasStarted: Bool { lock.withLock { started } }
    var wasCancelled: Bool { lock.withLock { cancelled } }

    func load(_ request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { started = true }
        do {
            try await Task.sleep(for: .seconds(60))
        } catch {
            lock.withLock { cancelled = true }
            throw error
        }
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

final class TestBridgeSocket: BridgeSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [[String: Any]] = []
    private var queued: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var auth: CheckedContinuation<Void, Error>?
    private var closed = false
    private let holdAuth: Bool
    private let dashboardChanges: Bool
    init(holdAuth: Bool = false, dashboardChanges: Bool = false) {
        self.holdAuth = holdAuth
        self.dashboardChanges = dashboardChanges
    }
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
            else { feed(["type": "auth-ok", "operationReplay": true, "dashboardChanges": dashboardChanges]) }
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
    func reply(to frame: [String: Any], ok: Any = ["done": true], error: String? = nil, settled: Bool = true) {
        var response: [String: Any] = ["type": "response", "id": frame["id"]!, "operationSettled": settled]
        if let error { response["error"] = ["code": "SERVICE_ERROR", "sub_code": error, "message": error] }
        else { response["ok"] = ok }
        feed(response)
    }
    func push(_ frame: [String: Any]) { feed(frame) }
    /// The host's binary frame: a zero byte, then the JSON as raw DEFLATE.
    func pushDeflated(_ frame: [String: Any]) {
        do {
            let json = try JSONSerialization.data(withJSONObject: frame)
            let compressed = try (json as NSData).compressed(using: .zlib) as Data
            deliver(.success(.data(Data([0]) + compressed)))
        } catch { deliver(.failure(error)) }
    }
    var authFrame: [String: Any]? { lock.withLock { messages.first { $0["type"] as? String == "auth" } } }
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
