import UIKit
import WebKit

/// A bare WKWebView pointed at the running Mac's mobile bridge.
///
/// The point of this app is what it does *not* do: it never resizes the web
/// view for the keyboard and never touches `additionalSafeAreaInsets`. WebKit
/// already subtracts the keyboard from `innerHeight`, so a native frame change
/// on `keyboardWillShow` would subtract it twice and open the gap this probe
/// exists to rule out. The page's own `useVisualViewportInsets` stays the one
/// authority on keyboard geometry.
final class ProbeViewController: UIViewController {
    private var web: WKWebView!
    private var sampler: Timer?
    private var lastSample = ""
    private var shortSamples = 0
    /// Tallest layout viewport seen. The stuck-viewport bug is precisely a
    /// layout viewport that never climbs back to it once the keyboard closes.
    private var tallestLayout = 0

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        web = WKWebView(frame: .zero, configuration: config)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // simctl --console hands us a pipe, and a pipe buffers a 1 Hz trickle
        // into silence.
        setvbuf(stdout, nil, _IOLBF, 0)
        guard let raw = ProcessInfo.processInfo.environment["PROBE_URL"],
              let url = URL(string: raw) else {
            fatalError("PROBE_URL not set")
        }
        web.load(URLRequest(url: url))
        // setInterval, not rAF: a backgrounded or occluded web view gets no
        // frame callbacks and the sampler would silently report nothing.
        sampler = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.sample()
        }
    }

    /// Prints the numbers that distinguish a healthy viewport from the
    /// standalone-PWA one: if `layout` ever drops below `screen` and stays
    /// there after the keyboard closes, the stuck-viewport bug followed us in.
    private func sample() {
        let js = """
        (() => {
          // env() only resolves against a real element, so read it off a
          // throwaway one rather than the root's own padding.
          const probeInset = (side) => {
            const el = document.createElement('div');
            el.style.cssText = `position:fixed;padding-${side}:env(safe-area-inset-${side})`;
            document.body.appendChild(el);
            const v = getComputedStyle(el)[`padding${side[0].toUpperCase()}${side.slice(1)}`];
            el.remove();
            return v;
          };
          const s = getComputedStyle(document.documentElement);
          const vv = window.visualViewport;
          return JSON.stringify({
            layout: window.innerHeight,
            visual: vv ? Math.round(vv.height) : null,
            offset: vv ? Math.round(vv.offsetTop) : null,
            keyboardInset: s.getPropertyValue('--mobile-keyboard-inset').trim(),
            viewportHeight: s.getPropertyValue('--mobile-viewport-height').trim(),
            safeTop: probeInset('top'),
            safeBottom: probeInset('bottom'),
            standalone: navigator.standalone === true,
            secureContext: window.isSecureContext,
            randomUUID: typeof crypto.randomUUID === 'function',
            clipboard: !!navigator.clipboard
          });
        })()
        """
        web.evaluateJavaScript(js) { value, error in
            if let error { print("PROBE error \(error.localizedDescription)"); return }
            guard let json = value as? String,
                  let data = json.data(using: .utf8),
                  let f = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }

            let screen = Int(self.view.bounds.height)
            let layout = f["layout"] as? Int ?? 0
            let inset = (f["keyboardInset"] as? String ?? "0px")
                .replacingOccurrences(of: "px", with: "")
            let keyboardUp = (Double(inset) ?? 0) > 1
            self.tallestLayout = max(self.tallestLayout, layout)

            // Only a *closed* keyboard on a short layout viewport is suspect;
            // while it is open every browser legitimately reports less. Load and
            // rotation also shrink it for a beat, so the bug is the state that
            // persists — three seconds of it, not one sample.
            let short = !keyboardUp && layout < self.tallestLayout
            self.shortSamples = short ? self.shortSamples + 1 : 0
            let verdict: String
            if self.shortSamples >= 3 {
                verdict = "STUCK — layout \(layout) has not returned to \(self.tallestLayout)"
            } else if short {
                verdict = "dipped"
            } else {
                verdict = keyboardUp ? "keyboard up" : "ok"
            }

            // A 1 Hz firehose buries the transition that matters, so speak only
            // when something actually moved.
            let line = "PROBE screen=\(screen) \(verdict) \(json)"
            guard line != self.lastSample else { return }
            self.lastSample = line
            print(line)
        }
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = ProbeViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
