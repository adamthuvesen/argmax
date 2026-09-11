import SwiftUI
import UIKit

// The desktop's palette, redrawn for the phone.
//
// Every surface and every piece of ink in this app comes from here, and the
// values are `src/renderer/styles/tokens.css` verbatim — not the system
// semantic colours. `Color(.systemBackground)` is pure white on paper and
// pure black on charcoal; Argmax is neither, and a screen that mixes the two
// palettes reads as two apps. See the design brief in
// `docs/plan/hybrid-native-phone.md`.
//
// Each role is a `UIColor(dynamicProvider:)` so it resolves against whatever
// appearance the view hierarchy is in — including the one the Appearance
// setting forces through `.preferredColorScheme`, which stamps the trait on
// the window rather than asking every view to re-read a preference.

enum Theme {
    /// The one ground per appearance. Dark `--bg`, light `--bg`.
    static let groundColor = dynamic(light: 0xFD_FD_FD, dark: 0x14_14_14)
    /// A raised surface is the ground plus 4% ink — never a grey card with a
    /// shadow. Sheets, fields, the reconnecting strip, chip fills.
    static let raisedColor = blend(groundColor, toward: inkColor, 0.04)
    /// What a row looks like under the thumb. Same recipe, one step up.
    static let pressedColor = blend(groundColor, toward: inkColor, 0.06)
    /// Primary text. Warm off-white on charcoal, warm near-black on paper —
    /// never `#fff` or `#000`, which bloom and glare respectively.
    static let inkColor = dynamic(light: 0x1F_1D_18, dark: 0xF4_F2_EC)
    /// Secondary text: the `--muted` warm grey, blended toward the ink on
    /// paper. Raw `#8a857b` lands at 3.6:1 on a near-white ground, under AA
    /// at footnote size, so light takes the desktop's own remedy and mixes
    /// it a third of the way toward `--muted-strong` (`--chip-ink`). Dark
    /// keeps the value, which already clears 4.5:1 on charcoal.
    static let mutedColor = dynamic(light: 0x7A_76_6C, dark: 0x8A_85_7B)
    /// Hairline separators, inset to the text column by their callers.
    static let lineColor = dynamic(light: 0xE3_E6_E8, dark: 0x2B_2B_29)

    // Attention has its own three, and they are never the accent: a list
    // where everything is orange ranks nothing. Muted fills at 16% with the
    // full colour for glyph and text.
    static let amberColor = dynamic(light: 0xB0_80_39, dark: 0xD9_A5_66)
    static let roseColor = dynamic(light: 0xB8_57_63, dark: 0xE0_85_91)
    static let sageColor = dynamic(light: 0x44_6C_56, dark: 0x6D_AB_86)
    /// `--pr-merged`. GitHub's own merged-purple, not a token this app
    /// otherwise uses — a merged PR is the one thing worth a colour no other
    /// row state wears, so it can't be read as attention or as the accent.
    static let violetColor = dynamic(light: 0x82_50_DF, dark: 0xB3_92_F0)
    /// `--stop`. Its own dedicated colour, never the accent — the composer's
    /// stop control has to read the same "this ends the turn" red whichever
    /// accent tint is active, the way the desktop's `.session-stop-button`
    /// never rides `--accent` either.
    static let stopColor = dynamic(light: 0xC4_72_6C, dark: 0xC8_58_50)

    static var ground: Color { Color(groundColor) }
    static var raised: Color { Color(raisedColor) }
    static var pressed: Color { Color(pressedColor) }
    static var ink: Color { Color(inkColor) }
    static var muted: Color { Color(mutedColor) }
    static var line: Color { Color(lineColor) }
    static var stop: Color { Color(stopColor) }
    static var amber: Color { Color(amberColor) }
    static var rose: Color { Color(roseColor) }
    static var sage: Color { Color(sageColor) }
    static var violet: Color { Color(violetColor) }

    /// A colour that changes with the appearance the view is resolved in.
    static func dynamic(light: UInt32, dark: UInt32) -> UIColor {
        UIColor { traits in
            UIColor(rgb: traits.userInterfaceStyle == .dark ? dark : light)
        }
    }

    /// `color-mix(in srgb, base, other <fraction>)`, kept dynamic so a blend
    /// of two dynamic colours is itself one. Both sides are resolved in the
    /// caller's traits rather than at declaration time, which is what lets
    /// `raised` be written once for both appearances.
    static func blend(_ base: UIColor, toward other: UIColor, _ fraction: CGFloat) -> UIColor {
        UIColor { traits in
            let from = base.resolvedColor(with: traits)
            let to = other.resolvedColor(with: traits)
            var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
            from.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
            to.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
            return UIColor(
                red: r1 + (r2 - r1) * fraction,
                green: g1 + (g2 - g1) * fraction,
                blue: b1 + (b2 - b1) * fraction,
                alpha: a1 + (a2 - a1) * fraction
            )
        }
    }
}

extension UIColor {
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

// MARK: - Accent

/// The desktop's seven tints, in the order Settings → Appearance lists them
/// (`src/renderer/lib/accent.ts`). One accent is live at a time and it marks
/// exactly two things: the running work, and the primary action.
///
/// The phone's default is orange rather than the desktop's green — the fox is
/// orange, and it is the phone's whole identity on the pairing screen.
enum AccentTint: String, CaseIterable, Identifiable, Sendable {
    case green
    case purple
    case neutral
    case black
    case orange
    case blue
    case coral

    static let fallback = AccentTint.orange

    var id: String { rawValue }

    var label: String {
        switch self {
        case .green: return "Green"
        case .purple: return "Purple"
        case .neutral: return "Neutral"
        case .black: return "Black"
        case .orange: return "Orange"
        case .blue: return "Blue"
        case .coral: return "Coral"
        }
    }

    /// `--accent-deep` in tokens.css: the shade the effort dial's brightest
    /// pixels lean toward, so the flat mosaic has depth.
    var crestColor: UIColor {
        switch self {
        case .green: return Theme.dynamic(light: 0x2E_50_3E, dark: 0x55_88_6C)
        case .purple: return Theme.dynamic(light: 0x46_28_7B, dark: 0x83_66_B3)
        case .neutral: return Theme.dynamic(light: 0x4A_47_3E, dark: 0xC2_BE_B4)
        case .black: return Theme.dynamic(light: 0x0F_0E_0C, dark: 0xFB_F9_F5)
        case .orange: return Theme.dynamic(light: 0x9C_45_0B, dark: 0xF2_A5_6C)
        case .blue: return Theme.dynamic(light: 0x22_48_78, dark: 0x8F_AC_D8)
        case .coral: return Theme.dynamic(light: 0x86_2B_3C, dark: 0xF3_8A_97)
        }
    }

    var uiColor: UIColor {
        switch self {
        case .green: return Theme.dynamic(light: 0x44_6C_56, dark: 0x6D_AB_86)
        case .purple: return Theme.dynamic(light: 0x61_3E_9A, dark: 0x71_4F_B0)
        case .neutral: return Theme.dynamic(light: 0x6C_69_60, dark: 0xA8_A4_9B)
        case .black: return Theme.dynamic(light: 0x1C_1B_18, dark: 0xF4_F2_EC)
        // The asset catalogue already carries this pair, because it is also
        // the icon's global tint. Reading it back keeps one copy.
        case .orange: return UIColor(named: "Accent") ?? Theme.dynamic(light: 0xBD_58_0F, dark: 0xE8_88_45)
        case .blue: return Theme.dynamic(light: 0x30_60_9A, dark: 0x66_93_C9)
        case .coral: return Theme.dynamic(light: 0xA6_43_54, dark: 0xE9_6C_7F)
        }
    }

    var color: Color { Color(uiColor) }

    /// Ink on an accent-filled button. White on every tint but the dark
    /// appearance's black, which *is* the cream — the desktop inverts that
    /// one the same way (`--on-accent`).
    ///
    /// Stated rather than derived from the fill's luminance: six of the
    /// seven are the same answer, and a threshold that has to be right for
    /// all fourteen values is a worse thing to maintain than one exception.
    var onAccentColor: UIColor {
        Theme.dynamic(light: 0xFF_FF_FF, dark: self == .black ? 0x13_13_12 : 0xFF_FF_FF)
    }

    var onAccent: Color { Color(onAccentColor) }
}

/// The live accent, handed down the tree once rather than read from settings
/// in every leaf. `WorkingNest`, `PrimaryButton` and the header's "+" all
/// read this.
private struct AccentTintKey: EnvironmentKey {
    static let defaultValue = AccentTint.fallback
}

extension EnvironmentValues {
    var accentTint: AccentTint {
        get { self[AccentTintKey.self] }
        set { self[AccentTintKey.self] = newValue }
    }
}
