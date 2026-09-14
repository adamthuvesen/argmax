import XCTest
@testable import Argmax

@MainActor
final class HapticsTests: XCTestCase {
    func testCustomHapticsDefaultOnAndPersistAnOptOut() {
        let suite = "HapticsTests-\(UUID().uuidString)"
        let store = UserDefaults(suiteName: suite)!
        defer { store.removePersistentDomain(forName: suite) }

        XCTAssertTrue(Haptics.isEnabled(in: store))
        store.set(false, forKey: Haptics.enabledKey)
        XCTAssertFalse(Haptics.isEnabled(in: store))
    }
}
