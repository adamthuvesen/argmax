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
    /// Where this text starts, in points, relative to the line's first word.
    /// A row marks its verb and its target with two of these so both keep
    /// their own resting colour, and the two offsets make them one pass
    /// rather than two — the desktop does the same per span
    /// (`--reading-wave-offset`, `reading-wave.css`).
    var offset: CGFloat = 0
    /// The whole line's travel, when the line is more than this one word run:
    /// the pass is timed over every part's words together, so each part sees
    /// the same cycle. Nil sizes the pass from this text alone, which is the
    /// single-part case and the one every earlier caller has.
    var sharedTravel: CGFloat? = nil
    /// The ink this part rests at while the band is elsewhere. Nil keeps the
    /// shared muted line, which is every whole-line caller's colour; a row
    /// whose parts carry different inks hands each part its own, so the band
    /// lifts from where that part actually sits rather than repainting it.
    var restInk: Color? = nil

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
                        ),
                        offset: offset,
                        sharedTravel: sharedTravel
                    ))
            }
            .accessibilityValue("Running")
        } else {
            text
        }
    }

    /// The ink the line rests at while the band is elsewhere: its own colour
    /// by default, faded toward the ground on paper, where a dark band on a
    /// mid-grey line barely registers and the band must carry the ink.
    private var rest: Color.Resolved {
        let ink = (restInk ?? Theme.muted).resolve(in: environment)
        guard colorScheme == .light else { return ink }
        return ReadingWave.mix(ink, Theme.ground.resolve(in: environment), ReadingWave.lightRestFade)
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
    /// Where this text's words start, relative to the line's first word —
    /// how far the band has already read before it arrives here. Zero for a
    /// line that is one word run.
    var offset: CGFloat = 0
    /// The line's full travel, when the line carries more than this text:
    /// the pass, and so the band's speed and its rest, are timed over every
    /// part's words as one line. Nil travels this text alone.
    var sharedTravel: CGFloat? = nil

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
        // first glyph and leaves 3σ after the last — measured over the whole
        // line's words when the line has several parts, so a verb and its
        // target read as one pass and not two.
        let travel = sharedTravel
            ?? layout.reduce(0) { $0 + $1.typographicBounds.width } + 6 * sigma
        let pass = min(Self.passSecondsMax, max(Self.passSecondsMin, travel / (7 * em)))
        let speed = travel / pass
        let head = CGFloat(time).truncatingRemainder(dividingBy: pass + Self.pause) * speed - 3 * sigma

        var linesBefore: CGFloat = 0
        for line in layout {
            let lineStart = line.typographicBounds.rect.minX
            for run in line {
                for slice in run {
                    let offset = linesBefore + slice.typographicBounds.rect.midX - lineStart
                        + self.offset - head
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
    /// Marks the text as live work while `active`; plain text otherwise. A
    /// line drawn from several word runs passes `offset` and `sharedTravel`
    /// so the parts read as one pass, and `restInk` when its parts keep
    /// different resting colours.
    func readingWave(
        _ active: Bool,
        offset: CGFloat = 0,
        sharedTravel: CGFloat? = nil,
        restInk: Color? = nil
    ) -> ReadingWaveText {
        ReadingWaveText(
            text: self, active: active, offset: offset,
            sharedTravel: sharedTravel, restInk: restInk
        )
    }
}
