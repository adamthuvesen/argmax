import SwiftUI

/// The app's "this is running right now" mark, ported from
/// `src/renderer/styles/working-nest.css`: four dots in a 2×2 where emphasis
/// passes clockwise, so the cluster reads as rearranging rather than
/// blinking. One mark on every surface that shows live work, and the one
/// piece of custom motion the list is allowed.
struct WorkingNest: View {
    /// The web's `--working-nest-cycle`.
    static let cycle: TimeInterval = 0.9

    var size: CGFloat = 18
    /// The chat's own icon colour when it has one. Nil takes the accent,
    /// which is what "the running thing" is marked with everywhere else.
    var tint: Color?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accentTint) private var accent

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            Canvas { canvas, canvasSize in
                for dot in 0..<4 {
                    // A quarter-cycle apart, top-left → top-right →
                    // bottom-right → bottom-left.
                    let phase = reduceMotion
                        ? (dot == 0 ? 0 : 0.5)
                        : (elapsed / Self.cycle - Double(dot) * 0.25)
                            .truncatingRemainder(dividingBy: 1)
                    let relay = Relay(phase: phase < 0 ? phase + 1 : phase)
                    let side = canvasSize.width * 0.314 * relay.scale
                    let origin = CGPoint(
                        x: canvasSize.width * (dot == 1 || dot == 2 ? 0.543 : 0.143),
                        y: canvasSize.height * (dot == 2 || dot == 3 ? 0.543 : 0.143)
                    )
                    let inset = (canvasSize.width * 0.314 - side) / 2
                    canvas.fill(
                        Path(ellipseIn: CGRect(
                            x: origin.x + inset,
                            y: origin.y + inset,
                            width: side,
                            height: side
                        )),
                        with: .color((tint ?? accent.color).opacity(relay.opacity))
                    )
                }
            }
            .frame(width: size, height: size)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Running")
    }

    /// One dot's place in the relay: up fast, hold dim, back up. The web's
    /// keyframes, minus the two-tone hand-off, which needs a second colour
    /// token this app does not have.
    private struct Relay {
        let opacity: Double
        let scale: Double

        init(phase: Double) {
            switch phase {
            case ..<0.05:
                opacity = 1
                scale = 1.2
            case ..<0.30:
                let fall = (phase - 0.05) / 0.25
                opacity = 1 - 0.7 * fall
                scale = 1.2 - 0.42 * fall
            case ..<0.9125:
                opacity = 0.3
                scale = 0.78
            default:
                let rise = (phase - 0.9125) / 0.0875
                opacity = 0.3 + 0.7 * rise
                scale = 0.78 + 0.42 * rise
            }
        }
    }
}
