import SwiftUI

/// Live work marked on the words themselves: a soft band of ink, tinted with
/// the accent, reads the line glyph by glyph — line one, then line two — and
/// rests briefly between passes. It replaced the working nest in front of the
/// thinking cue and a running fold's headline; the mockups and the numbers'
/// history are in `docs/design/live-text-motion`.
///
/// The band's position comes from absolute time, not from when the view
/// appeared, so a headline swap, a dwell re-render or a chat switch never
/// restarts the pass. Speed and width are in ems, so Dynamic Type scales the
/// motion with the text.
struct ReadingWaveText: View {
    let text: Text
    let active: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accentTint) private var accent
    @Environment(\.self) private var environment
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .subheadline) private var em: CGFloat = 15

    var body: some View {
        if active {
            // The timeline wraps the leaf only: a per-frame tick above the
            // row relays out every row around it.
            TimelineView(.animation) { context in
                text
                    // The renderer multiplies each glyph by its colour, so
                    // the glyphs start white.
                    .foregroundStyle(.white)
                    .textRenderer(ReadingWave(
                        time: context.date.timeIntervalSinceReferenceDate,
                        em: em,
                        reduceMotion: reduceMotion,
                        rest: rest,
                        breath: Theme.mutedStrong.resolve(in: environment),
                        peak: ReadingWave.mix(
                            Theme.ink.resolve(in: environment),
                            accent.color.resolve(in: environment),
                            colorScheme == .dark ? ReadingWave.accentShare : ReadingWave.lightAccentShare
                        )
                    ))
            }
            .accessibilityValue("Running")
        } else {
            text
        }
    }

    /// A dark band on a mid-grey line barely registers on paper, so light
    /// mode rests the line toward the ground and lets the band carry the ink.
    private var rest: Color.Resolved {
        let muted = Theme.muted.resolve(in: environment)
        guard colorScheme == .light else { return muted }
        return ReadingWave.mix(muted, Theme.ground.resolve(in: environment), ReadingWave.lightRestFade)
    }
}

struct ReadingWave: TextRenderer {
    /// Gaussian width of the band, in ems.
    static let sigma: CGFloat = 1.1
    /// A pass over the words takes this long, whatever the line's length. The
    /// *time* is what is held constant, not the speed: a fold headline is a
    /// type step smaller than the thinking verb and two to three times longer,
    /// so one px/s read as two different animations on one screen — the verb
    /// felt right and the headline crawled.
    static let passSecondsMin: CGFloat = 0.8
    static let passSecondsMax: CGFloat = 1.5
    /// Pause between passes, in seconds.
    static let pause: CGFloat = 0.4
    /// How much of the peak is accent rather than ink.
    static let accentShare: Float = 0.4
    /// Light mode's peak stays nearer ink: the light accents are already dark.
    static let lightAccentShare: Float = 0.1
    /// How far light mode's resting line fades from muted toward the ground.
    static let lightRestFade: Float = 0.3
    /// Reduce Motion: nothing travels, the line breathes over this period.
    static let breathPeriod: Double = 2.6

    let time: TimeInterval
    let em: CGFloat
    let reduceMotion: Bool
    let rest: Color.Resolved
    let breath: Color.Resolved
    let peak: Color.Resolved

    // No `animatableData`: the fold animates its label on a 0.18s curve, and
    // an animatable renderer would ease the band's position along with it.

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        if reduceMotion {
            let phase = (1 - cos(time / Self.breathPeriod * 2 * .pi)) / 2
            let color = Color(Self.mix(rest, breath, Float(phase)))
            for line in layout {
                var lineContext = context
                lineContext.addFilter(.colorMultiply(color))
                lineContext.draw(line)
            }
            return
        }

        let sigma = Self.sigma * em
        // Reading order: a glyph's place is the width of the lines before it
        // plus its offset within its own line. The band enters 3σ before the
        // first glyph and leaves 3σ after the last.
        let pathLength = layout.reduce(0) { $0 + $1.typographicBounds.width }
        let travel = pathLength + 6 * sigma
        let pass = min(Self.passSecondsMax, max(Self.passSecondsMin, travel / (7 * em)))
        let speed = travel / pass
        let head = CGFloat(time).truncatingRemainder(dividingBy: pass + Self.pause) * speed - 3 * sigma

        var linesBefore: CGFloat = 0
        for line in layout {
            let lineStart = line.typographicBounds.rect.minX
            for run in line {
                for slice in run {
                    let offset = linesBefore + slice.typographicBounds.rect.midX - lineStart - head
                    let weight = exp(-(offset * offset) / (2 * sigma * sigma))
                    var sliceContext = context
                    sliceContext.addFilter(.colorMultiply(Color(Self.mix(rest, peak, Float(weight)))))
                    sliceContext.draw(slice)
                }
            }
            linesBefore += line.typographicBounds.width
        }
    }

    static func mix(_ from: Color.Resolved, _ to: Color.Resolved, _ amount: Float) -> Color.Resolved {
        Color.Resolved(
            red: from.red + (to.red - from.red) * amount,
            green: from.green + (to.green - from.green) * amount,
            blue: from.blue + (to.blue - from.blue) * amount,
            opacity: from.opacity + (to.opacity - from.opacity) * amount
        )
    }
}

extension Text {
    /// Marks the text as live work while `active`; plain text otherwise.
    func readingWave(_ active: Bool) -> ReadingWaveText {
        ReadingWaveText(text: self, active: active)
    }
}
