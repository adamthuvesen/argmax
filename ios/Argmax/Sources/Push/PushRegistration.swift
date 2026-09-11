import Combine
import SwiftUI
import UIKit
import UserNotifications

/// Whether a push can reach this phone, and the one action that makes it so.
///
/// Three parties have to agree before a notification arrives: the Mac holds
/// an APNs auth key, iOS has granted permission, and the Mac's `remote.json`
/// lists this device's token. `status` is that agreement read as one value,
/// and Settings → Notifications is a reading of it.
///
/// Registration is not a one-off. Apple may rotate a device token and only
/// the device learns the new one, so every authorized launch asks for the
/// current token and sends it again — the host treats a token it already
/// holds as a rename, never a second row. See "Push notifications (APNs)" in
/// `docs/remote.md`.
@MainActor
final class PushRegistration: ObservableObject {
    /// Where this phone stands, in the order the gaps have to be closed:
    /// the Mac first, then iOS, then the Mac again.
    enum Status: Equatable {
        /// Before the Mac has answered `remote:push-capability`. Not the
        /// same as "no", which is why it is not spelled as one.
        case checking
        /// iOS has not been asked yet, or the Mac does not list this phone.
        /// Either way nothing arrives and the fix is the same button.
        case notDetermined
        /// iOS refused, and only the system settings can change that.
        case denied
        /// Reachable, under the name the Mac lists it by.
        case enabled(deviceName: String)
    }

    /// One line under the row: what the test push answered, or why telling
    /// the Mac about this phone failed.
    struct Note: Equatable {
        var text: String
        /// A problem takes the attention red; a success stays quiet.
        var failed: Bool
    }

    @Published private(set) var status: Status = .checking
    @Published private(set) var note: Note?
    /// What the Mac last said about its APNs key, once it has said
    /// anything. Read beside `status` rather than folded into it: a missing
    /// key is a gap on the Mac, and it does not stop anything here.
    /// Registering works without one — the token lands in `remote.json` and
    /// notifications start the day the key does — so the section leads with
    /// the gap and still offers Enable.
    @Published private(set) var hostConfigured: Bool?
    /// A test push in flight, so the button cannot fire twice.
    @Published private(set) var testing = false

    /// The Mac is where this is fixed, so the line says where on the Mac.
    nonisolated static let noKeyOnMac =
        "Not set up on your Mac — add an APNs key in Argmax → Settings → Remote access."

    private let client: BridgeClient
    private let delegate: PushDelegate
    private let center: UNUserNotificationCenter?
    private let defaults: UserDefaults
    private let deviceName: String
    private var sinks: Set<AnyCancellable> = []

    /// This phone's token, hex as the host stores it, and the name the Mac
    /// lists it under. Both are remembered across launches so a relaunch
    /// draws the settled state rather than flickering through "Off" while
    /// Apple hands the token over again.
    ///
    /// `UserDefaults`, not the keychain: a device token is not a credential
    /// on its own — it names this install to Apple, and the Mac keeps it in
    /// plain `remote.json` anyway. The pairing token, which is one, stays in
    /// `HostCredential`.
    private var token: String? {
        didSet { defaults.set(token, forKey: Self.tokenKey) }
    }

    private var registeredName: String? {
        didSet { defaults.set(registeredName, forKey: Self.nameKey) }
    }

    private static let tokenKey = "argmax.push.deviceToken"
    private static let nameKey = "argmax.push.deviceName"

    init(
        client: BridgeClient,
        delegate: PushDelegate,
        center: UNUserNotificationCenter? = .current(),
        defaults: UserDefaults = .standard,
        deviceName: String? = nil
    ) {
        self.client = client
        self.delegate = delegate
        self.center = center
        self.defaults = defaults
        // Resolved here rather than as a default argument: a default
        // expression is evaluated outside this class's isolation, and
        // `UIDevice.current` belongs to the main actor.
        self.deviceName = deviceName ?? UIDevice.current.name
        token = defaults.string(forKey: Self.tokenKey)
        registeredName = defaults.string(forKey: Self.nameKey)

        // Apple answers `registerForRemoteNotifications` on the app
        // delegate, which SwiftUI owns and this cannot be. The delegate
        // publishes what it is handed; this decides what to do with it.
        delegate.$deviceToken
            .compactMap { $0 }
            .removeDuplicates()
            .sink { [weak self] data in
                Task { @MainActor in await self?.adopt(deviceToken: data) }
            }
            .store(in: &sinks)

        delegate.$registrationFailure
            .compactMap { $0 }
            .sink { [weak self] reason in
                Task { @MainActor in self?.note = Note(text: reason, failed: true) }
            }
            .store(in: &sinks)
    }

    // MARK: - The status

    /// Read both gates and re-register when they are open.
    ///
    /// Called at launch and on every return to the foreground: permission
    /// can be revoked in iOS Settings while the app is away, and the Mac's
    /// key can appear or disappear without this phone hearing about it.
    func refresh() async {
        if let capability = try? await client.pushCapability() {
            hostConfigured = capability.configured
        }
        let authorization = await authorizationStatus()
        status = Self.resolve(
            configured: hostConfigured,
            authorization: authorization,
            registeredName: registeredName
        )
        // Not gated on the key: the Mac stores the token either way, and a
        // phone that waited for the key would still be unregistered on the
        // day it arrived.
        guard authorization.grantsNotifications else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// The Enable button. iOS asks once per install, so a refusal here is
    /// final until the person changes it in the system settings.
    ///
    /// The status does not flip on the grant. An authorized phone the Mac
    /// has never heard of still receives nothing, so it waits for the Mac to
    /// confirm the token.
    func requestAndRegister() async {
        note = nil
        guard let center else { return }
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else {
            status = .denied
            return
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Tell the Mac to forget this phone, on the way to pairing with another
    /// one. Without it the old Mac keeps pushing at a phone that has moved,
    /// and only Apple's own 410 would ever clear the row.
    ///
    /// Best effort by design: the caller does not wait for it, and iOS keeps
    /// its permission so the next pairing registers without asking again.
    func unregister() async {
        guard let token else { return }
        self.token = nil
        registeredName = nil
        status = .notDetermined
        _ = try? await client.unregisterPushDevice(token: token)
    }

    /// "Send test": the Mac pushes to every phone it lists and answers row
    /// by row. This one reads its own row.
    func sendTest() async {
        guard !testing else { return }
        testing = true
        defer { testing = false }
        do {
            let results = try await client.sendTestPush()
            guard let mine = results.first(where: { $0.token == token }) ?? results.first else {
                note = Note(text: "Your Mac has no phone to push to.", failed: true)
                return
            }
            note = mine.ok
                ? Note(text: "Sent. It should arrive in a moment.", failed: false)
                : Note(text: mine.error ?? "Apple refused it.", failed: true)
        } catch {
            note = Note(text: Self.failureMessage(error), failed: true)
        }
    }

    /// One line for a push call that failed.
    ///
    /// The host's own words, with one substitution: `APNS_NOT_CONFIGURED`
    /// comes back as "set the APNs key path, key id, and team id" — true,
    /// and not something anyone can do on the phone reading it. This says
    /// where the fix is, in the same sentence the status line uses.
    nonisolated static func failureMessage(_ error: Error) -> String {
        if case .host(_, "APNS_NOT_CONFIGURED", _)? = error as? BridgeError { return noKeyOnMac }
        return hostFailureMessage(error)
    }

    // MARK: - Registering

    /// Apple handed over a token. Hex-encode it and tell the Mac.
    private func adopt(deviceToken data: Data) async {
        let hex = Self.hex(data)
        token = hex
        do {
            let devices = try await client.registerPushDevice(token: hex, name: deviceName)
            registeredName = devices.first { $0.token == hex }?.name ?? deviceName
            note = nil
        } catch {
            registeredName = nil
            note = Note(text: Self.failureMessage(error), failed: true)
        }
        status = Self.resolve(
            configured: hostConfigured,
            authorization: await authorizationStatus(),
            registeredName: registeredName
        )
    }

    private func authorizationStatus() async -> UNAuthorizationStatus {
        guard let center else { return .notDetermined }
        return await center.notificationSettings().authorizationStatus
    }

    /// The whole state machine, as a function of the three answers.
    ///
    /// Authorized but unlisted is `notDetermined` rather than `enabled`,
    /// because the reader's question is "will a notification reach this
    /// phone", and there it will not — and the button that fixes it is the
    /// same one.
    ///
    /// A Mac with no key does not appear here at all. It used to outrank
    /// everything iOS said, which left the one screen that can close the
    /// iOS half of the gap with nothing to tap; `hostConfigured` carries
    /// that line instead, above this one.
    nonisolated static func resolve(
        configured: Bool?,
        authorization: UNAuthorizationStatus,
        registeredName: String?
    ) -> Status {
        guard configured != nil else { return .checking }
        switch authorization {
        case .denied:
            return .denied
        case .authorized, .provisional, .ephemeral:
            guard let registeredName else { return .notDetermined }
            return .enabled(deviceName: registeredName)
        default:
            return .notDetermined
        }
    }

    /// Apple hands the token over as bytes; `remote.json` stores the
    /// lowercase hex the APNs URL is built from
    /// (`normalize_device_token` in `src-tauri/src/ipc/remote.rs`).
    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }
}

private extension UNAuthorizationStatus {
    /// Provisional and ephemeral both deliver; only the placement differs.
    var grantsNotifications: Bool {
        self == .authorized || self == .provisional || self == .ephemeral
    }
}

// MARK: - The app delegate

/// The two things SwiftUI has no seam for: Apple handing over a device
/// token, and a notification being tapped.
///
/// Deliberately dumb. It publishes what iOS reports and decides exactly one
/// thing — whether a notification for the chat already on screen should
/// interrupt it. `PushRegistration` and `ChatListView` do the rest.
///
/// `@MainActor` on the class, not on the properties: UIKit bridges these
/// `async` delegate methods back to their Objective-C completion handlers,
/// and it runs UIKit work — a state-restoration snapshot — in that
/// completion. A method isolated to nothing resumes on the cooperative pool,
/// so the completion fires off the main thread and UIKit's main-thread
/// assertion aborts the app: a tapped notification would open Argmax and
/// drop the person straight back to the home screen. Isolating the class
/// makes the thunk hop to the main actor before it answers.
@MainActor
final class PushDelegate: NSObject, ObservableObject {
    /// Apple's device token for this install, as raw bytes.
    @Published private(set) var deviceToken: Data?
    /// Why Apple refused to issue one — usually a build without the
    /// `aps-environment` entitlement, or a simulator with no Apple ID.
    @Published private(set) var registrationFailure: String?
    /// The chat a tapped notification names, waiting for the list to open
    /// it. Whoever routes it clears it.
    ///
    /// It survives a cold launch: the tap is delivered before any screen
    /// exists, so the value sits here until `ChatListView` reads it.
    @Published var tappedSessionID: String?
    /// The chat on screen right now. A banner for it would announce what the
    /// reader is already looking at.
    var openSessionID: String?
}

extension PushDelegate: UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Before the first screen: a tap on the lock screen launches the app
        // and delivers the response immediately, and an unset delegate loses
        // it.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        registrationFailure = nil
        self.deviceToken = deviceToken
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        registrationFailure = error.localizedDescription
    }
}

extension PushDelegate: UNUserNotificationCenterDelegate {
    /// A tap. The payload names the chat, and the list opens it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let sessionID = PushPayload.sessionID(response.notification.request.content.userInfo)
        else { return }
        tappedSessionID = sessionID
    }

    /// Foreground arrival. The Mac pushes whether or not the phone is in
    /// hand — the point is that you are away from the Mac — so a banner is
    /// right unless it is about the chat on screen.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        let sessionID = PushPayload.sessionID(notification.request.content.userInfo)
        guard sessionID == nil || sessionID != openSessionID else { return [] }
        return [.banner, .sound, .list]
    }
}

/// What a push carries.
///
/// `src-tauri/src/remote/apns.rs` writes
/// `{"aps":{"alert":{…},"sound":"default","thread-id":<session>,
/// "interruption-level":…},"sessionId":<session>}`. `thread-id` stacks a
/// chat's notifications on the lock screen and `sessionId` is the one this
/// app reads. The test push belongs to no chat and carries neither, so
/// tapping it opens the app and nothing more.
enum PushPayload {
    static func sessionID(_ userInfo: [AnyHashable: Any]) -> String? {
        guard let sessionID = userInfo["sessionId"] as? String, !sessionID.isEmpty else { return nil }
        return sessionID
    }
}

#if DEBUG
extension PushRegistration {
    /// A registration pinned to one state, so every row of the Notifications
    /// section is reachable in a `#Preview` without a Mac. Never connects:
    /// the client points at a host that is not there and nothing calls
    /// `refresh()`.
    static func preview(
        _ status: Status,
        note: Note? = nil,
        hostConfigured: Bool? = true
    ) -> PushRegistration {
        let registration = PushRegistration(
            client: previewClient(),
            delegate: PushDelegate(),
            center: nil,
            defaults: UserDefaults(suiteName: "argmax.preview.push") ?? .standard,
            deviceName: "Adam’s iPhone"
        )
        registration.status = status
        registration.note = note
        registration.hostConfigured = hostConfigured
        return registration
    }
}
#endif
