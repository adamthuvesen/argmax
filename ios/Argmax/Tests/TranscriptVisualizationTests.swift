import SwiftUI
import WebKit
import XCTest
@testable import Argmax

final class TranscriptVisualizationTests: XCTestCase {
    func testStandaloneMarkersBecomeCardsButCodeRemainsLiteral() {
        let marker = "\u{E200}visualize\u{E202}{\"path\":\"/tmp/chart.html\",\"mode\":\"wide\",\"title\":\"Trends\"}\u{E201}"
        let document = TranscriptMarkdownDocument(markdown: "Before\n\n\(marker)\n\nAfter")
        XCTAssertEqual(document.blocks.count, 3)
        guard case .visualization(.ready(let reference)) = document.blocks[1] else { return XCTFail("missing visualization") }
        XCTAssertEqual(reference.path, "/tmp/chart.html")
        XCTAssertEqual(reference.title, "Trends")
        let code = TranscriptMarkdownDocument(markdown: "```text\n\(marker)\n```")
        guard case .code(_, let source) = code.blocks.first else { return XCTFail("code lost") }
        XCTAssertTrue(source.contains(marker))
        let indented = TranscriptMarkdownDocument(markdown: "    " + marker)
        guard case .code(_, let literal) = indented.blocks.first else { return XCTFail("indented code became card") }
        XCTAssertTrue(literal.contains(marker))
        XCTAssertFalse(MobileTranscriptRow.isProgressNarration(marker))
        let inline = TranscriptMarkdownDocument(markdown: "Example: `\(marker)`")
        guard case .paragraph = inline.blocks.first else { return XCTFail("inline marker became card") }
    }

    func testLegacyReferenceCarriesActualSourceEventIdentity() {
        let reference = TranscriptVisualizationLegacyReference(path: "/tmp/chart.html", mode: "wide", title: "Trends")
        let identified = TranscriptMarkdown.identifiedReference(reference, sourceEventID: "persisted-event-1")
        XCTAssertEqual(identified.sourceEventID, "persisted-event-1")
        XCTAssertNil(TranscriptMarkdown.identifiedReference(reference, sourceEventID: nil).sourceEventID)
        let event = TranscriptEvent(id: "persisted-event-1", sessionId: "session", type: "message.completed",
                                    message: "Answer", payload: .object([:]), createdAt: "2026-10-07T10:00:00Z")
        guard case .assistant(let message) = TranscriptProjection.project(events: [event]).first else { return XCTFail("answer missing") }
        XCTAssertEqual(message.sourceEventID, event.id)
        XCTAssertNotEqual(message.id, event.id, "Display grouping identity is separate from persisted identity")
    }

    func testPendingAndInvalidReferencesStayExplicit() {
        guard case .pending = TranscriptVisualizationMarker(line: "\u{E200}visualize\u{E202}{\"path\":") else { return XCTFail("missing pending state") }
        for json in ["{\"path\":\"relative.html\"}", "{\"path\":\"/tmp/a.js\"}", "{\"path\":\"/tmp/a.html\",\"unknown\":true}", "{\"path\":\"/tmp/a.html\",\"mode\":\"fullscreen\"}"] {
            guard case .invalid = TranscriptVisualizationMarker(line: "\u{E200}visualize\u{E202}\(json)\u{E201}") else { return XCTFail("accepted invalid reference \(json)") }
        }
    }

    func testPublishedRowsKeepOwningSessionAndStopThinkingCue() {
        let event = TranscriptEvent(id: "published", sessionId: "child", type: "visualization.published", message: "Chart", payload: .object([
            "artifactId": .string("6c2cfe3e-f786-4d70-b659-c98800f4eab3"), "title": .string("Chart"), "summary": .string("Trend"), "format": .string("html")
        ]), createdAt: "2026-10-07T10:00:00Z")
        let items = TranscriptProjection.project(events: [event])
        guard case .visualization(let card) = items.first else { return XCTFail("published row lost") }
        XCTAssertEqual(card.sessionID, "child")
        XCTAssertEqual(card.artifactID, "6c2cfe3e-f786-4d70-b659-c98800f4eab3")
        XCTAssertEqual(card.summary, "Trend")
        XCTAssertNil(TranscriptThinking.liveThoughtID(in: items, sessionIsWorking: true))
    }

    func testCanonicalMeaningWinsOverRawPayloadAndInvalidRowsStayHidden() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "timelineSemanticFixtures", withExtension: "json"))
        let fixtures = try JSONDecoder().decode([TranscriptEvent].self, from: Data(contentsOf: url))
        var event = try XCTUnwrap(fixtures.first)
        event.semantic?.event = .visualization(.init(kind: "visualization", artifactId: "6c2cfe3e-f786-4d70-b659-c98800f4eab3",
                                                    title: "Canonical", format: "html", summary: "Canonical summary"))
        event.payload = .object(["artifactId": .string("wrong"), "title": .string("wrong")])
        let items = TranscriptProjection.project(events: [event])
        guard case .visualization(let card) = items.first else { return XCTFail("canonical meaning ignored") }
        XCTAssertEqual(card.title, "Canonical")
        event.semantic?.event = .unknown
        event.type = "visualization.published"
        XCTAssertTrue(TranscriptProjection.project(events: [event]).isEmpty)
    }

    func testMessageBridgeRejectsOtherInstancesSubframesAndOversizedBodies() {
        let message: [String: Any] = ["type": "argmax:visualization-state", "instanceId": "artifact", "state": ["modelContent": [:], "privateContent": [:]]]
        XCTAssertNotNil(TranscriptVisualizationMessage.validated(message, instanceID: "artifact", mainFrame: true))
        XCTAssertNil(TranscriptVisualizationMessage.validated(message, instanceID: "other", mainFrame: true))
        XCTAssertNil(TranscriptVisualizationMessage.validated(message, instanceID: "artifact", mainFrame: false))
        XCTAssertNil(TranscriptVisualizationMessage.validated(["type": "argmax:visualization-follow-up", "instanceId": "artifact", "prompt": String(repeating: "x", count: 200_000)], instanceID: "artifact", mainFrame: true))
    }

    func testControlSchemaMatchesSharedRuntimeCapacity() {
        let controls: [[String: Any]] = (0..<12).map { ["id": "control-\($0)", "kind": "toggle", "label": "Control", "value": true] }
        let groups: [[String: Any]] = (0..<32).map { ["id": "group-\($0)", "label": "Group", "controls": controls] }
        XCTAssertEqual(TranscriptVisualizationControls.decodeGroups(groups)?.flatMap(\.controls).count, 384)
        XCTAssertNil(TranscriptVisualizationControls.decodeGroups(groups + [["id": "extra", "label": "Group", "controls": controls]]))
        XCTAssertNil(TranscriptVisualizationControls.decodeGroups([["id": "group", "label": "Group", "controls": controls + [["id": "extra", "kind": "toggle", "label": "Control", "value": true]]]]))
    }

    @MainActor
    func testMountedCardsHaveABoundedWebViewBudget() {
        let viewers = TranscriptVisualizationViewers()
        let ids = (0..<5).map { _ in UUID() }
        for id in ids { viewers.activate(id) }
        XCTAssertEqual(viewers.active, Array(ids.prefix(3)))
        viewers.activate(ids[4], replacing: true)
        XCTAssertEqual(viewers.active.count, 3)
        XCTAssertFalse(viewers.active.contains(ids[0]))
        XCTAssertTrue(viewers.active.contains(ids[4]))
        let priorLease = viewers.leases[ids[4]]
        viewers.release(ids[4])
        XCTAssertEqual(viewers.active.count, 2)
        viewers.activate(ids[4])
        XCTAssertNotEqual(viewers.leases[ids[4]], priorLease)
    }

    @MainActor
    func testIsolatedWebViewRendersAndRoutesHeightWithoutBrowserCookies() async throws {
        let heightReceived = expectation(description: "height bridge")
        let controlsReceived = expectation(description: "native Tweak controls")
        var groups: [TranscriptVisualizationControls] = []
        let client = try BridgeClient(pairingURL: XCTUnwrap(URL(string: "https://mac.example/mobile.html#token=visualization-test")), monitorNetwork: false)
        let artifact = TranscriptVisualizationArtifact(id: "fixture", sessionId: "session", title: "Fixture", summary: "", format: "html", runtimeVersion: 1, externalDependencies: [])
        let runtimeURL = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "visualization-runtime", withExtension: "json"))
        let runtime = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: runtimeURL)) as? [String: Any])
        let script = try XCTUnwrap(runtime["script"] as? String)
        let css = try XCTUnwrap(runtime["css"] as? String)
        let csp = try XCTUnwrap(runtime["csp"] as? String)
        let source = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="\(csp)"><style>\(css)</style>
        <script>window.__argmaxVisualizationConfig={instanceId:'fixture',appearance:{dark:false,variables:{}},state:{modelContent:{filter:7},privateContent:{selection:'private'}},capabilities:{controls:true}};</script>
        <script>\(script)</script></head><body><section id="chart" aria-label="Trend controls"><h2>Native visualization</h2>
        <svg viewBox="0 0 360 140" role="img" aria-label="Three rising bars">
        <rect x="30" y="85" width="70" height="45" fill="var(--viz-series-1)"/>
        <rect x="145" y="50" width="70" height="80" fill="var(--viz-series-2)"/>
        <rect x="260" y="15" width="70" height="115" fill="var(--viz-series-3)"/></svg></section><script>
        window.fixtureSettings={gap:14};
        const tweak=new Tweak({container:document.getElementById('chart'),onChange:()=>{document.getElementById('chart').dataset.gap=window.fixtureSettings.gap;}});
        tweak.addSlider(window.fixtureSettings,'gap',{label:'Bar spacing',min:4,max:40,step:1});
        window.webkit.messageHandlers.argmaxVisualization.postMessage({type:'argmax:visualization-height',instanceId:'fixture',height:333});
        </script></body></html>
        """
        let document = TranscriptVisualizationDocument(artifact: artifact, source: source, document: source,
                                                       state: .init(modelContent: .null, privateContent: .null))
        var coordinator: TranscriptVisualizationWeb.Coordinator?
        let view = TranscriptVisualizationWeb(document: document, client: client, sessionID: "session", appearance: ["dark": false, "variables": [:]],
            height: Binding(get: { 240 }, set: { if $0 == 333 { heightReceived.fulfill() } }),
            host: Binding(get: { coordinator }, set: { coordinator = $0 }),
            onFollowUp: { _ in XCTFail("unexpected follow-up") }, onLink: { _ in XCTFail("unexpected link") },
            onControls: { received in
                if groups.isEmpty { groups = received; controlsReceived.fulfill() }
            }, onFailure: { XCTFail($0) })
        let controller = UIHostingController(rootView: view.frame(width: 390, height: 400))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }, "A foreground scene is required to prove WebKit paint")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 400)
        window.rootViewController = controller
        controller.view.frame = window.bounds
        window.makeKeyAndVisible()
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        await fulfillment(of: [heightReceived, controlsReceived], timeout: 5)
        let webView = try XCTUnwrap(coordinator?.webView)
        XCTAssertFalse(webView.configuration.websiteDataStore.isPersistent)
        XCTAssertFalse(webView.configuration.preferences.javaScriptCanOpenWindowsAutomatically)
        XCTAssertEqual(webView.url?.absoluteString, "about:blank")
        while webView.isLoading { try await Task.sleep(for: .milliseconds(20)) }
        let controlID = try XCTUnwrap(groups.first?.controls.first?.id)
        coordinator?.send(["type": "argmax:visualization-control", "id": controlID, "value": 22])
        let spacing = try await webView.evaluateJavaScript("window.fixtureSettings.gap") as? Int
        XCTAssertEqual(spacing, 22)
        webView.layoutIfNeeded()
        XCTAssertTrue(webView.window === window)
        XCTAssertTrue(window.windowScene === scene)
        XCTAssertEqual(scene.activationState, .foregroundActive)
        XCTAssertFalse(window.isHidden)
        XCTAssertGreaterThan(window.alpha, 0)
        XCTAssertGreaterThan(webView.bounds.width, 300)
        _ = try await webView.callAsyncJavaScript("""
            await Promise.race([
              (async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})(),
              new Promise((_,reject)=>setTimeout(()=>reject(new Error('WebKit did not reach a visible frame')),2000))
            ]);
            return document.visibilityState;
            """, arguments: [:], in: nil, in: .page)
        let snapshotConfiguration = WKSnapshotConfiguration()
        snapshotConfiguration.rect = webView.bounds
        snapshotConfiguration.afterScreenUpdates = true
        let snapshot = try await webView.takeSnapshot(configuration: snapshotConfiguration)
        XCTAssertGreaterThan(snapshot.size.width, 300)
        XCTAssertGreaterThan(snapshot.size.height, 200)
        let cgImage = try XCTUnwrap(snapshot.cgImage)
        var pixels = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: cgImage.width, height: cgImage.height, bitsPerComponent: 8,
                                              bytesPerRow: cgImage.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
        for color: [UInt8] in [[54, 109, 173], [174, 100, 30], [37, 133, 85]] {
            let matchingPixels = stride(from: 0, to: pixels.count, by: 4).filter {
                pixels[$0] == color[0] && pixels[$0 + 1] == color[1] && pixels[$0 + 2] == color[2] && pixels[$0 + 3] > 0
            }.count
            XCTAssertGreaterThan(matchingPixels, 100, "Each SVG bar must paint its theme color")
        }
        let attachment = XCTAttachment(image: snapshot)
        attachment.name = "native-visualization-chart"
        attachment.lifetime = .keepAlways
        add(attachment)
        let restored = try await webView.evaluateJavaScript("JSON.stringify(window.openai.widgetState)") as? String
        XCTAssertTrue(restored?.contains("filter") == true)
        XCTAssertTrue(restored?.contains("private") == true)
        let capabilities = try await webView.evaluateJavaScript("JSON.stringify(window.openai.capabilities)") as? String
        XCTAssertTrue(capabilities?.contains("\"controls\":true") == true)
        let tweak = try await webView.evaluateJavaScript("typeof window.Tweak") as? String
        XCTAssertEqual(tweak, "function")
        window.isHidden = true
        window.rootViewController = nil
    }
}
