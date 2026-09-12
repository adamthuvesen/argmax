import XCTest
@testable import Argmax

/// Theme and accent survive a relaunch, and a value this build cannot read
/// lands on the default rather than on nothing.
@MainActor
final class AppearanceTests: XCTestCase {
    private var store: UserDefaults!
    private let suite = "com.argmax.remote.tests.appearance"

    override func setUp() {
        super.setUp()
        // A scratch suite, so a test never rewrites the simulator's real
        // preference and a failure never leaves the app on Coral.
        UserDefaults().removePersistentDomain(forName: suite)
        store = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        store = nil
        super.tearDown()
    }

    func testAFreshInstallFollowsTheSystemInTheFoxOrange() {
        let appearance = Appearance(store: store)
        XCTAssertEqual(appearance.theme, .system)
        XCTAssertNil(appearance.theme.colorScheme)
        XCTAssertEqual(appearance.tint, .orange)
        XCTAssertEqual(appearance.chatDetail, .compact)
        XCTAssertEqual(appearance.fontScale, .standard)
        XCTAssertEqual(appearance.activityIconColorMode, .color)
    }

    func testChatDetailSurvivesARelaunch() {
        let first = Appearance(store: store)
        first.chatDetail = .detailed

        XCTAssertEqual(store.integer(forKey: Appearance.chatDetailKey), MobileChatDetail.detailed.rawValue)
        XCTAssertEqual(Appearance(store: store).chatDetail, .detailed)
    }

    func testUnreadableChatDetailFallsBackToCompact() {
        store.set(99, forKey: Appearance.chatDetailKey)

        XCTAssertEqual(Appearance(store: store).chatDetail, .compact)
    }

    /// The bubble tint is stored as the page's own word under the page's own
    /// key, so the shell can hand the value over unchanged and the two halves
    /// of the phone never disagree about what "neutral" is.
    func testBubbleTintIsStoredAsThePageSpellsIt() {
        let appearance = Appearance(store: store)
        XCTAssertTrue(appearance.accentBubbles, "accent is the page's own default")
        XCTAssertEqual(appearance.bubbleTint, "accent")

        appearance.accentBubbles = false

        XCTAssertEqual(appearance.bubbleTint, "neutral")
        XCTAssertEqual(store.string(forKey: Appearance.bubbleTintKey), "neutral")
        XCTAssertFalse(Appearance(store: store).accentBubbles, "and it survives a relaunch")
    }

    /// The fox ships on and is opted out of, and the choice outlives the
    /// launch that made it — `bool(forKey:)` alone would read a never-written
    /// key as "hidden".
    func testTheFoxShipsOnAndStaysOffOnceTurnedOff() {
        let first = Appearance(store: store)
        XCTAssertTrue(first.mascot)

        first.mascot = false

        XCTAssertEqual(store.object(forKey: "argmax.mascot.visible") as? Bool, false)
        XCTAssertFalse(Appearance(store: store).mascot)
    }

    /// The phone ships in SF Pro, the closest match to the ChatGPT-style
    /// reference, and keeps the choice under the shared font key.
    func testTheTypefaceDefaultsToSFProAndSurvivesARelaunch() {
        let first = Appearance(store: store)
        XCTAssertEqual(first.typeface, .system)

        first.typeface = .system

        XCTAssertEqual(store.string(forKey: "argmax.font.family"), "system")
        XCTAssertEqual(Appearance(store: store).typeface, .system)
    }

    /// A value the phone cannot draw must land on its SF Pro default.
    func testADesktopOnlyFontFallsBackToTheDefault() {
        store.set("fira-code", forKey: Appearance.typefaceKey)

        XCTAssertEqual(Appearance(store: store).typeface, .system)
    }

    func testFontScaleSurvivesARelaunch() {
        let first = Appearance(store: store)
        first.fontScale = .five

        XCTAssertEqual(store.integer(forKey: Appearance.fontScaleKey), 5)
        XCTAssertEqual(Appearance(store: store).fontScale, .five)
    }

    func testUnreadableFontScaleFallsBackToTheCurrentSize() {
        store.set(99, forKey: Appearance.fontScaleKey)

        XCTAssertEqual(Appearance(store: store).fontScale, .standard)
    }

    func testActivityIconColorModeSurvivesARelaunchAndRejectsUnknownValues() {
        let first = Appearance(store: store)
        first.activityIconColorMode = .monochrome

        XCTAssertEqual(
            store.string(forKey: Appearance.activityIconColorModeKey),
            ActivityIconColorMode.monochrome.rawValue
        )
        XCTAssertEqual(Appearance(store: store).activityIconColorMode, .monochrome)

        store.set("sepia", forKey: Appearance.activityIconColorModeKey)
        XCTAssertEqual(Appearance(store: store).activityIconColorMode, .color)
    }

    func testBothChoicesSurviveARelaunch() {
        let first = Appearance(store: store)
        first.theme = .dark
        first.tint = .coral

        let second = Appearance(store: store)
        XCTAssertEqual(second.theme, .dark)
        XCTAssertEqual(second.tint, .coral)
    }

    /// The keys are the web client's own, so the two halves of the phone
    /// name the same two settings the same way.
    func testItWritesTheWebClientsKeys() {
        let appearance = Appearance(store: store)
        appearance.theme = .light
        appearance.tint = .blue
        XCTAssertEqual(store.string(forKey: "argmax.theme.mode"), "light")
        XCTAssertEqual(store.string(forKey: "argmax.accent.tint"), "blue")
    }

    /// A tint renamed or dropped between builds must not leave the app with
    /// no accent at all.
    func testAnUnreadableValueFallsBackRatherThanBlanking() {
        store.set("solarized", forKey: Appearance.accentKey)
        store.set("sepia", forKey: Appearance.themeKey)
        let appearance = Appearance(store: store)
        XCTAssertEqual(appearance.tint, .orange)
        XCTAssertEqual(appearance.theme, .system)
    }

    func testTheTwoOverridesForceAScheme() {
        XCTAssertEqual(ThemeChoice.light.colorScheme, .light)
        XCTAssertEqual(ThemeChoice.dark.colorScheme, .dark)
    }
}
