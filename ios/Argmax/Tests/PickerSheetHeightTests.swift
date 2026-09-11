import UIKit
import XCTest
@testable import Argmax

/// How tall a picker opens. The bug this pins: a running chat locks the model
/// list to the session's own CLI — three or four rows — and the sheet used to
/// open at the cap anyway, so those rows sat under two-thirds of blank screen.
final class PickerSheetHeightTests: XCTestCase {
    /// Dynamic Type off, so the arithmetic is the same on every simulator.
    private let unscaled: (UIFont.TextStyle, CGFloat) -> CGFloat = { _, value in value }
    private let screen: CGFloat = 900

    private func height(rows: Int, headings: Int = 0) -> CGFloat {
        pickerSheetHeight(rows: rows, headings: headings, screenHeight: screen, scaled: unscaled)
    }

    func testAShortListOpensShort() {
        // One CLI's models: four rows of 44, the header, and the bottom room.
        XCTAssertEqual(height(rows: 4), 4 * 44 + Spacing.section + Spacing.headerHeight)
        XCTAssertLessThan(height(rows: 4), screen * 0.4, "a handful of rows is not most of the screen")
        XCTAssertLessThan(height(rows: 3), height(rows: 4))
    }

    /// Measured against a real render in `ScratchPickerMeasureTests`: six rows
    /// under two headings came to 412, which is what this has to say.
    func testGroupHeadingsCount() {
        XCTAssertEqual(height(rows: 6, headings: 2), 6 * 44 + 2 * 34 + Spacing.section + Spacing.headerHeight)
        XCTAssertGreaterThan(
            height(rows: 6, headings: 2),
            height(rows: 6),
            "five CLIs means five headings between the rows"
        )
    }

    /// The whole catalogue is longer than any phone, and a picker is a choice
    /// rather than a place.
    func testTheCapHolds() {
        XCTAssertEqual(height(rows: 40), screen * 0.7)
        XCTAssertEqual(height(rows: 200, headings: 5), screen * 0.7)
    }

    /// Cropping the sheet to its own header would cut the empty state off.
    func testAnEmptyListStillHasRoomForItsMessage() {
        XCTAssertEqual(height(rows: 0), 240)
    }

    func testDynamicTypeMovesTheRows() {
        let large = pickerSheetHeight(
            rows: 4,
            headings: 0,
            screenHeight: screen,
            scaled: { _, value in value * 1.5 }
        )
        XCTAssertGreaterThan(large, height(rows: 4))
    }
}
