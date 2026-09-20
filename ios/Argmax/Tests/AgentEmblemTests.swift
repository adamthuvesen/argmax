import SwiftUI
import XCTest
@testable import Argmax

/// The emblem set is generated from the renderer's, and the whole point of it
/// is that a codename wears one face everywhere. A drift — a reordered name
/// list, a hash that treats a string differently, a shape that came out of the
/// arc conversion empty — would show up as the phone quietly drawing a
/// different agent's mark than the Mac, which nothing else would catch.
final class AgentEmblemTests: XCTestCase {
    /// Pinned against `stableHash32` in src/renderer/lib/stableHash.ts. FNV-1a
    /// over UTF-16 code units, so a name outside ASCII has to agree too.
    func testHashMatchesTheRenderer() {
        XCTAssertEqual(AgentEmblemCatalog.stableHash32("toolu_01ABC"), 312_776_976)
        XCTAssertEqual(AgentEmblemCatalog.stableHash32("agent-7"), 3_914_625_298)
        XCTAssertEqual(AgentEmblemCatalog.stableHash32(""), 2_166_136_261)
        XCTAssertEqual(AgentEmblemCatalog.stableHash32("Schrödinger"), 3_499_000_510)
    }

    /// A launch whose codename has not reached the phone yet still has to land
    /// on the name the desktop gave it, or the mark would change when the
    /// assignment arrives.
    func testFallbackCodenameMatchesTheRenderer() {
        XCTAssertEqual(AgentEmblemCatalog.fallbackCodename("toolu_01ABC"), "Hawking")
        XCTAssertEqual(AgentEmblemCatalog.fallbackCodename("agent-7"), "Codd")
        XCTAssertEqual(AgentEmblemCatalog.fallbackCodename("01J9ZQ3K7VX0"), "Ritchie")
    }

    func testCodenamesCarryTheirDesktopEmblem() {
        XCTAssertEqual(AgentEmblemCatalog.emblem(forCodename: "Gauss"), Emblem(shape: "quad", hue: "green"))
        XCTAssertEqual(AgentEmblemCatalog.emblem(forCodename: "Codd"), Emblem(shape: "orbit", hue: "blue"))
        XCTAssertEqual(AgentEmblemCatalog.emblem(forCodename: "Kelvin"), Emblem(shape: "pinwheel", hue: "red"))
    }

    /// A label the launcher invented rather than a scientist still gets a mark.
    func testUnknownNamesFallThroughToAHashedEmblem() {
        XCTAssertEqual(AgentEmblemCatalog.emblem(forCodename: "agent-7"), Emblem(shape: "gem", hue: "plum"))
        XCTAssertEqual(AgentEmblemCatalog.emblem(forKey: "01J9ZQ3K7VX0"), Emblem(shape: "hourglass", hue: "violet"))
    }

    func testEveryCodenameResolvesToAKnownShapeAndHue() {
        XCTAssertEqual(AgentEmblemArt.codenames.count, 100)
        for codename in AgentEmblemArt.codenames {
            let emblem = AgentEmblemCatalog.emblem(forCodename: codename)
            XCTAssertTrue(
                AgentEmblemArt.shapes.contains(emblem.shape),
                "\(codename) wears an unknown shape \(emblem.shape)"
            )
            XCTAssertTrue(
                AgentEmblemArt.hues.contains(emblem.hue),
                "\(codename) wears an unknown hue \(emblem.hue)"
            )
        }
    }

    /// The arcs are converted to béziers by the exporter, and a conversion that
    /// dropped a subpath would still compile — it would just draw less of the
    /// mark. Every shape has to fill the grid it was drawn for: the set is a
    /// 14-unit circle centred at (8, 8), so a shape spanning under 10 units in
    /// either direction lost something.
    func testEveryShapeFillsItsGrid() {
        for shape in AgentEmblemArt.shapes {
            let bounds = AgentEmblemArt.path(shape).boundingRect
            XCTAssertFalse(bounds.isEmpty, "\(shape) has an empty path")
            XCTAssertGreaterThan(bounds.width, 10, "\(shape) is too narrow to be the whole mark")
            XCTAssertGreaterThan(bounds.height, 10, "\(shape) is too short to be the whole mark")
            XCTAssertGreaterThanOrEqual(bounds.minX, 0.5, "\(shape) runs off the grid on the left")
            XCTAssertGreaterThanOrEqual(bounds.minY, 0.5, "\(shape) runs off the grid on top")
            XCTAssertLessThanOrEqual(bounds.maxX, 15.5, "\(shape) runs off the grid on the right")
            XCTAssertLessThanOrEqual(bounds.maxY, 15.5, "\(shape) runs off the grid at the bottom")
        }
    }

    /// The three with a hole are filled even-odd; a shape wrongly in that set
    /// would punch a hole through itself.
    func testOnlyTheHollowShapesFillEvenOdd() {
        XCTAssertEqual(AgentEmblemArt.evenOddShapes, ["orbit", "bloom", "gem"])
    }

    /// Every hue is a session icon token. The emblem mixes its rim and sheet
    /// out of that colour, and a token the palette has never heard of would
    /// bevel grey.
    func testEveryHueIsInTheSessionIconPalette() {
        for hue in AgentEmblemArt.hues {
            XCTAssertNotNil(SessionIcon.uiColor(for: hue), "\(hue) is not a session icon colour")
        }
    }

    /// The bevel is the reason the mark reads as an object rather than a
    /// silhouette: the rim has to sit under the face and the sheet over it, on
    /// both grounds.
    func testTheBevelStaysDarkerAndLighterThanItsFace() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for hue in AgentEmblemArt.hues {
                let face = AgentEmblemPalette.face(hue)
                let bevel = AgentEmblemPalette.bevel(face)
                let faceLuminance = luminance(face, traits)
                XCTAssertLessThan(
                    luminance(bevel.deep, traits),
                    faceLuminance,
                    "\(hue)'s rim is not darker than its face in \(style == .dark ? "dark" : "light")"
                )
                XCTAssertGreaterThan(
                    luminance(bevel.sheen, traits),
                    faceLuminance,
                    "\(hue)'s sheet is not lighter than its face in \(style == .dark ? "dark" : "light")"
                )
            }
        }
    }

    private func luminance(_ color: UIColor, _ traits: UITraitCollection) -> CGFloat {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
}
