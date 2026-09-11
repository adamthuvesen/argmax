import UIKit
import XCTest
@testable import Argmax

/// The palette, pinned to `src/renderer/styles/tokens.css`.
///
/// Every surface and every piece of ink in the app is a dynamic colour that
/// resolves against the appearance the view is in, which means a typo in one
/// half of a pair only shows up in one appearance — and the appearance
/// nobody screenshotted is the one that ships wrong. These resolve both
/// halves and check the hex.
final class ThemeTests: XCTestCase {
    private let light = UITraitCollection(userInterfaceStyle: .light)
    private let dark = UITraitCollection(userInterfaceStyle: .dark)

    func testSurfacesAndInkAreTheDesktopTokens() {
        XCTAssertEqual(hex(Theme.groundColor, light), "#FDFDFD")
        XCTAssertEqual(hex(Theme.groundColor, dark), "#141414")
        XCTAssertEqual(hex(Theme.inkColor, light), "#1F1D18")
        XCTAssertEqual(hex(Theme.inkColor, dark), "#F4F2EC")
        XCTAssertEqual(hex(Theme.lineColor, light), "#E3E6E8")
        XCTAssertEqual(hex(Theme.lineColor, dark), "#2B2B29")
        // Paper takes the ink-ward blend (`--chip-ink`); charcoal keeps the
        // raw `--muted`, which already clears AA there.
        XCTAssertEqual(hex(Theme.mutedColor, light), "#7A766C")
        XCTAssertEqual(hex(Theme.mutedColor, dark), "#8A857B")
    }

    func testAttentionKeepsItsOwnThreeColours() {
        XCTAssertEqual(hex(Theme.amberColor, light), "#B08039")
        XCTAssertEqual(hex(Theme.amberColor, dark), "#D9A566")
        XCTAssertEqual(hex(Theme.roseColor, light), "#B85763")
        XCTAssertEqual(hex(Theme.roseColor, dark), "#E08591")
        XCTAssertEqual(hex(Theme.sageColor, light), "#446C56")
        XCTAssertEqual(hex(Theme.sageColor, dark), "#6DAB86")
    }

    /// A raised surface is the ground plus 4% ink — never a grey card with a
    /// shadow, and never a hardcoded second hex that drifts when the ground
    /// moves.
    func testRaisedIsTheGroundPlusFourPercentInk() {
        XCTAssertEqual(hex(Theme.raisedColor, light), "#F4F4F4")
        XCTAssertEqual(hex(Theme.raisedColor, dark), "#1D1D1D")
        // Pressed is the same recipe one step up, so the two never invert.
        XCTAssertGreaterThan(distance(Theme.pressedColor, Theme.groundColor, dark),
                             distance(Theme.raisedColor, Theme.groundColor, dark))
        XCTAssertGreaterThan(distance(Theme.pressedColor, Theme.groundColor, light),
                             distance(Theme.raisedColor, Theme.groundColor, light))
    }

    func testEveryAccentTintResolvesInBothAppearances() {
        let expected: [AccentTint: (String, String)] = [
            .green: ("#446C56", "#6DAB86"),
            .purple: ("#613E9A", "#714FB0"),
            .neutral: ("#6C6960", "#A8A49B"),
            .black: ("#1C1B18", "#F4F2EC"),
            .orange: ("#BD580F", "#E88845"),
            .blue: ("#30609A", "#6693C9"),
            .coral: ("#A64354", "#E96C7F")
        ]
        XCTAssertEqual(Set(expected.keys), Set(AccentTint.allCases))
        for (tint, pair) in expected {
            XCTAssertEqual(hex(tint.uiColor, light), pair.0, "\(tint.rawValue) light")
            XCTAssertEqual(hex(tint.uiColor, dark), pair.1, "\(tint.rawValue) dark")
        }
    }

    /// The phone's default is the fox orange, not the desktop's green, and
    /// the asset catalogue carries the same pair because it is also the
    /// icon's tint.
    func testTheDefaultTintIsTheAssetCatalogueOrange() {
        XCTAssertEqual(AccentTint.fallback, .orange)
        let asset = try? XCTUnwrap(UIColor(named: "Accent"))
        XCTAssertEqual(hex(asset ?? .clear, light), "#BD580F")
        XCTAssertEqual(hex(asset ?? .clear, dark), "#E88845")
    }

    /// Ink on an accent fill is cream, except on the one tint that is itself
    /// cream — the dark appearance's black, which inverts.
    func testOnAccentInvertsForTheCreamTint() {
        XCTAssertEqual(hex(AccentTint.orange.onAccentColor, light), "#FFFFFF")
        XCTAssertEqual(hex(AccentTint.orange.onAccentColor, dark), "#FFFFFF")
        XCTAssertEqual(hex(AccentTint.black.onAccentColor, light), "#FFFFFF")
        XCTAssertEqual(hex(AccentTint.black.onAccentColor, dark), "#131312")
    }

    // MARK: - Helpers

    private func hex(_ color: UIColor, _ traits: UITraitCollection) -> String {
        var (red, green, blue, alpha): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return String(
            format: "#%02X%02X%02X",
            Int((red * 255).rounded()),
            Int((green * 255).rounded()),
            Int((blue * 255).rounded())
        )
    }

    private func distance(_ one: UIColor, _ other: UIColor, _ traits: UITraitCollection) -> CGFloat {
        var (whiteOne, alphaOne): (CGFloat, CGFloat) = (0, 0)
        var (whiteOther, alphaOther): (CGFloat, CGFloat) = (0, 0)
        one.resolvedColor(with: traits).getWhite(&whiteOne, alpha: &alphaOne)
        other.resolvedColor(with: traits).getWhite(&whiteOther, alpha: &alphaOther)
        return abs(whiteOne - whiteOther)
    }
}
