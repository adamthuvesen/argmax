// Invoked by the ignored native_browser_content_blocking Rust test with the
// production rules JSON. The Swift process gives WebKit a real main run loop.
import AppKit
import WebKit

final class BlockingCheck: NSObject, WKScriptMessageHandler {
    var view: WKWebView?
    var ruleList: WKContentRuleList?
    var index = 0
    let cases: [(String, Bool, Bool, Bool)] = [
        ("https://blocked.example.test", true, false, false),
        ("https://allowed.example.test", true, false, true),
        ("https://notallowed.example.test", true, false, false),
        ("https://sub.allowed.example.test", true, false, false),
        ("https://allowed.example.test", true, true, true),
        ("http://localhost:8123", true, false, true),
        ("http://127.0.0.1:8123", true, false, true),
        ("https://agent.example.test", false, false, true)
    ]

    func start(_ json: String) {
        let started = Date()
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "argmax-native-check-\(UUID().uuidString)", encodedContentRuleList: json) { list, error in
            guard let list = list, error == nil else { self.fail("Compile failed: \(String(describing: error))"); return }
            self.ruleList = list
            print("Compiled production rules in \(Date().timeIntervalSince(started))s")
            self.next()
        }
    }

    func next() {
        guard index < cases.count else {
            print("Passed \(cases.count) native blocking/bypass checks")
            if let list = ruleList { WKContentRuleListStore.default().removeContentRuleList(forIdentifier: list.identifier) { _ in exit(0) } }
            return
        }
        let (origin, filtered, frame, _) = cases[index]
        let config = WKWebViewConfiguration()
        if filtered, let list = ruleList { config.userContentController.add(list) }
        config.userContentController.add(self, name: "result")
        // Attach before constructing the view, matching the Rust open path.
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        let probe = "<script>const s=document.createElement('script');s.src='https://www.google-analytics.com/analytics.js?argmax=\(UUID().uuidString)';s.onload=()=>webkit.messageHandlers.result.postMessage(true);s.onerror=()=>webkit.messageHandlers.result.postMessage(false);document.head.append(s);</script>"
        let html = frame ? "<iframe srcdoc=\"\(probe.replacingOccurrences(of: "\"", with: "&quot;"))\"></iframe>" : probe
        view!.loadHTMLString(html, baseURL: URL(string: origin)!)
        let expectedIndex = index
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            if self.index == expectedIndex { self.fail("Timed out: \(origin)") }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let (origin, filtered, frame, expected) = cases[index]
        guard let loaded = message.body as? Bool, loaded == expected else {
            fail("Unexpected resource result: origin=\(origin), filtered=\(filtered), iframe=\(frame), expected loaded=\(expected), got=\(message.body)")
            return
        }
        print("PASS \(origin) filtered=\(filtered) iframe=\(frame) loaded=\(expected)")
        controller.removeScriptMessageHandler(forName: "result")
        view?.stopLoading()
        view = nil
        index += 1
        DispatchQueue.main.async { self.next() }
    }

    func fail(_ message: String) {
        FileHandle.standardError.write(Data((message + "\n").utf8))
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let check = BlockingCheck()
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "Pass the rules JSON path", code: 1) }
    check.start(try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8))
    app.run()
} catch {
    check.fail(String(describing: error))
}
