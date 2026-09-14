import XCTest
@testable import Argmax

final class EffortDialTests: XCTestCase {
    func testCanonicalHeatDoesNotPromoteAShorterRailToUltra() {
        XCTAssertEqual(PixelField.canonicalHeat(position: 0, efforts: [ReasoningEffort(rawValue: "max")]), 0.8)
        XCTAssertEqual(PixelField.canonicalHeat(position: 3, efforts: [.low, .medium, .high, ReasoningEffort(rawValue: "xhigh")]), 0.6)
    }

    func testCanonicalHeatInterpolatesSparseProviderEfforts() {
        let efforts = [ReasoningEffort.low, .high, ReasoningEffort(rawValue: "max")]
        XCTAssertEqual(PixelField.canonicalHeat(position: 0.5, efforts: efforts), 0.2)
        XCTAssertEqual(PixelField.canonicalHeat(position: 1.5, efforts: efforts), 0.6)
    }
}
