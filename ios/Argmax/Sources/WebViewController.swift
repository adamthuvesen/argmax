import UIKit
import WebKit

/// The app is one web view pointed at the Mac.
///
/// What it deliberately does not do is resize for the keyboard or set
/// `additionalSafeAreaInsets`. WebKit already subtracts the keyboard from
/// `innerHeight`, so a native frame change on `keyboardWillShow` subtracts it
/// twice and opens a dead strip under the composer. The page's own
/// `useVisualViewportInsets` stays the single authority on keyboard geometry.
final class WebViewController: UIViewController, WKNavigationDelegate {
    private let url: URL
    private var web: WKWebView!
    private let onUnpair: () -> Void

    init(url: URL, onUnpair: @escaping () -> Void) {
        self.url = url
        self.onUnpair = onUnpair
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // The bridge holds the session; a fresh data store on every launch
        // would drop the page's own theme and draft state.
        config.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.allowsBackForwardNavigationGestures = false
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        web.load(URLRequest(url: url))
    }

    /// Backgrounding kills the socket, so a return to the foreground reconnects.
    /// The page does that itself on `visibilitychange`; this only rescues a web
    /// view whose content process was jettisoned while away, which leaves a
    /// blank view that nothing else recovers from.
    func reloadIfBlank() {
        if web.url == nil { web.load(URLRequest(url: url)) }
    }

    override var canBecomeFirstResponder: Bool { true }

    /// Shake to re-pair. A deliberately obscure gesture: it is the escape hatch
    /// for a moved host or a rotated token, not something to hit by accident.
    override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        guard motion == .motionShake else { return }
        let sheet = UIAlertController(
            title: "Pair with another Mac?",
            message: url.host.map { "Connected to \($0)." },
            preferredStyle: .alert
        )
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        sheet.addAction(UIAlertAction(title: "Re-pair", style: .destructive) { [weak self] _ in
            self?.onUnpair()
        })
        present(sheet, animated: true)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        let alert = UIAlertController(
            title: "Can't reach your Mac",
            message: "\(error.localizedDescription)\n\nIs Argmax running, and is this phone on the tailnet?",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
            guard let self else { return }
            self.web.load(URLRequest(url: self.url))
        })
        alert.addAction(UIAlertAction(title: "Re-pair", style: .destructive) { [weak self] _ in
            self?.onUnpair()
        })
        present(alert, animated: true)
    }
}
