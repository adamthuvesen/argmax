#if DEBUG
import SwiftUI

/// Exercises the production card with deterministic bridge responses and a
/// small page that reports its actual viewport through the native bridge.
struct TranscriptVisualizationScenario: View {
    @StateObject private var scenario = TranscriptVisualizationScenarioState()

    var body: some View {
        ScrollView {
            TranscriptVisualizationCard(
                sessionID: "visualization-scenario", reference: .artifact("visualization-scenario-artifact"),
                title: "Visualization sizing", summary: "A saved selection survives presentation.",
                format: "html", client: scenario.client
            )
            .environment(\.visualizationSessionID, "visualization-scenario")
            .padding()
        }
        .background(Theme.ground)
    }
}

@MainActor
private final class TranscriptVisualizationScenarioState: ObservableObject {
    let client: BridgeClient

    init() {
        let socket = TranscriptVisualizationScenarioSocket(
            viewport: ProcessInfo.processInfo.arguments.contains("-scenario-viewport-visualization")
        )
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        client = try! BridgeClient(
            pairingURL: URL(string: "https://visualization-scenario.invalid/mobile.html#token=scenario")!,
            operationDirectory: directory, monitorNetwork: false, socketFactory: { _ in socket },
            httpLoader: { _ in throw BridgeError.disconnected }
        )
    }
}

private actor TranscriptVisualizationScenarioSocket: BridgeSocket {
    private let viewport: Bool
    private var selection = 7
    private var queued: [URLSessionWebSocketTask.Message] = []
    private var receiver: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var closed = false

    init(viewport: Bool) { self.viewport = viewport }
    nonisolated func resume() {}
    nonisolated func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        Task { await close() }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if !queued.isEmpty { return queued.removeFirst() }
        if closed { throw BridgeError.disconnected }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data
        switch message {
        case .string(let string): data = Data(string.utf8)
        case .data(let value): data = value
        @unknown default: throw BridgeError.malformedResponse
        }
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BridgeError.malformedResponse
        }
        if frame["type"] as? String == "auth" {
            try deliver(["type": "auth-ok", "operationReplay": true])
            return
        }
        if frame["type"] as? String == "ping" { try deliver(["type": "pong"]); return }
        guard let id = frame["id"], frame["type"] as? String == "request" else {
            throw BridgeError.malformedResponse
        }
        var response: [String: Any] = ["type": "response", "id": id, "operationSettled": true]
        switch frame["channel"] as? String {
        case "visualization:read": response["ok"] = document()
        case "visualization:set-state":
            guard let input = frame["input"] as? [String: Any], let state = input["state"] as? [String: Any],
                  let content = state["modelContent"] as? [String: Any], let selected = content["selection"] as? Int else {
                throw BridgeError.malformedResponse
            }
            // Keep the save pending while the reader presses Expand or Done.
            // A new document must wait for the production coordinator's flush.
            try await Task.sleep(for: .milliseconds(1_500))
            selection = selected
            response["ok"] = state
        default:
            response["error"] = ["code": "SERVICE_ERROR", "message": "Unsupported visualization scenario channel."]
        }
        try deliver(response)
    }

    private func document() -> [String: Any] {
        let html = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>html,body{margin:0;padding:0;box-sizing:border-box}body{\(viewport ? "min-height:100vh" : "height:180px");font:17px system-ui;background:#d6e6ff;color:#15223d;padding:16px}button{font:inherit;padding:12px}</style>
        </head><body><p id="selected">Selected \(selection)</p><button id="change">Change selection</button>
        <script>
        let selection=\(selection),request=0;
        function post(message){window.webkit.messageHandlers.argmaxVisualization.postMessage({...message,instanceId:'visualization-scenario-artifact'});}
        function display(){document.getElementById('selected').textContent='Selected '+selection;}
        window.__argmaxVisualizationReceive=message=>{
          if(message.type==='argmax:visualization-state'){selection=message.state.modelContent.selection;display();}
        };
        document.getElementById('change').onclick=()=>{
          selection++;display();post({type:'argmax:visualization-state',requestId:'selection-'+(++request),state:{modelContent:{selection},privateContent:null}});
        };
        function height(){post({type:'argmax:visualization-height',height:document.body.getBoundingClientRect().height});}
        new ResizeObserver(height).observe(document.body);addEventListener('resize',height);height();
        </script></body></html>
        """
        return ["artifact": ["id": "visualization-scenario-artifact", "sessionId": "visualization-scenario",
                             "title": "Visualization sizing", "summary": "Saved selection", "format": "html",
                             "runtimeVersion": 1, "externalDependencies": []],
                "source": html, "document": html,
                "state": ["modelContent": ["selection": selection], "privateContent": NSNull()], "controlValues": [:]]
    }

    private func deliver(_ frame: [String: Any]) throws {
        let message = URLSessionWebSocketTask.Message.data(try JSONSerialization.data(withJSONObject: frame))
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: message)
        } else { queued.append(message) }
    }

    private func close() {
        closed = true
        receiver?.resume(throwing: BridgeError.disconnected)
        receiver = nil
    }
}
#endif
