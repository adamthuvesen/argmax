import SwiftUI
import WebKit

enum TranscriptRichKind: String { case mermaid, math }

struct TranscriptRichBlock: View {
    let kind: TranscriptRichKind
    let source: String
    let display: Bool
    @State private var height: CGFloat = 120
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 2) {
                Text(kind == .mermaid ? "Diagram" : "Equation")
                    .font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                Spacer()
                Button { UIPasteboard.general.string = source } label: {
                    Image(systemName: "doc.on.doc").frame(width: 32, height: 32)
                }
                .accessibilityLabel(kind == .mermaid ? "Copy diagram source" : "Copy equation source")
                Button { expanded = true } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32)
                }
                .accessibilityLabel(kind == .mermaid ? "View full diagram" : "View full equation")
            }
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 10)
            TranscriptRichWebView(kind: kind, source: source, display: display, expanded: false, contentHeight: $height)
                .frame(maxWidth: .infinity)
                .frame(height: min(max(height, display ? 54 : 30), display ? 360 : 40))
                .clipped()
        }
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .fullScreenCover(isPresented: $expanded) {
            NavigationStack {
                TranscriptRichWebView(kind: kind, source: source, display: true, expanded: true)
                    .background(Theme.ground)
                    .navigationTitle(kind == .mermaid ? "Diagram" : "Equation")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) { Button("Done") { expanded = false } }
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { UIPasteboard.general.string = source } label: {
                                Label("Copy source", systemImage: "doc.on.doc")
                            }
                        }
                    }
            }
        }
    }
}

struct TranscriptRichWebView: UIViewRepresentable {
    let kind: TranscriptRichKind
    let source: String
    let display: Bool
    let expanded: Bool
    @Binding private var contentHeight: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    init(
        kind: TranscriptRichKind,
        source: String,
        display: Bool = false,
        expanded: Bool,
        contentHeight: Binding<CGFloat> = .constant(30)
    ) {
        self.kind = kind
        self.source = source
        self.display = display
        self.expanded = expanded
        _contentHeight = contentHeight
    }

    func makeCoordinator() -> Coordinator { Coordinator(height: $contentHeight) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "argmaxRich")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = expanded
        view.scrollView.bounces = expanded
        view.accessibilityLabel = kind == .mermaid ? "Diagram" : "Equation"
        context.coordinator.webView = view
        load(view, coordinator: context.coordinator)
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        view.scrollView.isScrollEnabled = expanded
        let payload = Payload(
            kind: kind.rawValue,
            source: source,
            theme: colorScheme == .dark ? "dark" : "light",
            display: display,
            expanded: expanded
        )
        guard context.coordinator.payload != payload else { return }
        context.coordinator.payload = payload
        context.coordinator.render(payload)
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "argmaxRich")
        view.navigationDelegate = nil
    }

    private func load(_ view: WKWebView, coordinator: Coordinator) {
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "RichContent") else {
            coordinator.height.wrappedValue = 54
            return
        }
        coordinator.loaded = false
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    struct Payload: Encodable, Equatable {
        let kind: String
        let source: String
        let theme: String
        let display: Bool
        let expanded: Bool
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let height: Binding<CGFloat>
        weak var webView: WKWebView?
        var payload: Payload?
        var loaded = false

        init(height: Binding<CGFloat>) { self.height = height }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            if let payload { render(payload) }
        }

        func render(_ payload: Payload) {
            guard loaded, let webView,
                  let data = try? JSONEncoder().encode(payload),
                  let json = String(data: data, encoding: .utf8)
            else { return }
            webView.evaluateJavaScript("window.renderArgmaxRich(\(json))")
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "argmaxRich", let body = message.body as? [String: Any],
                  let measured = body["height"] as? Double else { return }
            DispatchQueue.main.async { self.height.wrappedValue = max(CGFloat(measured), 24) }
        }
    }
}
