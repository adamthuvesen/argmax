import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var web: WebViewController?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        self.window = window
        window.makeKeyAndVisible()
        show(HostCredential.load())
        return true
    }

    /// A paired host goes straight to the transcript; an unpaired one asks.
    private func show(_ url: URL?) {
        guard let url else {
            web = nil
            window?.rootViewController = PairingViewController { [weak self] paired in
                self?.show(paired)
            }
            return
        }
        let controller = WebViewController(url: url) { [weak self] in
            HostCredential.clear()
            self?.show(nil)
        }
        web = controller
        window?.rootViewController = controller
        // So the shake-to-re-pair gesture reaches it.
        controller.becomeFirstResponder()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        web?.reloadIfBlank()
    }
}
