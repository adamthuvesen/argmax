import SwiftUI

/// The paired app: the navigation stack, the data under it, and the one web
/// view the transcript screen adopts.
struct RootView: View {
    let paired: PairedHost
    /// The app delegate, which owns the device token and the tap. Passed
    /// down rather than read from the environment so the registration below
    /// can be built with it.
    @ObservedObject var push: PushDelegate
    let onUnpair: () -> Void

    @StateObject private var store: DashboardStore
    @StateObject private var rowActions: ChatRowActionCenter
    /// One per pairing, outliving every push and pop. Its web view is built
    /// on first need and its page is loaded once.
    @StateObject private var transcript: TranscriptHost
    /// Also one per pairing: a device token is registered with *this* Mac,
    /// and re-pairing has to take it off the old one.
    @StateObject private var registration: PushRegistration
    /// Read before Settings is opened rather than when it is. The Mac takes
    /// close to a second to ask five providers what is left, and that
    /// second lands on the card if nobody has asked ahead.
    @StateObject private var planLimits: PlanLimitsStore
    /// The Usage + Activity ledgers behind the Insights page. Owned here like
    /// plan limits so the numbers are warm before the page opens and survive
    /// every push and pop.
    @StateObject private var insights: InsightsStore
    @EnvironmentObject private var appearance: Appearance
    @State private var confirmingRepair = false
    @Environment(\.scenePhase) private var scenePhase

    init(paired: PairedHost, push: PushDelegate, onUnpair: @escaping () -> Void) {
        self.paired = paired
        self.push = push
        self.onUnpair = onUnpair
        let store = DashboardStore(client: paired.client)
        _store = StateObject(wrappedValue: store)
        // One owner for every row action's dialog and mutation, for the
        // screen's lifetime — see ChatRowActions.swift for why not per row.
        _rowActions = StateObject(wrappedValue: ChatRowActionCenter(store: store, client: paired.client))
        _transcript = StateObject(wrappedValue: TranscriptHost(pairingURL: paired.url))
        _registration = StateObject(
            wrappedValue: PushRegistration(client: paired.client, delegate: push)
        )
        _planLimits = StateObject(wrappedValue: PlanLimitsStore(client: paired.client))
        _insights = StateObject(wrappedValue: InsightsStore(client: paired.client))
    }

    var body: some View {
        // The stack lives in `ChatListView`: a row is a button rather than a
        // `NavigationLink`, so the screen that owns the rows owns the path.
        ChatListView(onPairAgain: repair)
            .environmentObject(store)
            .environmentObject(rowActions)
            .environmentObject(transcript)
            .environmentObject(registration)
            .environmentObject(planLimits)
            .environmentObject(insights)
            .environmentObject(push)
            .background(ShakeToRepair { confirmingRepair = true })
            .task {
                store.start()
                // First, before anything awaited below: the Insights ledgers
                // take seconds on the host, so their preload starts while the
                // socket is still connecting — the requests simply wait for
                // auth, then run. Fire-and-forget; nothing awaits them.
                insights.prefetch()
                // Warmed while the list is still fetching its first
                // snapshot, so the first push lands on a page that has
                // already authenticated rather than on a spinner.
                transcript.setAccent(appearance.tint.rawValue)
                transcript.setUserBubble(appearance.bubbleTint)
                transcript.loadIfNeeded()
                // Every launch, because Apple rotates device tokens and only
                // this phone learns the new one.
                await registration.refresh()
                // Last, and only after the list has what it needs: nothing on
                // screen is waiting for these numbers.
                await planLimits.refreshIfStale()
            }
            // The page inside the shell wears the shell's accent. Sent on
            // change rather than read by the page, because the phone's
            // appearance is the app's setting and not the Mac's.
            .onChange(of: appearance.tint) { transcript.setAccent(appearance.tint.rawValue) }
            .onChange(of: appearance.accentBubbles) { transcript.setUserBubble(appearance.bubbleTint) }
            .onChange(of: store.connection) { previous, current in
                // The bridge coming back is the moment the Mac may have
                // changed under the warm transcript page.
                if case .reconnecting = previous, case .live = current {
                    Task { await transcript.reloadIfHostChanged() }
                }
            }
            .onChange(of: scenePhase) {
                // Backgrounding kills the socket without closing it, so a
                // return to the foreground reconnects rather than waiting
                // out a backoff.
                if scenePhase == .active {
                    store.resume()
                    // Permission can be revoked in iOS Settings while the app
                    // is away, and the Mac's key can appear or go.
                    Task { await registration.refresh() }
                    // A phone that has been in a pocket for an hour is the
                    // case this exists for.
                    Task { await planLimits.refreshIfStale() }
                    insights.prefetch()
                }
            }
            .confirmationDialog(
                "Pair with another Mac?",
                isPresented: $confirmingRepair,
                titleVisibility: .visible
            ) {
                // The system dialog: the shake gesture can land on any
                // screen, and this is the one surface that draws over all of
                // them.
                Button("Re-pair", role: .destructive, action: repair)
                Button("Cancel", role: .cancel) {}
            } message: {
                if let host = paired.url.host() { Text("Connected to \(host).") }
            }
    }

    /// Back to the pairing screen: the shake gesture's escape hatch, and what
    /// a refused token leaves as the only move.
    private func repair() {
        // The Mac this phone is leaving must not keep pushing at it, and
        // only Apple's own 410 would ever clear that row. Sent before the
        // socket goes, but the screen does not wait for it: a Mac that has
        // stopped answering is the common reason to be here at all.
        Task {
            await registration.unregister()
            store.stop()
        }
        onUnpair()
    }
}

/// Shake to re-pair. A deliberately obscure gesture: it is the escape hatch
/// for a moved host or a rotated token, not something to hit by accident.
///
/// Motion events go to the first responder and up the chain from there, and
/// the SwiftUI lifecycle owns the window, so this parks an empty view
/// controller in the hierarchy and lets it hold first responder. A focused
/// text field takes the responder away while it is editing; the list's
/// search field is the only one on this screen.
private struct ShakeToRepair: UIViewControllerRepresentable {
    let onShake: () -> Void

    func makeUIViewController(context: Context) -> ShakeController {
        let controller = ShakeController()
        controller.onShake = onShake
        return controller
    }

    func updateUIViewController(_ controller: ShakeController, context: Context) {
        controller.onShake = onShake
    }

    final class ShakeController: UIViewController {
        var onShake: (() -> Void)?

        override var canBecomeFirstResponder: Bool { true }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            becomeFirstResponder()
        }

        override func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
            guard motion == .motionShake else { return }
            onShake?()
        }
    }
}
