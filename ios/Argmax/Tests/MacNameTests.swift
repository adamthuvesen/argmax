import XCTest
@testable import Argmax

final class MacNameTests: XCTestCase {
    func testDropsTheOwnerAndCasesTheProduct() {
        XCTAssertEqual(MacName.from(host: "adams-macbook-pro.taildece7e.ts.net"), "MacBook Pro")
        XCTAssertEqual(MacName.from(host: "studio.tailnet.ts.net"), "Studio")
        XCTAssertEqual(MacName.from(host: "kitchen-imac.tailnet.ts.net"), "iMac")
        XCTAssertEqual(MacName.from(host: "macbook-air-2.tailnet.ts.net"), "MacBook Air")
    }

    func testFallsBackToMac() {
        XCTAssertEqual(MacName.from(host: "build-box.tailnet.ts.net"), "Mac")
        XCTAssertEqual(MacName.from(host: nil), "Mac")
    }
}
