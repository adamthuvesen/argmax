import SwiftUI
import UIKit

/// A subagent's emblem: the shape its codename owns, in that codename's hue.
///
/// The desktop's mark, ported (`AgentEmblem.tsx`, `agent-emblems.css`). Binding
/// it to the name rather than the spawn is the point: Gauss is the same mark in
/// every session, on the Mac and on the phone, and a session's agents are
/// distinct for free because their codenames already are.
///
/// The bevel is three passes over the same path — the rim dropped 0.75 below
/// the face, the face in place, and a light sheet scaled about the centre and
/// nudged down-right. Decorative on purpose: the codename beside it is the
/// accessible name.
///
/// Status never touches the hue. A failed agent keeps its shape, greys, and
/// takes a rose corner dot, so the mark says *who* and the row's status word
/// says how it went.
struct AgentEmblem: View {
    let emblem: Emblem
    var size: CGFloat = 16
    var failed: Bool = false
    /// The ground the fault dot's ring is cut from, so the dot separates from
    /// the mark without eating its own radius.
    var surface: Color = Theme.raised

    var body: some View {
        let face = failed ? Theme.mutedColor : AgentEmblemPalette.face(emblem.hue)
        let bevel = AgentEmblemPalette.bevel(face)
        ZStack {
            fill(bevel.deep, transform: CGAffineTransform(translationX: 0, y: 0.75))
            fill(face)
            fill(
                bevel.sheen,
                transform: CGAffineTransform(translationX: 1.85, y: 1.85)
                    .scaledBy(x: 0.7, y: 0.7)
            )
            .opacity(0.55)
            if failed {
                fault
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func fill(_ color: UIColor, transform: CGAffineTransform = .identity) -> some View {
        EmblemShape(shape: emblem.shape, transform: transform)
            .fill(
                Color(color),
                style: FillStyle(eoFill: AgentEmblemArt.evenOddShapes.contains(emblem.shape))
            )
    }

    /// The desktop's `paint-order: stroke` corner dot: a ring of the surface
    /// under a rose disc, both on the 16x16 grid.
    private var fault: some View {
        let unit = size / 16
        return ZStack {
            Circle().fill(surface).frame(width: 6.4 * unit, height: 6.4 * unit)
            Circle().fill(Theme.rose).frame(width: 4.8 * unit, height: 4.8 * unit)
        }
        .offset(x: 4.6 * unit, y: 4.6 * unit)
    }
}

/// One emblem shape, scaled from its 16x16 grid into the view.
private struct EmblemShape: Shape {
    let shape: String
    var transform: CGAffineTransform = .identity

    func path(in rect: CGRect) -> Path {
        let unit = min(rect.width, rect.height) / 16
        return AgentEmblemArt.path(shape)
            .applying(transform)
            .applying(CGAffineTransform(scaleX: unit, y: unit))
    }
}

/// Shape and hue together: what `emblemForCodename` returns on the Mac.
struct Emblem: Hashable, Sendable {
    var shape: String
    var hue: String
}

enum AgentEmblemCatalog {
    /// The emblem a codename wears, or a stable one derived from the name for
    /// a label the launcher invented rather than a scientist — a subagent must
    /// never be the one row in a list with an empty box.
    static func emblem(forCodename codename: String) -> Emblem {
        guard let assigned = AgentEmblemArt.byCodename[codename] else {
            return emblem(forKey: codename)
        }
        return Emblem(shape: assigned.shape, hue: assigned.hue)
    }

    /// A mark for anything with a stable id but no codename. Shape and hue come
    /// off different digits of the same hash, so two ids that collide on one
    /// still differ on the other.
    static func emblem(forKey key: String) -> Emblem {
        let hash = Int(stableHash32(key))
        return Emblem(
            shape: AgentEmblemArt.shapes[hash % AgentEmblemArt.shapes.count],
            hue: AgentEmblemArt.hues[(hash / AgentEmblemArt.shapes.count) % AgentEmblemArt.hues.count]
        )
    }

    /// The name a spawn falls back to before the session's codename assignment
    /// exists. The same function the desktop runs, over the same list, so a
    /// launch wears one mark on both screens.
    static func fallbackCodename(_ toolUseId: String) -> String {
        AgentEmblemArt.codenames[Int(stableHash32(toolUseId)) % AgentEmblemArt.codenames.count]
    }

    /// `stableHash32` from the renderer: FNV-1a over UTF-16 code units, which
    /// is what `charCodeAt` hands it there.
    static func stableHash32(_ input: String) -> UInt32 {
        var hash: UInt32 = 0x811c_9dc5
        for unit in input.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return hash
    }
}

/// The emblem's three tones. The face is the session icon palette — one copy of
/// those nine hues, shared with the chat rows that pick them — and the rim and
/// the sheet are mixed out of it in oklab, the way `agent-emblems.css` does.
///
/// Mixed here rather than baked into the generated art because the failed state
/// bevels `--muted` by the same rule, and because sRGB mixing at these ratios
/// comes out muddier than the Mac's.
enum AgentEmblemPalette {
    static func face(_ hue: String) -> UIColor {
        SessionIcon.uiColor(for: hue) ?? Theme.mutedColor
    }

    /// On paper the hue is already dark, so a rim at dark's ratio disappears
    /// under the face and a sheet blows out to near-white. Light pulls both
    /// mixes back toward the face.
    static func bevel(_ face: UIColor) -> (deep: UIColor, sheen: UIColor) {
        (
            UIColor { traits in
                let dark = traits.userInterfaceStyle == .dark
                return mix(face.resolvedColor(with: traits), toward: .black, weight: dark ? 0.68 : 0.78)
            },
            UIColor { traits in
                let dark = traits.userInterfaceStyle == .dark
                return mix(face.resolvedColor(with: traits), toward: .white, weight: dark ? 0.5 : 0.62)
            }
        )
    }

    /// `color-mix(in oklab, base <weight>, other)`.
    static func mix(_ base: UIColor, toward other: UIColor, weight: Double) -> UIColor {
        let from = oklab(base)
        let to = oklab(other)
        let mixed = (0..<3).map { from[$0] * weight + to[$0] * (1 - weight) }
        let rgb = srgb(mixed)
        return UIColor(red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
    }

    private static func oklab(_ color: UIColor) -> [Double] {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        let linear = [red, green, blue].map { channel -> Double in
            let value = Double(channel)
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let l = cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2])
        let m = cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2])
        let s = cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2])
        return [
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
        ]
    }

    private static func srgb(_ lab: [Double]) -> [CGFloat] {
        let l = pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3)
        let m = pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3)
        let s = pow(lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2], 3)
        return [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        ].map { channel in
            let value = channel <= 0.0031308
                ? channel * 12.92
                : 1.055 * pow(channel, 1 / 2.4) - 0.055
            return CGFloat(min(1, max(0, value)))
        }
    }
}
