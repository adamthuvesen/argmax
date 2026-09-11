import SwiftUI
import UIKit

// The effort control from the chat composer, ported cell for cell.
//
// The desktop draws effort as a rail filled with a streaming mosaic of accent
// pixels — brighter toward the fill's edge, faster the higher the effort,
// throwing sparks near the top — with a luminous cursor riding the fill's
// leading edge and the stops named underneath (`EffortPixelField.tsx`,
// `EffortSlider` in `ModelSelector.tsx`). This is the same drawing on a
// `Canvas`, at phone scale: the composer's width, a 44pt rail, a thumb-wide
// drag, a light haptic on every snap. The constants are the web's; a change
// to one side is a change to both.

/// The mosaic's arithmetic, from `src/renderer/lib/pixelField.ts`.
enum PixelField {
    static let cell: CGFloat = 5
    static let floor: Double = 0.22
    static let intensityCap: Double = 0.85
    static let crestMix: Double = 0.62
    private static let fx = 0.34
    private static let fy = 0.85
    private static let contrast = 1.7

    static func hash(_ c: Double, _ r: Double) -> Double {
        let n = sin(c * 127.1 + r * 311.7) * 43758.5453
        return n - n.rounded(.down)
    }

    static func vnoise(_ x: Double, _ y: Double) -> Double {
        let xi = x.rounded(.down), yi = y.rounded(.down)
        let xf = x - xi, yf = y - yi
        let u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
        let a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1)
        func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
        return lerp(lerp(a, b, u), lerp(c, d, u), v)
    }

    /// Two octaves of horizontally scrolling value noise — a current of small
    /// pixels streaming left to right, not blobs drifting in place.
    static func weight(col: Int, row: Int, scroll: Double) -> Double {
        let sx = Double(col) * fx - scroll, sy = Double(row) * fy
        let w = 0.55 * vnoise(sx, sy) + 0.45 * vnoise(sx * 2.6 - scroll * 0.9, sy * 1.8 + 11.3)
        return min(1, max(0, (w - 0.5) * contrast + 0.5))
    }

    static func jitter(col: Int, row: Int) -> Double {
        0.8 + 0.2 * hash(Double(col) * 0.7, Double(row) * 0.7)
    }

    /// Accent → crest by weight: the brightest cells sit deepest.
    static func color(weight: Double, accent: RGB, crest: RGB) -> RGB {
        let mix = weight > crestMix ? (weight - crestMix) / (1 - crestMix) : 0
        return RGB(r: accent.r + (crest.r - accent.r) * mix, g: accent.g + (crest.g - accent.g) * mix, b: accent.b + (crest.b - accent.b) * mix)
    }

    struct RGB {
        var r: Double, g: Double, b: Double
        init(r: Double, g: Double, b: Double) { self.r = r; self.g = g; self.b = b }
        init(_ color: UIColor, in scheme: ColorScheme) {
            let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light))
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            resolved.getRed(&r, green: &g, blue: &b, alpha: &a)
            self.r = r; self.g = g; self.b = b
        }
        func color(alpha: Double) -> Color { Color(red: r, green: g, blue: b, opacity: alpha) }
    }
}

/// The field's motion between frames: eased level and speed, the scroll phase,
/// and the live sparks. A reference type because the timeline advances it in
/// place each frame; nothing outside the dial reads it.
final class EffortFieldSim {
    // `EffortPixelField.tsx` constants.
    static let baseSpeed = 0.0026, speedRange = 0.036, speedCurve = 1.6, brightFloor = 0.5
    static let sparkOn = 0.62, sparkRate = 3.4, sparkSpeed = 0.055, sparkLife = 620.0
    static let sparkGravity = 0.00016, sparkMax = 180, sparkSpread = Double.pi * 0.82
    static let overscanTop: CGFloat = 15, overscanBottom: CGFloat = 15, overscanRight: CGFloat = 14

    struct Spark { var x, y, vx, vy, life: Double }

    var shownLevel = 0.0
    var shownSpeed = 0.0
    var scroll = 0.0
    var sparks: [Spark] = []
    private var last: TimeInterval = 0

    init(level: Double) { shownLevel = level; shownSpeed = level }

    /// Advance to `now`, easing toward the target, with the web's frame clamp.
    func advance(to now: TimeInterval, level: Double, speed: Double, railWidth: Double, railHeight: Double) {
        let dt = last == 0 ? 16 : min(64, (now - last) * 1000)
        last = now
        shownLevel += (level - shownLevel) * 0.2
        shownSpeed += (speed - shownSpeed) * 0.2
        scroll += dt * (Self.baseSpeed + Self.speedRange * pow(shownSpeed, Self.speedCurve))
        // Sparks only near the top of the range, ramping hard toward the end.
        let heat = max(0, (shownSpeed - Self.sparkOn) / (1 - Self.sparkOn))
        var load = heat * heat * Self.sparkRate * (dt / 16)
        while load > 0 && sparks.count < Self.sparkMax {
            if load >= 1 || Double.random(in: 0..<1) < load {
                let angle = Double.random(in: -1...1) * Self.sparkSpread
                let vel = Self.sparkSpeed * (0.5 + Double.random(in: 0..<1))
                sparks.append(Spark(
                    x: railWidth * shownLevel + Double.random(in: -2...2),
                    y: Double(Self.overscanTop) + Double.random(in: 0..<max(1, railHeight)),
                    vx: cos(angle) * vel, vy: sin(angle) * vel,
                    life: Self.sparkLife * (0.6 + 0.5 * Double.random(in: 0..<1))
                ))
            }
            load -= 1
        }
        sparks = sparks.compactMap { spark in
            var s = spark
            s.life -= dt
            guard s.life > 0 else { return nil }
            s.vy += Self.sparkGravity * dt
            s.x += s.vx * dt
            s.y += s.vy * dt
            return s
        }
    }
}

/// The dial: head, rail, stops. `efforts` runs low → high, left → right.
struct EffortDial: View {
    let efforts: [ReasoningEffort]
    @Binding var selection: ReasoningEffort
    let label: (ReasoningEffort) -> String

    @Environment(\.accentTint) private var accent
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Continuous thumb position in stops; follows the finger while dragging,
    /// otherwise glides to the chosen stop.
    @State private var position: Double = 0
    @State private var dragging = false
    @State private var sim: EffortFieldSim?

    private var maxIndex: Int { max(0, efforts.count - 1) }
    private var index: Int { max(0, efforts.firstIndex(of: selection) ?? 0) }
    private var fraction: Double { maxIndex == 0 ? 0 : position / Double(maxIndex) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            HStack(alignment: .firstTextBaseline) {
                Text("Effort").font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Text(label(selection)).font(.caption.weight(.medium)).foregroundStyle(accent.color)
            }
            rail
                .frame(height: 44)
            stops
                .frame(height: 24)
        }
        .onAppear {
            position = Double(index)
            if sim == nil { sim = EffortFieldSim(level: fraction) }
        }
        .onChange(of: selection) { _, _ in
            guard !dragging else { return }
            withAnimation(.easeOut(duration: 0.2)) { position = Double(index) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reasoning effort")
        .accessibilityValue(label(selection))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: select(index + 1)
            case .decrement: select(index - 1)
            @unknown default: break
            }
        }
    }

    // MARK: - Rail

    private var rail: some View {
        GeometryReader { proxy in
            let width = proxy.size.width, height = proxy.size.height
            ZStack(alignment: .leading) {
                // The sunken pill the field is clipped to.
                RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                    .fill(Theme.ground)
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                            .strokeBorder(Theme.ink.opacity(0.06), lineWidth: 1)
                    )
                field(width: width, height: height)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
                sparksLayer(width: width, height: height)
                // The cursor: the fill's leading edge, a luminous accent bar.
                Capsule()
                    .fill(accent.color)
                    .frame(width: 3, height: height + 6)
                    .shadow(color: accent.color.opacity(dragging ? 0.8 : 0.65), radius: dragging ? 8 : 5)
                    .offset(x: fraction * width - 1.5)
                    .animation(dragging ? nil : .easeOut(duration: 0.2), value: fraction)
            }
            .contentShape(.rect)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        dragging = true
                        let next = min(Double(maxIndex), max(0, value.location.x / max(1, width) * Double(maxIndex)))
                        position = next
                        select(Int(next.rounded()))
                    }
                    .onEnded { value in
                        let next = Int((value.location.x / max(1, width) * Double(maxIndex)).rounded())
                        dragging = false
                        select(next)
                        withAnimation(.easeOut(duration: 0.2)) { position = Double(min(maxIndex, max(0, next))) }
                    }
            )
        }
    }

    /// The streaming mosaic, drawn each frame; static under Reduce Motion.
    private func field(width: CGFloat, height: CGFloat) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
            Canvas { context, size in
                guard let sim else { return }
                if !reduceMotion {
                    sim.advance(to: timeline.date.timeIntervalSinceReferenceDate, level: fraction, speed: fraction, railWidth: width, railHeight: height)
                } else {
                    sim.shownLevel = fraction
                    sim.sparks.removeAll()
                }
                let accentRGB = PixelField.RGB(accent.uiColor, in: scheme)
                let crestRGB = PixelField.RGB(accent.crestColor, in: scheme)
                let fillWidth = size.width * sim.shownLevel
                guard fillWidth > 0.5 else { return }
                let cell = PixelField.cell
                let cols = Int(ceil(size.width / cell)), rows = Int(ceil(size.height / cell))
                let bright = EffortFieldSim.brightFloor + (1 - EffortFieldSim.brightFloor) * sim.shownSpeed
                for r in 0..<rows {
                    for c in 0..<cols {
                        let x = CGFloat(c) * cell
                        if x >= fillWidth { break }
                        let w = PixelField.weight(col: c, row: r, scroll: sim.scroll)
                        let ramp = 0.2 + 0.8 * Double(x / fillWidth)
                        var intensity = ramp * (PixelField.floor + (1 - PixelField.floor) * w) * PixelField.jitter(col: c, row: r) * bright
                        intensity = min(PixelField.intensityCap, intensity)
                        if intensity < 0.02 { continue }
                        let rgb = PixelField.color(weight: w, accent: accentRGB, crest: crestRGB)
                        context.fill(Path(CGRect(x: x, y: CGFloat(r) * cell, width: cell - 1, height: cell - 1)), with: .color(rgb.color(alpha: intensity)))
                    }
                }
            }
        }
    }

    /// Sparks live outside the clipped rail so they can fly past its edge.
    private func sparksLayer(width: CGFloat, height: CGFloat) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { _ in
            Canvas { context, _ in
                guard let sim, !reduceMotion else { return }
                let crest = PixelField.RGB(accent.crestColor, in: scheme)
                for s in sim.sparks {
                    let alpha = min(0.9, (s.life / EffortFieldSim.sparkLife) * 0.95)
                    let y = s.y - Double(EffortFieldSim.overscanTop)
                    context.fill(Path(CGRect(x: s.x.rounded(), y: y.rounded(), width: PixelField.cell - 1, height: PixelField.cell - 1)), with: .color(crest.color(alpha: alpha)))
                }
            }
            .frame(width: width + EffortFieldSim.overscanRight, height: height + EffortFieldSim.overscanTop + EffortFieldSim.overscanBottom)
            .offset(y: 0)
            .allowsHitTesting(false)
        }
        .frame(width: width, height: height, alignment: .topLeading)
    }

    // MARK: - Stops

    private var stops: some View {
        GeometryReader { proxy in
            ForEach(Array(efforts.enumerated()), id: \.offset) { stop, effort in
                let lit = stop <= index, active = stop == index
                let x = maxIndex == 0 ? 0 : CGFloat(stop) / CGFloat(maxIndex) * proxy.size.width
                VStack(spacing: 3) {
                    Rectangle()
                        .fill(active ? accent.color : (lit ? accent.color.opacity(0.7) : Theme.line))
                        .frame(width: 1, height: active ? 7 : 5)
                    Text(label(effort))
                        .font(.caption2.weight(active ? .medium : .regular))
                        .foregroundStyle(active ? accent.color : (lit ? Theme.ink.opacity(0.75) : Theme.muted))
                        .lineLimit(1)
                        .fixedSize()
                }
                .position(x: min(max(x, 16), proxy.size.width - 16), y: 12)
                .onTapGesture { select(stop) }
            }
        }
    }

    private func select(_ next: Int) {
        let clamped = min(maxIndex, max(0, next))
        let effort = efforts[clamped]
        guard effort != selection else { return }
        // Felt, not just seen: the thumb covers the label it is moving to.
        Haptics.light()
        selection = effort
    }
}
