import OSLog
import SwiftUI
import WebKit

/// The transcript's lifecycle, on one subsystem so the whole of it can be
/// watched from outside the app:
///
///     xcrun simctl spawn <udid> log stream \
///       --predicate 'subsystem == "com.argmax.remote"'
///
/// A blank transcript has four places it can stop — the request never
/// starts, the document never finishes, the page never says `ready`, or a
/// native call arrives before it does — and none of them is visible from a
/// screenshot. Every one of them writes a line here.
private let transcriptLog = Logger(subsystem: "com.argmax.remote", category: "transcript")

/// The one web view the app ever builds, and the page's half of the native
/// contract.
///
/// It outlives the navigation stack on purpose: `mobile.html?embed=1` loads
/// once, authenticates once, and then switches chats in place, so pushing a
/// transcript is a push onto a view that is already painted. Popping parks
/// the pane rather than tearing the page down. See
/// `docs/adr/0007-native-chrome-embedded-transcript.md`.
@MainActor
final class TranscriptHost: NSObject, ObservableObject {
    /// The page has mounted and authenticated: `window.argmaxNative` exists
    /// and commands run instead of queueing.
    @Published private(set) var ready = false
    /// The open chat as the page reports it, which is what the native header
    /// draws. Nil while the pane is parked.
    @Published private(set) var session: NativeSession?
    /// The composer's own state as the page reports it — what
    /// `TranscriptComposer` draws its card from. Nil until the first
    /// `composer` message, which follows `session` shortly after `ready`.
    @Published private(set) var composer: NativeComposerState?
    /// The page's review screen is up, so it is drawing its own bar and the
    /// native one has to get out of the way.
    @Published private(set) var reviewOpen = false
    /// The page's peek at delegated work is up. It rises from the bottom edge
    /// to cover the parent's composer, so the native card stands down for as
    /// long as it is there.
    @Published private(set) var agentsOpen = false
    /// The last thing that went wrong, cleared by the next load that works.
    @Published private(set) var failure: String?

    /// The page asked to leave the chat. The screen on top pops.
    var onBack: (() -> Void)?
    /// Send, approval, completion. Transient by nature, so a callback rather
    /// than published state — a haptic that replays on the next render is a
    /// bug you feel.
    var onHaptic: ((NativeHapticKind) -> Void)?

    private let embedURL: URL?
    /// The renderer bundle this page was loaded from, by the hashed name
    /// `mobile.html` points at. Recorded after each load, compared after each
    /// reconnect: the page lives for the app's life, and the one thing that
    /// makes it stale is the Mac shipping a new build.
    private var loadedBundle: String?
    /// Overridden by tests, which pin the queue without a page to run it in.
    private let evaluateOverride: ((String) -> Void)?

    /// What the page should be showing. Re-sent after every load, because a
    /// reload — ours, or `importChunk`'s when a chunk hash goes missing —
    /// brings back a page that knows none of it.
    private var wantedSession: String?
    private var wantedTheme: NativeTheme?
    /// The shell's accent, so the page inside it is never a different
    /// colour from the header above it. Set from the Appearance setting;
    /// the default matches `AccentTint.fallback`.
    private var wantedAccent = AccentTint.fallback.rawValue
    private var wantedUserBubble = "accent"

    private var pending: [NativeCommand] = []
    private var didStartLoading = false
    private var readyWatchdog: Task<Void, Never>?

    init(pairingURL: URL, evaluate: ((String) -> Void)? = nil) {
        embedURL = PairingLink.embeddedTranscriptURL(for: pairingURL)
        evaluateOverride = evaluate
        super.init()
    }

    /// Built on first need and kept for the app's life.
    lazy var webView: WKWebView = makeWebView()

    // MARK: - Loading

    /// Start the one load. Idempotent: the second caller gets the warm page.
    func loadIfNeeded() {
        guard !didStartLoading else { return }
        didStartLoading = true
        load()
    }

    /// Retry after a failure, and the Retry button's action.
    func reload() {
        didStartLoading = true
        load()
    }

    private func load() {
        guard let embedURL else {
            transcriptLog.error("load skipped: pairing link has no transcript URL")
            failure = "This pairing link has no transcript to open."
            return
        }
        failure = nil
        beginLoad()
        transcriptLog.notice("load start \(embedURL.path, privacy: .public)")
        // `reloadFromOrigin`, not `load`, once the page has been here
        // before: `mobile.html` is served by a service worker
        // stale-while-revalidate, so a plain load after the Mac has shipped
        // a new bundle hands back the cached document and the app retries
        // its way into the same failure. From origin, the conditional
        // requests go to the network.
        if webView.url == nil {
            webView.load(URLRequest(url: embedURL))
        } else {
            webView.reloadFromOrigin()
        }
    }

    /// A page that is on its way in knows nothing yet, so commands go back on
    /// the queue and `ready` waits for the new mount to say so.
    private func beginLoad() {
        ready = false
        session = nil
        composer = nil
        reviewOpen = false
        agentsOpen = false
        readyWatchdog?.cancel()
        readyWatchdog = nil
        // The native shell always draws its own composer once it has a page
        // to hide one on — there is no path back to the web composer here —
        // so this is unconditional, the same as `setAccent` above it.
        pending = [.setAccent(wantedAccent), .setUserBubble(wantedUserBubble), .setComposer(hidden: true)]
        if let wantedTheme { pending.append(.setTheme(wantedTheme)) }
        if let wantedSession { pending.append(.openSession(wantedSession)) }
    }

    /// How long a loaded page gets to authenticate and say `ready`.
    ///
    /// Generous — the bridge usually answers in under a second — because the
    /// alternative it replaces is a spinner that never ends. A page too old
    /// to know the contract, or one whose bridge never authenticates, is
    /// indistinguishable from a slow one until something says so.
    static let readyTimeout: Duration = .seconds(12)

    private func startReadyWatchdog() {
        readyWatchdog?.cancel()
        readyWatchdog = Task { [weak self] in
            try? await Task.sleep(for: Self.readyTimeout)
            guard !Task.isCancelled, let self, !self.ready, self.failure == nil else { return }
            transcriptLog.error("watchdog fired: no ready in \(Self.readyTimeout.components.seconds)s")
            self.failure = "This chat didn’t load."
        }
    }

    // MARK: - Native → web

    func openSession(_ sessionID: String) {
        wantedSession = sessionID
        // Whatever the page last reported was about the chat before this one.
        // Held on to, it is the previous chat's title and state drawn over the
        // one being opened — a header that names the wrong chat while the
        // transcript under it is still empty.
        forgetReportedSession()
        send(.openSession(sessionID))
    }

    func closeSession() {
        wantedSession = nil
        forgetReportedSession()
        // Parking the pane takes the peek with it, and the page does not
        // report a close it was not asked for.
        agentsOpen = false
        send(.closeSession)
    }

    /// Back to "the page has not said which chat this is", which is what the
    /// screen draws its row's own title and state from.
    private func forgetReportedSession() {
        session = nil
        composer = nil
    }

    /// One of the desktop's seven tints, by name.
    func setAccent(_ tint: String) {
        guard wantedAccent != tint else { return }
        wantedAccent = tint
        send(.setAccent(tint))
    }

    /// "accent" or "neutral", as the page's own stylesheet spells it.
    func setUserBubble(_ tint: String) {
        guard wantedUserBubble != tint else { return }
        wantedUserBubble = tint
        send(.setUserBubble(tint))
    }

    func setTheme(_ theme: NativeTheme) {
        guard wantedTheme != theme else { return }
        wantedTheme = theme
        send(.setTheme(theme))
    }

    /// The trailing menu's "Changes". The review screen is still the page's,
    /// so the native side asks for it rather than drawing one.
    func openReview() {
        send(.openReview)
    }

    /// Tells the page its own composer should get out of the way — the
    /// native card under the web view is drawing it instead. `TranscriptScreen`
    /// sends this once it appears; `beginLoad` re-seeds it on every reload,
    /// since a fresh mount (ours, or `importChunk`'s) knows nothing of the
    /// arrangement yet.
    func setComposerHidden(_ hidden: Bool) {
        send(.setComposer(hidden: hidden))
    }

    private func send(_ command: NativeCommand) {
        guard ready else {
            pending.append(command)
            return
        }
        run(command)
    }

    private func run(_ command: NativeCommand) {
        if let evaluateOverride {
            evaluateOverride(command.javaScript)
            return
        }
        webView.evaluateJavaScript(command.javaScript)
    }

    // MARK: - Web → native

    /// The one entry point for everything the page says, whether it came
    /// through the script-message handler or a test.
    func receive(_ message: NativeMessage) {
        transcriptLog.debug("web → native \(message.logName, privacy: .public)")
        switch message {
        case .ready:
            readyWatchdog?.cancel()
            readyWatchdog = nil
            failure = nil
            ready = true
            let flush = pending
            pending = []
            transcriptLog.notice("ready, flushing \(flush.count) queued call(s)")
            for command in flush { run(command) }
        // A report about a chat other than the one native asked for is the
        // page catching up on the switch, and drawing it would put the chat
        // just left back in the header.
        case .session(let open):
            guard open.sessionId == wantedSession else { return }
            session = open
        case .composer(let state):
            guard state.sessionId == wantedSession else { return }
            composer = state
        case .review(let open):
            reviewOpen = open
        case .agents(let open):
            agentsOpen = open
        case .back:
            onBack?()
        case .haptic(let kind):
            onHaptic?(kind)
        case .error(let message):
            transcriptLog.error("page reported: \(message, privacy: .public)")
            failure = message
        }
    }

    // MARK: - Web view

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // The page is a secure context with a service worker, a token in
        // session storage and a theme in local storage, so it needs the
        // persistent store rather than an ephemeral one.
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        let controller = WKUserContentController()
        // A weak hop, because `WKUserContentController` retains its handlers
        // and the host owns the configuration that owns the controller.
        controller.add(ScriptMessageRelay(host: self), name: "argmax")
        configuration.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        // Transparent all the way down, so the native container's colour is
        // what shows during the load instead of WebKit's white.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // Native owns the stack now; an edge swipe here would walk the page's
        // own history under a native screen that did not move.
        webView.allowsBackForwardNavigationGestures = false
        // The page reads the insets itself through `env(safe-area-inset-*)`.
        // Letting the scroll view add its own on top is how the composer ends
        // up floating above the home indicator.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        return webView
    }
}

extension TranscriptHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // Not always our load: `importChunk` reloads the page when a chunk
        // hash it holds has gone missing, and that page comes back knowing
        // neither the theme nor the open chat.
        beginLoad()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        transcriptLog.error("didFailProvisionalNavigation: \(error.localizedDescription, privacy: .public)")
        failure = error.localizedDescription
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        transcriptLog.error("didFail: \(error.localizedDescription, privacy: .public)")
        failure = error.localizedDescription
    }

    /// The document is up; everything from here is the page's own doing, so
    /// this is where the clock on `ready` starts.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        transcriptLog.notice("didFinish, waiting for ready")
        startReadyWatchdog()
        Task { loadedBundle = await servedBundle() }
    }

    // MARK: - A host that changed under a warm page

    private func servedBundle() async -> String? {
        guard let embedURL, var components = URLComponents(url: embedURL, resolvingAgainstBaseURL: false) else { return nil }
        components.fragment = nil
        components.query = nil
        guard let documentURL = components.url else { return nil }
        var request = URLRequest(url: documentURL)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let html = String(data: data, encoding: .utf8),
              let range = html.range(of: #"assets/mobile-[A-Za-z0-9_-]+\.js"#, options: .regularExpression)
        else { return nil }
        return String(html[range])
    }

    /// Called when the bridge comes back: a phone that merely went to the
    /// background keeps its page, a Mac that restarted with a new bundle does
    /// not get to keep serving the old one.
    func reloadIfHostChanged() async {
        guard let loaded = loadedBundle, let serving = await servedBundle(), serving != loaded else { return }
        transcriptLog.notice("host now serves \(serving, privacy: .public), page has \(loaded, privacy: .public); reloading")
        reload()
    }

    /// A jetsammed content process leaves a blank view that never recovers on
    /// its own, and this one is meant to live for the app's life.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        transcriptLog.error("content process terminated, reloading")
        reload()
    }
}

/// Breaks the retain cycle `WKUserContentController` would otherwise close
/// around the host that owns it.
@MainActor
private final class ScriptMessageRelay: NSObject, WKScriptMessageHandler {
    private weak var host: TranscriptHost?

    init(host: TranscriptHost) {
        self.host = host
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // Anything this build does not understand is dropped: the page ships
        // separately from the app and grows message types first.
        guard let decoded = NativeMessage(body: message.body) else { return }
        host?.receive(decoded)
    }
}

/// Adopts the shared web view into whatever screen is on top.
///
/// The view is re-parented rather than rebuilt, so a pop and a push cost a
/// `addSubview` and nothing else.
struct TranscriptWebView: UIViewRepresentable {
    let host: TranscriptHost

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .clear
        adopt(into: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        adopt(into: container)
    }

    /// Idempotent: a re-render must not stack a second copy of the same view
    /// or reset the constraints holding the first.
    private func adopt(into container: UIView) {
        let webView = host.webView
        guard webView.superview !== container else { return }
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
    }
}
