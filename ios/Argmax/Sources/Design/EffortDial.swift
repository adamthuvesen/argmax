import SwiftUI
import UIKit

// The effort control from the chat composer, ported cell for cell.
//
// The desktop draws effort as a rail filled with a streaming mosaic of accent
// pixels whose energy escalates at every stop: runners, a hot edge, surges,
// tearing and finally lightning. This is the same drawing on a `Canvas`, at
// phone scale, with the same heat tiers in the cursor and labels. The constants
// are the web's; a change to one side is a change to both.

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
        func mixed(toward other: RGB, by amount: Double) -> RGB {
            RGB(
                r: r + (other.r - r) * amount,
                g: g + (other.g - g) * amount,
                b: b + (other.b - b) * amount
            )
        }
    }

    static func drive(_ heat: Double, after threshold: Double) -> Double {
        min(1, max(0, (heat - threshold) / (1 - threshold)))
    }

    /// Map a provider-specific rail onto the product-wide low→ultra heat
    /// scale. A one-stop Max rail is still Max heat, not zero or Ultra.
    static func canonicalHeat(position: Double, efforts: [ReasoningEffort]) -> Double {
        let ladder = ["low", "medium", "high", "xhigh", "max", "ultra"]
        let maxIndex = max(0, efforts.count - 1)
        let lowerPosition = position.rounded(.down)
        let lowerIndex = min(maxIndex, max(0, Int(lowerPosition)))
        let upperIndex = min(maxIndex, max(0, Int(ceil(position))))
        guard
            let lower = efforts[safe: lowerIndex],
            let upper = efforts[safe: upperIndex],
            let lowerRank = ladder.firstIndex(of: lower.rawValue),
            let upperRank = ladder.firstIndex(of: upper.rawValue)
        else { return 0 }
        let progress = position - lowerPosition
        return (Double(lowerRank) + Double(upperRank - lowerRank) * progress) / Double(ladder.count - 1)
    }
}

/// The field's motion between frames: eased level and speed, the scroll phase,
/// and the live sparks. A reference type because the timeline advances it in
/// place each frame; nothing outside the dial reads it.
final class EffortFieldSim {
    // `EffortPixelField.tsx` constants.
    static let baseSpeed = 0.002, speedRange = 0.05, speedCurve = 1.8, chaosSpeedKick = 0.6, brightFloor = 0.35
    static let runnerOn = 0.1, hotOn = 0.3, surgeOn = 0.5, tearOn = 0.7, chaosOn = 0.9
    static let runnerRate = 0.9, runnerSpeed = 0.16, runnerSpeedRange = 0.34, runnerTail = 3, runnerMax = 40
    static let edgeCells = 6.0, edgeWhite = 0.85
    static let surgeWavelength = 0.06, surgeSpeed = 0.011, surgeDepth = 0.6
    static let sparkRate = 7.0, sparkSpeed = 0.055, sparkLife = 620.0
    static let sparkGravity = 0.00016, sparkMax = 400, sparkSpread = Double.pi * 0.82
    static let tearChance = 0.09, tearMaxCells = 3, tearHold = 140.0
    static let blowoutChance = 0.025, dropoutChance = 0.05
    static let boltChance = 0.16, boltLife = 110.0, boltMinCells = 5, boltMaxCells = 11
    static let overscanTop: CGFloat = 15, overscanBottom: CGFloat = 15, overscanRight: CGFloat = 14

    struct Spark { var x, y, vx, vy, life, size: Double }
    struct Runner { var x: Double; var row: Int; var speed: Double }
    struct Bolt { var cells: [CGPoint]; var life: Double }

    var shownLevel = 0.0
    var shownHeat = 0.0
    var scroll = 0.0
    var surgePhase = 0.0
    var frame = 0
    var sparks: [Spark] = []
    var runners: [Runner] = []
    var bolts: [Bolt] = []
    var tearShift: [Int] = []
    private var tearTTL: [Double] = []
    private var last: TimeInterval = 0

    init(level: Double, heat: Double) { shownLevel = level; shownHeat = heat }

    /// Advance to `now`, easing toward the target, with the web's frame clamp.
    func advance(to now: TimeInterval, level: Double, heat: Double, railWidth: Double, railHeight: Double) {
        let dt = last == 0 ? 16 : min(64, (now - last) * 1000)
        last = now
        shownLevel += (level - shownLevel) * 0.2
        shownHeat += (heat - shownHeat) * 0.2

        let runnerDrive = PixelField.drive(shownHeat, after: Self.runnerOn)
        let hotDrive = PixelField.drive(shownHeat, after: Self.hotOn)
        let tearDrive = PixelField.drive(shownHeat, after: Self.tearOn)
        let chaosDrive = PixelField.drive(shownHeat, after: Self.chaosOn)
        let rate = (Self.baseSpeed + Self.speedRange * pow(shownHeat, Self.speedCurve)) * (1 + chaosDrive * Self.chaosSpeedKick)
        scroll += dt * rate
        surgePhase += dt * Self.surgeSpeed
        frame += 1

        let rows = max(1, Int(ceil(railHeight / Double(PixelField.cell))))
        if tearShift.count != rows {
            tearShift = Array(repeating: 0, count: rows)
            tearTTL = Array(repeating: 0, count: rows)
        }
        for row in tearShift.indices {
            if tearTTL[row] > 0 {
                tearTTL[row] -= dt
                if tearTTL[row] <= 0 { tearShift[row] = 0 }
            } else if tearDrive > 0, Double.random(in: 0..<1) < tearDrive * Self.tearChance {
                let magnitude = 1 + Int(Double.random(in: 0..<Double(Self.tearMaxCells)) * tearDrive)
                tearShift[row] = Bool.random() ? magnitude : -magnitude
                tearTTL[row] = Self.tearHold * Double.random(in: 0.5..<1.5)
            }
        }

        spawnLoad(runnerDrive * Self.runnerRate, dt: dt) { [self] in
            guard runners.count < Self.runnerMax else { return }
            runners.append(Runner(
                x: -Double(PixelField.cell) * Double(Self.runnerTail),
                row: Int.random(in: 0..<rows),
                speed: (Self.runnerSpeed + Self.runnerSpeedRange * runnerDrive) * Double.random(in: 0.7..<1.3)
            ))
        }
        let fillWidth = railWidth * shownLevel
        for runnerIndex in runners.indices.reversed() {
            runners[runnerIndex].x += runners[runnerIndex].speed * dt
            if runners[runnerIndex].x >= fillWidth {
                let row = runners[runnerIndex].row
                runners.remove(at: runnerIndex)
                if hotDrive > 0 {
                    spawnSpark(hot: hotDrive, chaos: chaosDrive, railWidth: railWidth, railHeight: railHeight, y: Double(Self.overscanTop) + Double(row) * Double(PixelField.cell))
                }
            }
        }

        spawnLoad(pow(hotDrive, 1.5) * Self.sparkRate, dt: dt) { [self] in
            spawnSpark(hot: hotDrive, chaos: chaosDrive, railWidth: railWidth, railHeight: railHeight)
        }
        for sparkIndex in sparks.indices.reversed() {
            sparks[sparkIndex].life -= dt
            if sparks[sparkIndex].life <= 0 {
                sparks.remove(at: sparkIndex)
                continue
            }
            sparks[sparkIndex].vy += Self.sparkGravity * dt
            sparks[sparkIndex].x += sparks[sparkIndex].vx * dt
            sparks[sparkIndex].y += sparks[sparkIndex].vy * dt
        }

        if chaosDrive > 0, Double.random(in: 0..<1) < chaosDrive * Self.boltChance {
            spawnBolt(railWidth: railWidth, rows: rows)
        }
        for boltIndex in bolts.indices.reversed() {
            bolts[boltIndex].life -= dt
            if bolts[boltIndex].life <= 0 { bolts.remove(at: boltIndex) }
        }
    }

    func settle(level: Double, heat: Double, rows: Int) {
        shownLevel = level
        shownHeat = heat
        sparks.removeAll()
        runners.removeAll()
        bolts.removeAll()
        tearShift = Array(repeating: 0, count: rows)
        tearTTL = Array(repeating: 0, count: rows)
    }

    private func spawnLoad(_ perFrame: Double, dt: Double, spawn: () -> Void) {
        var load = perFrame * (dt / 16)
        while load > 0 {
            if load >= 1 || Double.random(in: 0..<1) < load { spawn() }
            load -= 1
        }
    }

    private func spawnSpark(hot: Double, chaos: Double, railWidth: Double, railHeight: Double, y: Double? = nil) {
        guard sparks.count < Self.sparkMax else { return }
        let edgeX = railWidth * shownLevel
        let fromWithin = y == nil && chaos > 0 && Double.random(in: 0..<1) < chaos * 0.25
        let angle = Double.random(in: -1...1) * (fromWithin ? .pi : Self.sparkSpread)
        let velocity = Self.sparkSpeed * Double.random(in: 0.5..<1.5) * (1 + hot * 0.5 + chaos * 0.7)
        sparks.append(Spark(
            x: fromWithin ? Double.random(in: 0..<max(1, edgeX)) : edgeX + Double.random(in: -2...2),
            y: y ?? Double(Self.overscanTop) + Double.random(in: 0..<max(1, railHeight)),
            vx: cos(angle) * velocity,
            vy: sin(angle) * velocity,
            life: Self.sparkLife * Double.random(in: 0.6..<1.1) * (1 + chaos * 0.4),
            size: !fromWithin && chaos > 0 && Double.random(in: 0..<1) < chaos * 0.2 ? 2 : 1
        ))
    }

    private func spawnBolt(railWidth: Double, rows: Int) {
        let edgeColumn = Int((railWidth * shownLevel) / Double(PixelField.cell))
        var row = Int.random(in: 0..<rows)
        let length = Int.random(in: Self.boltMinCells...Self.boltMaxCells)
        let backward = Bool.random() && Double.random(in: 0..<1) < 0.7
        var cells: [CGPoint] = []
        for step in 0..<length {
            let column = backward ? edgeColumn - step : edgeColumn + step
            cells.append(CGPoint(x: column * Int(PixelField.cell), y: Int(Self.overscanTop) + row * Int(PixelField.cell)))
            row += Int.random(in: -1...1)
        }
        bolts.append(Bolt(cells: cells, life: Self.boltLife))
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
    /// Position on the product-wide low→ultra scale. A model whose rail ends
    /// at Max still burns like Max at its right edge, rather than Ultra.
    private var heat: Double { PixelField.canonicalHeat(position: position, efforts: efforts) }
    private var selectedHeatRank: Int {
        ["low", "medium", "high", "xhigh", "max", "ultra"].firstIndex(of: selection.rawValue) ?? 0
    }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || selectedHeatRank < 4)) { timeline in
            let chrome = heatChrome(at: timeline.date.timeIntervalSinceReferenceDate)
            VStack(alignment: .leading, spacing: Spacing.snug) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Effort").typeStyle(.caption).foregroundStyle(Theme.muted)
                    Spacer()
                    Text(label(selection))
                        .typeStyle(.caption, weight: .medium)
                        .foregroundStyle(chrome.cursorColor)
                        .shadow(color: accent.color.opacity(chrome.labelGlow), radius: chrome.labelGlow * 12)
                        .offset(chrome.labelOffset)
                }
                rail(chrome: chrome)
                    .frame(height: 44)
                stops(chrome: chrome)
                    .frame(height: 24)
            }
        }
        .onAppear {
            position = Double(index)
            if sim == nil { sim = EffortFieldSim(level: fraction, heat: heat) }
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

    private func rail(chrome: HeatChrome) -> some View {
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
                    .fill(chrome.cursorColor)
                    .frame(width: 3, height: height + 6)
                    .shadow(color: accent.color.opacity(dragging ? 0.85 : chrome.cursorGlow), radius: dragging ? 9 : chrome.cursorRadius)
                    .offset(x: fraction * width - 1.5)
                    .animation(dragging ? nil : .easeOut(duration: 0.2), value: fraction)
            }
            .offset(chrome.railOffset)
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
                    sim.advance(to: timeline.date.timeIntervalSinceReferenceDate, level: fraction, heat: heat, railWidth: width, railHeight: height)
                } else {
                    sim.settle(level: fraction, heat: heat, rows: max(1, Int(ceil(height / PixelField.cell))))
                }
                let accentRGB = PixelField.RGB(accent.uiColor, in: scheme)
                let crestRGB = PixelField.RGB(accent.crestColor, in: scheme)
                let hotRGB = PixelField.RGB(scheme == .dark ? .white : Theme.inkColor, in: scheme)
                let fillWidth = size.width * sim.shownLevel
                guard fillWidth > 0.5 else { return }
                let cell = PixelField.cell
                let cols = Int(ceil(size.width / cell)), rows = Int(ceil(size.height / cell))
                let runnerDrive = PixelField.drive(sim.shownHeat, after: EffortFieldSim.runnerOn)
                let hotDrive = PixelField.drive(sim.shownHeat, after: EffortFieldSim.hotOn)
                let surgeDrive = PixelField.drive(sim.shownHeat, after: EffortFieldSim.surgeOn)
                let chaosDrive = PixelField.drive(sim.shownHeat, after: EffortFieldSim.chaosOn)
                let bright = EffortFieldSim.brightFloor + (1 - EffortFieldSim.brightFloor) * sim.shownHeat
                let edgeSpan = EffortFieldSim.edgeCells * Double(cell)
                for r in 0..<rows {
                    let shift = CGFloat(sim.tearShift[safe: r] ?? 0) * cell
                    for c in 0..<cols {
                        let x = CGFloat(c) * cell
                        if x >= fillWidth { break }
                        if chaosDrive > 0,
                           PixelField.hash(Double(c) * 1.3 + Double(sim.frame) * 0.37, Double(r) * 2.1 + Double(sim.frame) * 0.11) < chaosDrive * EffortFieldSim.dropoutChance {
                            continue
                        }
                        let w = PixelField.weight(col: c, row: r, scroll: sim.scroll)
                        let ramp = 0.2 + 0.8 * Double(x / fillWidth)
                        var intensity = ramp * (PixelField.floor + (1 - PixelField.floor) * w) * PixelField.jitter(col: c, row: r) * bright
                        if surgeDrive > 0 {
                            let wave = sin(Double(x) * EffortFieldSim.surgeWavelength - sim.surgePhase + Double(r) * 0.35)
                            intensity *= 1 + surgeDrive * EffortFieldSim.surgeDepth * wave
                        }
                        intensity = min(PixelField.intensityCap, intensity)
                        if intensity < 0.02 { continue }
                        var white = 0.0
                        if hotDrive > 0 {
                            let near = min(1, max(0, 1 - Double(fillWidth - x) / edgeSpan))
                            if near > 0 {
                                let flicker = 0.45 + 0.55 * PixelField.vnoise(Double(c) * 0.9 - sim.scroll * 3.2, Double(r) + 7.3)
                                white = EffortFieldSim.edgeWhite * hotDrive * near * near * flicker
                                intensity = min(1, intensity + white * 0.5)
                            }
                        }
                        if chaosDrive > 0,
                           PixelField.hash(Double(c) * 0.61 + Double(sim.frame) * 0.23, Double(r) * 1.7 + Double(sim.frame) * 0.41) < chaosDrive * EffortFieldSim.blowoutChance {
                            white = 0.8
                            intensity = 1
                        }
                        let rgb = PixelField.color(weight: w, accent: accentRGB, crest: crestRGB).mixed(toward: hotRGB, by: white)
                        context.fill(Path(CGRect(x: x + shift, y: CGFloat(r) * cell, width: cell - 1, height: cell - 1)), with: .color(rgb.color(alpha: intensity)))
                    }
                }

                for runner in sim.runners {
                    let y = CGFloat(runner.row) * cell
                    let shift = CGFloat(sim.tearShift[safe: runner.row] ?? 0) * cell
                    let headColumn = Int(floor(runner.x / Double(cell)))
                    for tail in 0..<EffortFieldSim.runnerTail {
                        let x = CGFloat(headColumn - tail) * cell
                        if x < 0 || x >= fillWidth { continue }
                        let fade = 1 - Double(tail) / Double(EffortFieldSim.runnerTail)
                        let color = crestRGB.mixed(toward: hotRGB, by: (0.45 + 0.4 * runnerDrive) * fade)
                        context.fill(Path(CGRect(x: x + shift, y: y, width: cell - 1, height: cell - 1)), with: .color(color.color(alpha: 0.95 * fade)))
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
                let hot = PixelField.RGB(scheme == .dark ? .white : Theme.inkColor, in: scheme)
                let hotDrive = PixelField.drive(sim.shownHeat, after: EffortFieldSim.hotOn)
                for s in sim.sparks {
                    let alpha = min(0.9, (s.life / EffortFieldSim.sparkLife) * 0.95)
                    let y = s.y - Double(EffortFieldSim.overscanTop)
                    let remaining = s.life / EffortFieldSim.sparkLife
                    let color = crest.mixed(toward: hot, by: hotDrive * min(1, max(0, remaining - 0.3)))
                    let side = s.size * Double(PixelField.cell) - 1
                    context.fill(Path(CGRect(x: s.x.rounded(), y: y.rounded(), width: side, height: side)), with: .color(color.color(alpha: alpha)))
                }
                for bolt in sim.bolts {
                    let alpha = 0.55 + 0.45 * bolt.life / EffortFieldSim.boltLife
                    let color = crest.mixed(toward: hot, by: 0.9)
                    for cell in bolt.cells {
                        context.fill(Path(CGRect(x: cell.x, y: cell.y - EffortFieldSim.overscanTop, width: PixelField.cell - 1, height: PixelField.cell - 1)), with: .color(color.color(alpha: alpha)))
                    }
                }
            }
            .frame(width: width + EffortFieldSim.overscanRight, height: height + EffortFieldSim.overscanTop + EffortFieldSim.overscanBottom)
            .allowsHitTesting(false)
        }
        .frame(width: width, height: height, alignment: .topLeading)
    }

    // MARK: - Stops

    private func stops(chrome: HeatChrome) -> some View {
        GeometryReader { proxy in
            ForEach(Array(efforts.enumerated()), id: \.offset) { stop, effort in
                let lit = stop <= index, active = stop == index
                let x = maxIndex == 0 ? 0 : CGFloat(stop) / CGFloat(maxIndex) * proxy.size.width
                VStack(spacing: 3) {
                    Rectangle()
                        .fill(active ? accent.color : (lit ? accent.color.opacity(0.7) : Theme.line))
                        .frame(width: 1, height: active ? 7 : 5)
                    Text(label(effort))
                        .typeStyle(.caption2, weight: active ? .medium : .regular)
                        .foregroundStyle(active ? chrome.cursorColor : (lit ? Theme.ink.opacity(0.75) : Theme.muted))
                        .shadow(color: active ? accent.color.opacity(chrome.labelGlow) : .clear, radius: chrome.labelGlow * 10)
                        .offset(active ? chrome.labelOffset : .zero)
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
        Haptics.selection()
        selection = effort
    }

    private struct HeatChrome {
        let cursorColor: Color
        let cursorGlow: Double
        let cursorRadius: CGFloat
        let railOffset: CGSize
        let labelOffset: CGSize
        let labelGlow: Double
    }

    private func heatChrome(at time: TimeInterval) -> HeatChrome {
        let hotInk = Color(scheme == .dark ? UIColor.white : Theme.inkColor)
        let isHigh = selectedHeatRank >= 2
        let isHot = selectedHeatRank >= 3
        let isMax = selectedHeatRank >= 4
        let isUltra = selectedHeatRank >= 5
        let cursorColor = isUltra ? accent.color.mix(with: hotInk, by: 0.65) : (isHot ? accent.color.mix(with: hotInk, by: 0.3) : accent.color)
        let pulse = isMax && !reduceMotion ? (sin(time * 2 * .pi / (isUltra ? 0.26 : 0.82)) + 1) / 2 : 0
        let railOffset: CGSize
        let labelOffset: CGSize
        if isUltra && !reduceMotion {
            let jolts: [CGSize] = [.zero, .init(width: -1, height: 1), .init(width: 1.5, height: -1), .init(width: -1.5, height: 0), .init(width: 1, height: 1), .init(width: 0, height: -1.5), .init(width: -1, height: -1), .init(width: 1.5, height: 0.5), .init(width: -0.5, height: 1.5), .init(width: 1, height: -0.5)]
            railOffset = jolts[Int(time / 0.024) % jolts.count]
            let glitch = time.truncatingRemainder(dividingBy: 1.3)
            labelOffset = (0.08..<0.14).contains(glitch) ? CGSize(width: glitch < 0.11 ? -1 : 1, height: 0) : ((0.83..<0.87).contains(glitch) ? CGSize(width: 1, height: -1) : .zero)
        } else {
            railOffset = .zero
            labelOffset = .zero
        }
        return HeatChrome(
            cursorColor: cursorColor,
            cursorGlow: isHigh ? 0.75 + 0.2 * pulse : 0.65,
            cursorRadius: isHigh ? 6 + 6 * pulse : 5,
            railOffset: railOffset,
            labelOffset: labelOffset,
            labelGlow: isMax ? 0.55 + 0.25 * pulse : 0
        )
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private extension Color {
    func mix(with other: Color, by amount: CGFloat) -> Color {
        Color(uiColor: Theme.blend(UIColor(self), toward: UIColor(other), amount))
    }
}
