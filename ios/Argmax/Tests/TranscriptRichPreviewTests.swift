import WebKit
import XCTest

@testable import Argmax

/// Exercises the generated viewer from the app bundle through the same
/// `file://` origin and entry point used by `TranscriptRichWebView`.
@MainActor
final class TranscriptRichPreviewTests: XCTestCase {
    private let frame = CGRect(x: 0, y: 0, width: 390, height: 844)

    func testBundledViewerRendersMathAndMermaidFromAFileURL() async throws {
        let index = try XCTUnwrap(
            Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "RichContent")
        )
        XCTAssertTrue(index.isFileURL)

        let navigationFinished = expectation(description: "rich-content bundle loaded")
        let navigation = NavigationWaiter(expectation: navigationFinished)
        let webView = WKWebView(frame: frame)
        webView.navigationDelegate = navigation
        defer {
            webView.stopLoading()
            webView.navigationDelegate = nil
        }

        webView.loadFileURL(index, allowingReadAccessTo: index.deletingLastPathComponent())
        await fulfillment(of: [navigationFinished], timeout: 10)
        if let failure = navigation.failure {
            throw failure
        }

        try await waitUntil(
            in: webView,
            script: "typeof window.renderArgmaxRich === 'function'",
            failure: "the bundled module did not install window.renderArgmaxRich after a file URL load"
        )

        let math = TranscriptRichWebView.Payload(
            kind: "math",
            source: #"x^2 + y^2 = z^2"#,
            theme: "light",
            display: true,
            expanded: false
        )
        try await render(math, in: webView)
        let mathSnapshot = try await waitForVisibleElement("#content .katex", in: webView)
        XCTAssertGreaterThan(mathSnapshot.width, 0)
        XCTAssertGreaterThan(mathSnapshot.height, 0)
        XCTAssertTrue(mathSnapshot.text.contains("x"))

        let mermaid = TranscriptRichWebView.Payload(
            kind: "mermaid",
            source: "flowchart LR\nInput --> Output",
            theme: "dark",
            display: true,
            expanded: false
        )
        try await render(mermaid, in: webView)
        let mermaidSnapshot = try await waitForVisibleElement("#content svg", in: webView)
        XCTAssertGreaterThan(mermaidSnapshot.width, 0)
        XCTAssertGreaterThan(mermaidSnapshot.height, 0)
        XCTAssertTrue(mermaidSnapshot.text.contains("Input"))
        XCTAssertTrue(mermaidSnapshot.text.contains("Output"))
    }

    private func render(_ payload: TranscriptRichWebView.Payload, in webView: WKWebView) async throws {
        let data = try JSONEncoder().encode(payload)
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        _ = try await webView.evaluateJavaScript("void window.renderArgmaxRich(\(json))")
    }

    private func waitUntil(
        in webView: WKWebView,
        script: String,
        failure: String,
        timeout: TimeInterval = 10
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if try await webView.evaluateJavaScript(script) as? Bool == true {
                return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        XCTFail(failure)
        throw ViewerFailure.entryPointUnavailable
    }

    private func waitForVisibleElement(
        _ selector: String,
        in webView: WKWebView,
        timeout: TimeInterval = 10
    ) async throws -> DOMSnapshot {
        let selectorData = try JSONEncoder().encode(selector)
        let encodedSelector = try XCTUnwrap(String(data: selectorData, encoding: .utf8))
        let script = """
        (() => {
          const element = document.querySelector(\(encodedSelector));
          if (!element) return null;
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            width: bounds.width,
            height: bounds.height,
            text: document.querySelector('#content')?.textContent ?? '',
            visible: style.display !== 'none' && style.visibility !== 'hidden',
            error: document.querySelector('#content')?.dataset.error ?? ''
          };
        })()
        """
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            if let value = try await webView.evaluateJavaScript(script) as? [String: Any],
               let snapshot = DOMSnapshot(value), snapshot.visible,
               snapshot.width > 0, snapshot.height > 0, snapshot.error.isEmpty {
                return snapshot
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        throw ViewerFailure.noVisibleElement(selector)
    }
}

@MainActor
private final class NavigationWaiter: NSObject, WKNavigationDelegate {
    private let expectation: XCTestExpectation
    private(set) var failure: Error?

    init(expectation: XCTestExpectation) {
        self.expectation = expectation
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        expectation.fulfill()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failure = error
        expectation.fulfill()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failure = error
        expectation.fulfill()
    }
}

private struct DOMSnapshot {
    let width: Double
    let height: Double
    let text: String
    let visible: Bool
    let error: String

    init?(_ value: [String: Any]) {
        guard let width = value["width"] as? Double,
              let height = value["height"] as? Double,
              let text = value["text"] as? String,
              let visible = value["visible"] as? Bool,
              let error = value["error"] as? String
        else { return nil }
        self.width = width
        self.height = height
        self.text = text
        self.visible = visible
        self.error = error
    }
}

private enum ViewerFailure: LocalizedError {
    case entryPointUnavailable
    case noVisibleElement(String)

    var errorDescription: String? {
        switch self {
        case .entryPointUnavailable:
            "The bundled viewer did not install its rendering entry point."
        case .noVisibleElement(let selector):
            "The bundled viewer did not render a visible \(selector) element."
        }
    }
}
