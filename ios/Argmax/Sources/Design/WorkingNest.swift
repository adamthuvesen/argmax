import SwiftUI

/// The app's "this is running right now" mark, ported from
/// `src/renderer/styles/working-nest.css`: a still core with one breathing
/// ring (`halo` style) on the shared 2.6s cadence. The core keeps a fixed
/// anchor while the ring carries the live signal. One mark on every surface
/// that shows live work or loading states.
struct WorkingNest: View {
    /// The halo cadence: 2.6s shared with the thought eyebrow and compaction notice.
    static let cycle: TimeInterval = 2.6

    var size: CGFloat = 18
    /// Live work moves; a settled mark holds the still frame. The desktop
    /// nest does the same with `active`.
    var active: Bool = true
    /// The chat's own icon colour when it has one. Nil takes the accent,
    /// which is what "the running thing" is marked with everywhere else.
    var tint: Color?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accentTint) private var accent

    var body: some View {
        TimelineView(.animation(paused: reduceMotion || !active)) { context in
            let elapsed = context.date.timeIntervalSinceReferenceDate
            let (scale, opacity) = Self.ringDynamics(
                elapsed: elapsed,
                active: active,
                reduceMotion: reduceMotion
            )
            Canvas { canvas, canvasSize in
                let color = tint ?? accent.color
                let metrics = Self.metrics(for: canvasSize.width)

                // 1. Core: still anchor at the centre
                let coreOrigin = CGPoint(
                    x: (canvasSize.width - metrics.coreDiameter) / 2,
                    y: (canvasSize.height - metrics.coreDiameter) / 2
                )
                canvas.fill(
                    Path(ellipseIn: CGRect(
                        origin: coreOrigin,
                        size: CGSize(width: metrics.coreDiameter, height: metrics.coreDiameter)
                    )),
                    with: .color(color)
                )

                // 2. Ring: breathing halo
                let ringDiameter = metrics.baseRingDiameter * scale
                let ringRect = CGRect(
                    x: (canvasSize.width - ringDiameter) / 2,
                    y: (canvasSize.height - ringDiameter) / 2,
                    width: ringDiameter,
                    height: ringDiameter
                ).insetBy(dx: 0.5, dy: 0.5)

                canvas.stroke(
                    Path(ellipseIn: ringRect),
                    with: .color(color.opacity(opacity)),
                    lineWidth: 1
                )
            }
            .frame(width: size, height: size)
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Running")
    }

    struct Metrics: Equatable {
        let ringInset: CGFloat
        let coreInset: CGFloat
        let baseRingDiameter: CGFloat
        let coreDiameter: CGFloat
    }

    static func metrics(for box: CGFloat) -> Metrics {
        let ringInset = (box * 0.12).rounded()
        let coreInset = (box * 0.34).rounded()
        return Metrics(
            ringInset: ringInset,
            coreInset: coreInset,
            baseRingDiameter: box - 2 * ringInset,
            coreDiameter: box - 2 * coreInset
        )
    }

    static func ringDynamics(
        elapsed: TimeInterval,
        active: Bool,
        reduceMotion: Bool
    ) -> (scale: CGFloat, opacity: Double) {
        if reduceMotion {
            return (1.0, active ? 0.9 : 0.35)
        }
        guard active else {
            return (1.0, 0.9)
        }
        let phase = (elapsed / cycle).truncatingRemainder(dividingBy: 1)
        let normalized = phase < 0 ? phase + 1 : phase
        let breath = 0.5 - 0.5 * cos(2 * .pi * normalized)
        let scale = 0.8 + 0.2 * CGFloat(breath)
        let opacity = 0.35 + 0.55 * breath
        return (scale, opacity)
    }
}
