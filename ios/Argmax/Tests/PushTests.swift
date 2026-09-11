import UserNotifications
import XCTest
@testable import Argmax

/// The three pieces of push that are decisions rather than plumbing: what a
/// tap deep-links into, what the Notifications row says, and the one format
/// the Mac will accept a device token in.
///
/// Everything else here needs Apple: a real token is minted by APNs for a
/// physical device, and a delivered notification needs a `.p8` on the Mac.
final class PushTests: XCTestCase {
    // MARK: - The tap

    /// The payload as `src-tauri/src/remote/apns.rs` builds it, delivered
    /// the way iOS hands it over: `aps` as a nested dictionary and the
    /// session beside it at the top level.
    private let approvalPush: [AnyHashable: Any] = [
        "aps": [
            "alert": ["title": "Argmax: Needs approval", "body": "Build the dashboard"],
            "sound": "default",
            "thread-id": "s-9f2c",
            "interruption-level": "time-sensitive"
        ],
        "sessionId": "s-9f2c"
    ]

    func testATapNamesTheChatToOpen() throws {
        XCTAssertEqual(PushPayload.sessionID(approvalPush), "s-9f2c")
    }

    /// The test push belongs to no chat and carries neither field, so
    /// tapping it opens the app and nothing more. An empty string would
    /// deep-link at a chat that does not exist.
    func testTheTestPushDeepLinksNowhere() {
        let test: [AnyHashable: Any] = [
            "aps": [
                "alert": ["title": "Argmax: Test notification", "body": "Push notifications are working."],
                "sound": "default",
                "interruption-level": "active"
            ]
        ]
        XCTAssertNil(PushPayload.sessionID(test))
        XCTAssertNil(PushPayload.sessionID(["sessionId": ""]))
        XCTAssertNil(PushPayload.sessionID(["sessionId": 7]))
    }

    // MARK: - What the row says

    /// An unreachable Mac must not read as a Mac without a key: the first is
    /// a wait, the second is a sentence telling you to go and fix something.
    func testAnUnansweredMacIsCheckingNotOff() {
        XCTAssertEqual(
            PushRegistration.resolve(configured: nil, authorization: .authorized, registeredName: "iPhone"),
            .checking
        )
    }

    /// A Mac with no APNs key no longer overrides what iOS says. Registering
    /// works without a key — the token reaches `remote.json` and
    /// notifications start the day the key does — so the row keeps reporting
    /// the iOS half, and `hostConfigured` carries the Mac's gap as its own
    /// line above it.
    func testNoKeyOnTheMacStillReportsWhatIOSSays() {
        XCTAssertEqual(
            PushRegistration.resolve(
                configured: false,
                authorization: .notDetermined,
                registeredName: nil
            ),
            .notDetermined,
            "Enable has to stay reachable while the Mac is missing its key"
        )
        XCTAssertEqual(
            PushRegistration.resolve(configured: false, authorization: .denied, registeredName: nil),
            .denied
        )
        XCTAssertEqual(
            PushRegistration.resolve(
                configured: false,
                authorization: .authorized,
                registeredName: "Adam’s iPhone"
            ),
            .enabled(deviceName: "Adam’s iPhone")
        )
    }

    /// The host's `APNS_NOT_CONFIGURED` arrives as an `INVALID_INPUT` issue
    /// whose words are about key paths and team ids. Nothing on the phone
    /// can act on that, so the line says where the fix is; and before the
    /// decoder read that issue at all, the screen printed the literal string
    /// "INVALID_INPUT".
    func testAMissingKeyReadsAsASentenceNotACode() {
        let refusal = BridgeError.host(
            code: "INVALID_INPUT",
            subCode: "APNS_NOT_CONFIGURED",
            message: "set the APNs key path, key id, and team id before sending a test push"
        )
        XCTAssertEqual(PushRegistration.failureMessage(refusal), PushRegistration.noKeyOnMac)
    }

    /// Every other refusal keeps the host's own words: they are written for
    /// a person and say what was actually refused.
    func testEveryOtherRefusalKeepsTheHostsWords() {
        let refusal = BridgeError.host(
            code: "INVALID_INPUT",
            subCode: "APNS_NO_DEVICES",
            message: "pair a phone before sending a test push"
        )
        XCTAssertEqual(
            PushRegistration.failureMessage(refusal),
            "pair a phone before sending a test push"
        )
    }

    func testTheStatesIOSDecides() {
        XCTAssertEqual(
            PushRegistration.resolve(configured: true, authorization: .notDetermined, registeredName: nil),
            .notDetermined
        )
        XCTAssertEqual(
            PushRegistration.resolve(configured: true, authorization: .denied, registeredName: "Adam’s iPhone"),
            .denied,
            "a refusal stands even when the Mac still lists the phone"
        )
        XCTAssertEqual(
            PushRegistration.resolve(configured: true, authorization: .authorized, registeredName: "Adam’s iPhone"),
            .enabled(deviceName: "Adam’s iPhone")
        )
    }

    /// Provisional and ephemeral both deliver, so both are on.
    func testTheQuieterGrantsAreStillOn() {
        for authorization in [UNAuthorizationStatus.provisional, .ephemeral] {
            XCTAssertEqual(
                PushRegistration.resolve(configured: true, authorization: authorization, registeredName: "iPhone"),
                .enabled(deviceName: "iPhone")
            )
        }
    }

    /// Authorized but not on the Mac's list receives nothing, so it reads as
    /// off — and the button that fixes it is the same one.
    func testAuthorizedButUnknownToTheMacIsNotOn() {
        XCTAssertEqual(
            PushRegistration.resolve(configured: true, authorization: .authorized, registeredName: nil),
            .notDetermined
        )
    }

    // MARK: - The token

    /// The host takes hex and lowercases it (`normalize_device_token`), and
    /// rejects anything else outright.
    func testADeviceTokenIsLowercaseHex() {
        XCTAssertEqual(PushRegistration.hex(Data([0x00, 0x1F, 0xA0, 0xFF])), "001fa0ff")
        let token = Data((0..<32).map { UInt8($0) })
        let hex = PushRegistration.hex(token)
        XCTAssertEqual(hex.count, 64, "one byte is two characters, leading zeroes included")
        XCTAssertTrue(hex.allSatisfy { $0.isHexDigit && !$0.isUppercase })
        XCTAssertEqual(PushRegistration.hex(Data()), "")
    }
}
