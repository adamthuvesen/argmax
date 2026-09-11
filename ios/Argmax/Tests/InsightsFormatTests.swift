import XCTest

@testable import Argmax

final class InsightsFormatTests: XCTestCase {
    /// `parse` picks one formatter from the string's shape, so every shape
    /// the host emits has to keep landing: heatmap days, offset stamps, and
    /// fractional-second stamps.
    func testParsesEveryWireDateShape() {
        XCTAssertNotNil(InsightsFormat.parse("2026-08-24"))
        XCTAssertNotNil(InsightsFormat.parse("2026-09-09T00:00:00+02:00"))
        XCTAssertNotNil(InsightsFormat.parse("2026-09-11T08:12:00Z"))
        XCTAssertNotNil(InsightsFormat.parse("2026-09-11T08:12:00.250Z"))
        XCTAssertNil(InsightsFormat.parse("not a date"))
    }
}
