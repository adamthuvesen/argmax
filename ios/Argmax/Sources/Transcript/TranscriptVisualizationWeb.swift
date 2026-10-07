import Combine
import SwiftUI
import WebKit

/// Only the artifact document receives this bridge. Its webview has no shared
/// cookie store, app IPC, local file access, or authenticated remote URL.
struct TranscriptVisualizationWeb: UIViewRepresentable {
    let document: TranscriptVisualizationDocument
    let client: BridgeClient
    let sessionID: String
    let appearance: [String: Any]
    @Binding var height: CGFloat
    @Binding var host: Coordinator?
    let onFollowUp: (String) -> Void
    let onLink: (URL) -> Void
    let onControls: ([TranscriptVisualizationControls]) -> Void
    var onPersistenceFailure: (String?) -> Void = { _ in }
    let onFailure: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "argmaxVisualization")
        let webView = VisualizationWKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = true
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        webView.loadHTMLString(document.document, baseURL: nil)
        DispatchQueue.main.async { host = context.coordinator }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.send(["type": "argmax:visualization-appearance", "appearance": appearance])
    }

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading()
        uiView.navigationDelegate = nil
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: "argmaxVisualization")
        coordinator.webView = nil
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: TranscriptVisualizationWeb
        weak var webView: WKWebView?
        private var pendingWrites = 0
        private var controlGroups: [TranscriptVisualizationControls] = []
        private var controlValues: [String: TranscriptJSONValue]
        private var stateWrite: Task<Void, Never>?
        private var ready = false
        private var pendingReplies: [[String: Any]] = []

        init(_ parent: TranscriptVisualizationWeb) {
            self.parent = parent
            self.controlValues = parent.document.controlValues
        }

        func send(_ input: [String: Any], persistControls: Bool = true) {
            guard let webView else { return }
            if persistControls { persistControlIntent(input) }
            if !ready {
                if ["argmax:visualization-ack", "argmax:visualization-control", "argmax:visualization-reset"].contains(input["type"] as? String ?? ""), pendingReplies.count < 128 {
                    pendingReplies.append(input)
                }
                return
            }
            var message = input
            message["instanceId"] = parent.document.artifact.id
            guard JSONSerialization.isValidJSONObject(message),
                  let data = try? JSONSerialization.data(withJSONObject: message),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.__argmaxVisualizationReceive?.(\(json));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            let replies = pendingReplies
            pendingReplies.removeAll()
            for reply in replies { send(reply, persistControls: false) }
            send(["type": "argmax:visualization-appearance", "appearance": parent.appearance])
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // loadHTMLString's sole navigation. The document cannot load a new
            // top-level page or turn a CDN request into an app-capable bridge.
            if navigationAction.request.url?.absoluteString == "about:blank",
               navigationAction.navigationType == .other, !ready {
                decisionHandler(.allow)
            } else { decisionHandler(.cancel) }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.onFailure("The visualization stopped. Try again to reload it.")
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.onFailure("The visualization could not load. \(error.localizedDescription)")
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.onFailure("The visualization could not load. \(error.localizedDescription)")
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = TranscriptVisualizationMessage.validated(message.body, instanceID: parent.document.artifact.id,
                                                                     mainFrame: message.frameInfo.isMainFrame),
                  let type = body["type"] as? String else { return }
            switch type {
            case "argmax:visualization-height":
                if let height = body["height"] as? Double, height.isFinite {
                    parent.height = CGFloat(min(1_200, max(120, height)))
                }
            case "argmax:visualization-state": saveState(body)
            case "argmax:visualization-follow-up":
                guard let prompt = body["prompt"] as? String, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      prompt.utf16.count <= 32_000 else { ack(body, error: "Invalid follow-up request."); return }
                parent.onFollowUp(prompt)
                ack(body)
            case "argmax:visualization-link":
                guard let value = body["url"] as? String, value.count <= 2_048,
                      let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                      url.host != nil, url.user == nil, url.password == nil else { return }
                parent.onLink(url)
            case "argmax:visualization-controls":
                guard let groups = body["groups"], let decoded = TranscriptVisualizationControls.decodeGroups(groups) else { return }
                controlGroups = decoded
                parent.onControls(decoded)
            default: break
            }
        }

        private func persistControlIntent(_ input: [String: Any]) {
            if input["type"] as? String == "argmax:visualization-control" {
                guard let id = input["id"] as? String,
                      let schema = controlGroups.flatMap(\.controls).first(where: { $0.id == id }),
                      let raw = input["value"],
                      let data = try? JSONSerialization.data(withJSONObject: raw, options: .fragmentsAllowed),
                      let value = try? JSONDecoder().decode(TranscriptJSONValue.self, from: data),
                      schema.accepts(value) else { return }
                controlValues[id] = value
                saveControls()
            } else if input["type"] as? String == "argmax:visualization-reset" {
                let groupID = input["groupId"] as? String
                let groups = controlGroups.filter { groupID == nil || $0.id == groupID }
                guard !groups.isEmpty else { return }
                for control in groups.flatMap(\.controls) { controlValues.removeValue(forKey: control.id) }
                saveControls()
            }
        }

        private func saveControls() {
            guard let data = try? JSONEncoder().encode(controlValues), data.count <= 16_384 else {
                parent.onPersistenceFailure("Design state exceeds 16 KiB.")
                return
            }
            guard pendingWrites < 32 else {
                parent.onPersistenceFailure("Too many pending design changes. Try again.")
                return
            }
            pendingWrites += 1
            let previous = stateWrite
            let client = parent.client
            let sessionID = parent.sessionID
            let artifactID = parent.document.artifact.id
            let values = controlValues
            stateWrite = Task { @MainActor [weak self] in
                await previous?.value
                defer { self?.pendingWrites -= 1 }
                do {
                    try await client.visualizationSaveControls(sessionID: sessionID, artifactID: artifactID, controlValues: values)
                    self?.parent.onPersistenceFailure(nil)
                } catch { self?.parent.onPersistenceFailure("Design changes could not be saved. Check your connection.") }
            }
        }

        func flushState() async { await stateWrite?.value }

        private func ack(_ body: [String: Any], error: String? = nil) {
            guard let requestID = body["requestId"] as? String, requestID.count <= 128 else { return }
            var reply: [String: Any] = ["type": "argmax:visualization-ack", "requestId": requestID]
            if let error { reply["error"] = error }
            send(reply)
        }

        private func saveState(_ body: [String: Any]) {
            guard let raw = body["state"], JSONSerialization.isValidJSONObject(raw),
                  let data = try? JSONSerialization.data(withJSONObject: raw), data.count <= 16_384,
                  let state = try? JSONDecoder().decode(TranscriptVisualizationState.self, from: data) else {
                ack(body, error: "Widget state must be valid JSON under 16 KiB."); return
            }
            guard pendingWrites < 32 else { ack(body, error: "Too many pending widget state updates."); return }
            pendingWrites += 1
            let previous = stateWrite
            let client = parent.client
            let sessionID = parent.sessionID
            let artifactID = parent.document.artifact.id
            stateWrite = Task { @MainActor [weak self] in
                await previous?.value
                defer { self?.pendingWrites -= 1 }
                do {
                    try await client.visualizationSaveState(sessionID: sessionID, artifactID: artifactID, state: state)
                    self?.ack(body)
                    self?.parent.onPersistenceFailure(nil)
                } catch {
                    self?.ack(body, error: "Widget state could not be saved.")
                    self?.parent.onPersistenceFailure("Widget state could not be saved. Check your connection.")
                }
            }
        }
    }
}

/// Several nearby cards can be mounted by a lazy transcript. Keep an explicit
/// limit so those rows cannot create an unbounded number of WebKit processes.
@MainActor
final class TranscriptVisualizationViewers: ObservableObject {
    static let shared = TranscriptVisualizationViewers()
    static let capacity = 3
    @Published private(set) var active: [UUID] = []
    @Published private(set) var leases: [UUID: UUID] = [:]

    func activate(_ id: UUID, replacing: Bool = false) {
        guard !active.contains(id) else { return }
        if active.count == Self.capacity {
            guard replacing else { return }
            let removed = active.removeFirst()
            leases.removeValue(forKey: removed)
        }
        leases[id] = UUID()
        active.append(id)
    }
    func release(_ id: UUID) {
        active.removeAll { $0 == id }
        leases.removeValue(forKey: id)
    }
}

private final class VisualizationWKWebView: WKWebView {
    override func layoutSubviews() {
        super.layoutSubviews()
        scrollView.isScrollEnabled = scrollView.contentSize.height > bounds.height + 1
    }
}
