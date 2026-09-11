import SwiftUI
import UIKit
import XCTest
@testable import Argmax

/// The typefaces the app can be set to, and the faces behind them.
///
/// `UIFont(name:)` returns nil for a face iOS did not register, and every
/// path in `TypeScale` then falls back to the system font *silently* — the
/// picker would still move, the app would still draw, and every screen would
/// still be in SF. That failure is invisible on a screenshot, so it is
/// asserted here instead.
final class TypographyTests: XCTestCase {
    func testFontScaleKeepsTheCurrentSizeInTheMiddle() {
        XCTAssertEqual(AppFontScale.allCases.map(\.rawValue), [1, 2, 3, 4, 5])
        XCTAssertEqual(AppFontScale.standard.multiplier, 1)
        XCTAssertLessThan(AppFontScale.one.multiplier, AppFontScale.standard.multiplier)
        XCTAssertGreaterThan(AppFontScale.five.multiplier, AppFontScale.standard.multiplier)
    }

    func testFontScaleChangesUIKitTextWithoutReplacingDynamicType() {
        let small = TypeScale(typeface: .system, fontScale: .one).uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        )
        let standard = TypeScale(typeface: .system).uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        )
        let large = TypeScale(typeface: .system, fontScale: .five).uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        )
        let accessibility = TypeScale(typeface: .system, fontScale: .five).uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge)
        )

        XCTAssertLessThan(small.pointSize, standard.pointSize)
        XCTAssertGreaterThan(large.pointSize, standard.pointSize)
        XCTAssertGreaterThan(accessibility.pointSize, large.pointSize)
    }

    /// Each bundled file, as `ios/Argmax/project.yml` lists it.
    func testEveryDeclaredFontFileIsBundledAndRegistered() throws {
        let declared = try XCTUnwrap(
            Bundle.main.object(forInfoDictionaryKey: "UIAppFonts") as? [String],
            "UIAppFonts is missing — no bundled face is registered at all"
        )
        XCTAssertEqual(declared.count, 12, "four weights each of Geist and Inter, and two italics per family")

        for file in declared {
            XCTAssertNotNil(
                Bundle.main.url(forResource: (file as NSString).deletingPathExtension, withExtension: "ttf"),
                "\(file) is declared in UIAppFonts but not in the bundle — run `npm run build:ios-fonts`"
            )
            let postScriptName = (file as NSString).deletingPathExtension
            XCTAssertNotNil(
                UIFont(name: postScriptName, size: 12),
                "\(postScriptName) did not register; the file name and its PostScript name must match"
            )
        }
    }

    /// Geist ships no italic, so emphasis has to reach the sheared face the
    /// build script makes — through the *family*, because an emphasised run
    /// inside an `AttributedString` asks for italic rather than for a name.
    /// Upright emphasis is the failure this catches.
    func testEmphasisReachesTheShearedItalicThroughTheFamily() throws {
        let regular = try XCTUnwrap(UIFont(name: "Geist-Regular", size: 17))
        let italic = try XCTUnwrap(
            regular.fontDescriptor.withSymbolicTraits(.traitItalic).map { UIFont(descriptor: $0, size: 17) }
        )
        XCTAssertEqual(italic.fontName, "Geist-Italic")

        // `***both***` asks for the two traits at once. Bold alone is not
        // enough to reach the bold cut — the upright Geist Bold declares its
        // weight only in usWeightClass — so the request has to carry both,
        // which is what SwiftUI sends for a run that is bold *and* emphasised.
        let bold = try XCTUnwrap(UIFont(name: "Geist-Bold", size: 17))
        let boldItalic = try XCTUnwrap(
            bold.fontDescriptor.withSymbolicTraits([.traitItalic, .traitBold]).map { UIFont(descriptor: $0, size: 17) }
        )
        XCTAssertEqual(boldItalic.fontName, "Geist-BoldItalic")

        let interRegular = try XCTUnwrap(UIFont(name: "Inter-Regular", size: 17))
        let interItalic = try XCTUnwrap(
            interRegular.fontDescriptor.withSymbolicTraits(.traitItalic).map { UIFont(descriptor: $0, size: 17) }
        )
        XCTAssertEqual(interItalic.fontName, "Inter-Italic")

        let interBold = try XCTUnwrap(UIFont(name: "Inter-Bold", size: 17))
        let interBoldItalic = try XCTUnwrap(
            interBold.fontDescriptor.withSymbolicTraits([.traitItalic, .traitBold]).map { UIFont(descriptor: $0, size: 17) }
        )
        XCTAssertEqual(interBoldItalic.fontName, "Inter-BoldItalic")
    }

    /// A weight resolves to its own cut rather than to a synthesised one.
    func testGeistResolvesAFacePerWeight() {
        let scale = TypeScale(typeface: .geist)
        let expected: [(UIFont.Weight, String)] = [
            (.regular, "Geist-Regular"),
            (.medium, "Geist-Medium"),
            (.semibold, "Geist-SemiBold"),
            (.bold, "Geist-Bold")
        ]
        for (weight, face) in expected {
            XCTAssertEqual(scale.uiFont(size: 17, relativeTo: .body, weight: weight).fontName, face)
        }
        // A weight between the four cuts rounds to one that exists.
        XCTAssertEqual(scale.uiFont(size: 17, relativeTo: .body, weight: .heavy).fontName, "Geist-Bold")
        XCTAssertEqual(scale.uiFont(size: 17, relativeTo: .body, weight: .light).fontName, "Geist-Regular")
    }

    func testInterResolvesAFacePerWeight() {
        let scale = TypeScale(typeface: .inter)
        let expected: [(UIFont.Weight, String)] = [
            (.regular, "Inter-Regular"),
            (.medium, "Inter-Medium"),
            (.semibold, "Inter-SemiBold"),
            (.bold, "Inter-Bold")
        ]
        for (weight, face) in expected {
            XCTAssertEqual(scale.uiFont(size: 17, relativeTo: .body, weight: weight).fontName, face)
        }
    }

    /// Identifiers use Apple's SF Mono in every typeface. Geist Mono is not an
    /// iOS choice and is not bundled here.
    func testMonoFollowsTheTypeface() {
        let geistMono = TypeScale(typeface: .geist).uiFont(size: 13, relativeTo: .footnote, mono: true)
        let interMono = TypeScale(typeface: .inter).uiFont(size: 13, relativeTo: .footnote, mono: true)
        XCTAssertTrue(geistMono.fontName.hasPrefix("."))
        XCTAssertTrue(interMono.fontName.hasPrefix("."))
    }

    /// The system typeface names no bundled face at all — SF, and SF Mono for
    /// identifiers.
    func testTheSystemTypefaceStaysOnSF() {
        let scale = TypeScale.system
        XCTAssertTrue(scale.uiFont(size: 17, relativeTo: .body).fontName.hasPrefix("."))
        let mono = scale.uiFont(size: 13, relativeTo: .footnote, mono: true)
        XCTAssertTrue(mono.fontName.hasPrefix("."), "SF Mono is a system face, whose names start with a dot")
        XCTAssertNotEqual(mono.fontName, scale.uiFont(size: 13, relativeTo: .footnote).fontName)
    }

    /// Dynamic Type still moves a custom face: the point size a role resolves
    /// to is the one the content size category asks for, not the base.
    func testACustomFaceStillScalesWithDynamicType() {
        let scale = TypeScale(typeface: .geist)
        let large = scale.uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)
        )
        let huge = scale.uiFont(
            size: 17,
            relativeTo: .body,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge)
        )
        XCTAssertEqual(large.pointSize, 17, accuracy: 0.5, "Large is the size the design is drawn at")
        XCTAssertGreaterThan(huge.pointSize, large.pointSize)
        XCTAssertEqual(huge.fontName, "Geist-Regular", "and it is still Geist at every size")
    }

    /// Shared ids stay stable, while phone-native choices remain explicit and
    /// the retired Geist Mono choice cannot be selected anymore.
    func testTheTypefaceIdsAndRetiredChoice() {
        XCTAssertEqual(AppTypeface.geist.rawValue, "geist-sans")
        XCTAssertEqual(AppTypeface.inter.rawValue, "inter")
        XCTAssertEqual(AppTypeface.sfRounded.rawValue, "sf-rounded")
        XCTAssertNil(AppTypeface(rawValue: "geist-mono"))
    }

    /// `.headline` is the one system text style that is not regular, so a
    /// call site that names no weight has to come out semibold anyway.
    func testHeadlineKeepsItsWeightWithoutBeingAsked() {
        let scale = TypeScale(typeface: .geist)
        XCTAssertEqual(scale.uiFont(size: 17, relativeTo: .headline, weight: .semibold).fontName, "Geist-SemiBold")
        XCTAssertEqual(scale.font(.headline), scale.font(.headline, weight: .semibold))
        XCTAssertNotEqual(scale.font(.headline), scale.font(.headline, weight: .regular))
    }
}
