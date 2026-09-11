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
