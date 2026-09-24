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
        // Core Animation breathes the ring in the render server. Driven from
        // a `TimelineView`, one visible nest re-ran this body and redrew its
        // canvas on every display frame: 11% of the main thread on an idle
        // chat list with one chat running, twice that at 120 Hz.
        WorkingNestLayerView(color: UIColor(tint ?? accent.color), size: size,
                             breathing: active && !reduceMotion,
                             stillOpacity: Self.ringDynamics(elapsed: 0, active: active, reduceMotion: reduceMotion).opacity)
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

private struct WorkingNestLayerView: UIViewRepresentable {
    let color: UIColor
    let size: CGFloat
    let breathing: Bool
    let stillOpacity: Double

    func makeUIView(context: Context) -> WorkingNestView { WorkingNestView() }

    func updateUIView(_ view: WorkingNestView, context: Context) {
        view.update(color: color, box: size, breathing: breathing, stillOpacity: stillOpacity)
    }
}

/// The nest's two layers. The breath is `WorkingNest.ringDynamics` as a
/// repeating animation: a sine ease between the rest and peak rings, half a
/// cycle each way, started at the wall clock's phase so every nest on screen
/// breathes together, as the timeline-driven one did.
final class WorkingNestView: UIView {
    private let core = CAShapeLayer()
    private let ring = CAShapeLayer()
    private var color: UIColor = .clear
    private var box: CGFloat = 0
    private var breathing = false
    private var stillOpacity: Double = 0.9
    private static let breathKey = "breath"

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        ring.fillColor = nil
        ring.lineWidth = 1
        layer.addSublayer(ring)
        layer.addSublayer(core)
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: WorkingNestView, _) in
            view.applyColors()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func update(color: UIColor, box: CGFloat, breathing: Bool, stillOpacity: Double) {
        let reshaped = box != self.box
        let restarted = breathing != self.breathing
        self.color = color
        self.box = box
        self.breathing = breathing
        self.stillOpacity = stillOpacity
        applyColors()
        if reshaped { setNeedsLayout() }
        if restarted || reshaped { restartBreath() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let metrics = WorkingNest.metrics(for: box)
        core.frame = bounds
        ring.frame = bounds
        core.path = UIBezierPath(ovalIn: centred(metrics.coreDiameter)).cgPath
        ring.path = ringPath(scale: 1)
        if breathing, ring.animation(forKey: Self.breathKey) == nil { restartBreath() }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        // A view leaving the window loses its animations.
        if window != nil { restartBreath() }
    }

    private func applyColors() {
        let resolved = color.resolvedColor(with: traitCollection).cgColor
        core.fillColor = resolved
        ring.strokeColor = resolved
    }

    private func centred(_ diameter: CGFloat) -> CGRect {
        CGRect(x: (box - diameter) / 2, y: (box - diameter) / 2, width: diameter, height: diameter)
    }

    private func ringPath(scale: CGFloat) -> CGPath {
        let diameter = WorkingNest.metrics(for: box).baseRingDiameter * scale
        return UIBezierPath(ovalIn: centred(diameter).insetBy(dx: 0.5, dy: 0.5)).cgPath
    }

    private func restartBreath() {
        ring.removeAnimation(forKey: Self.breathKey)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ring.opacity = Float(stillOpacity)
        ring.path = ringPath(scale: 1)
        CATransaction.commit()
        guard breathing, box > 0, window != nil else { return }
        let rest = WorkingNest.ringDynamics(elapsed: 0, active: true, reduceMotion: false)
        let peak = WorkingNest.ringDynamics(elapsed: WorkingNest.cycle / 2, active: true, reduceMotion: false)
        let path = CABasicAnimation(keyPath: "path")
        path.fromValue = ringPath(scale: rest.scale)
        path.toValue = ringPath(scale: peak.scale)
        let opacity = CABasicAnimation(keyPath: "opacity")
        opacity.fromValue = rest.opacity
        opacity.toValue = peak.opacity
        let breath = CAAnimationGroup()
        breath.animations = [path, opacity]
        breath.duration = WorkingNest.cycle / 2
        breath.autoreverses = true
        breath.repeatCount = .infinity
        // `0.5 - 0.5 cos(πx)`, the easeInOutSine curve.
        breath.timingFunction = CAMediaTimingFunction(controlPoints: 0.37, 0, 0.63, 1)
        breath.isRemovedOnCompletion = false
        let phase = Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: WorkingNest.cycle)
        breath.beginTime = ring.convertTime(CACurrentMediaTime(), from: nil) - phase
        ring.add(breath, forKey: Self.breathKey)
    }
}
