import SwiftUI

/// A validated pairing link and the one socket it opens.
///
/// Built once per pairing rather than per view pass: the client owns the
/// reconnect backoff and the in-flight table, so a second one would race the
/// first for the host's sixteen request slots.
struct PairedHost: Identifiable {
    let url: URL
    let client: BridgeClient

    var id: URL { url }

    init?(_ url: URL) {
        guard let client = try? BridgeClient(pairingURL: url) else { return nil }
        self.url = url
        self.client = client
    }
}

@main
struct ArgmaxApp: App {
    /// A link in the keychain has been through `PairingLink.validate`, but
    /// re-validating costs nothing and an older build's entry may predate a
    /// rule.
    @State private var paired = ArgmaxApp.startsUnpaired
        ? nil
        : HostCredential.load()
            .flatMap { PairingLink.validate($0.absoluteString) }
            .flatMap(PairedHost.init)

    /// Theme and accent, read once at launch and handed down.
    @StateObject private var appearance = Appearance()

    /// The app delegate exists for push and nothing else: the device token
    /// and the notification tap are both delivered there, and SwiftUI has no
    /// seam of its own for either.
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var push

    /// `-argmax-unpaired` starts on the pairing screen without touching the
    /// keychain, so the first-run screen can be reviewed and screenshotted
    /// on a phone that is paired. Debug builds only: the real way back is
    /// the shake gesture, which clears the credential.
    static var startsUnpaired: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.arguments.contains("-argmax-unpaired")
        #else
        return false
        #endif
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let paired {
                    RootView(paired: paired, push: push, onUnpair: unpair).id(paired.id)
                } else {
                    PairingScreen { pair(with: $0) }
                }
            }
            .environmentObject(appearance)
            .appearance(appearance)
            .onOpenURL(perform: openPairingLink)
        }
    }

    /// `argmax://pair?url=<pairing link>` pairs without touching the phone.
    /// It is what a Mac uses to re-point an installed phone at a new origin —
    /// `devicectl device process launch --payload-url` — since the shake
    /// gesture and the clipboard both need a hand on the phone.
    private func openPairingLink(_ url: URL) {
        guard url.scheme == "argmax", url.host == "pair",
              let link = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                  .queryItems?.first(where: { $0.name == "url" })?.value,
              let validated = PairingLink.validate(link)
        else { return }
        HostCredential.save(validated)
        pair(with: validated)
    }

    private func pair(with url: URL) {
        paired = PairedHost(url)
    }

    private func unpair() {
        HostCredential.clear()
        paired = nil
    }
}
