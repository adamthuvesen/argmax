import SwiftUI

/// What a silent beat has to outlast before it is worth a word, and how the
/// line arrives and leaves. The numbers are the desktop's
/// (`SessionConversation.tsx` and `chat-turns.css`), so the two surfaces read
/// the same; the rules and the measurements behind them are in
/// `docs/design/live-activity-timing`.
enum TranscriptThinkingWait {
    /// The pre-answer floor. A provider that says its first word inside this
    /// window has announced itself better than the cue could, and a line that
    /// appeared and left again inside it read as a flash rather than as a sign
    /// of life. Longer than this and the pane is silent through the one
    /// stretch that needs a cue: a relaunched provider takes ten to thirty
    /// seconds to answer.
    static let firstBeat: TimeInterval = 0.6
    /// What a mid-turn gap serves until the turn has shown a rhythm of its own.
    static let unmeasuredGap: TimeInterval = 1.0
    /// … and once it has: a fraction of the turn's own median gap, so a turn
    /// whose calls land a second apart never shows a word between two of them,
    /// while a turn that genuinely stalls still does. The clamp keeps a burst
    /// of same-millisecond calls from driving the threshold to nothing, and a
    /// single long stall from raising it past the point of usefulness.
    static let medianFactor: Double = 0.8
    static let shortestGap: TimeInterval = 0.9
    static let longestGap: TimeInterval = 2.5
    /// The line fades in whenever it arrives, and fades out only when a tool
    /// line takes the beat off it — a hand-off between two lines of the same
    /// pitch. Answer text and a settled turn cut instead: they are the frame
    /// the reader has been waiting for, and a dissolve there would put a fade
    /// on exactly that frame.
    static let fadeIn: TimeInterval = 0.16
    static let fadeOut: TimeInterval = 0.14

    /// The wait a mid-turn gap has to serve, given the gaps the turn has
    /// already shown. The median rather than the mean: real turns land four to
    /// six calls in the same millisecond and then go quiet for ten seconds, and
    /// an average would let the burst drag the threshold under every real pause
    /// in the same turn.
    static func gap(measuring gaps: [TimeInterval]) -> TimeInterval {
        guard !gaps.isEmpty else { return unmeasuredGap }
        let sorted = gaps.sorted()
        return min(longestGap, max(shortestGap, sorted[sorted.count / 2] * medianFactor))
    }
}

/// A silent beat has a stable identity, so navigation never rerolls its verb.
struct TranscriptThinking: Hashable {
    /// Live, or dissolving because a tool line took the beat. A leaving line is
    /// pixels for the length of the fade and nothing more: it has already lost
    /// the beat, so it announces nothing.
    enum Phase: Hashable {
        case live
        case leaving
    }

    let id: String
    let startedAt: String
    var phase: Phase = .live
    /// How long this beat has to stay silent before the cue earns the screen.
    var wait: TimeInterval = TranscriptThinkingWait.firstBeat
    /// The line whose work this beat started at, when a line of work started
    /// it: the fold whose last call just landed. Nil for a turn's first beat,
    /// whose only predecessor is the prompt, and for a card, which is not work
    /// the reader can watch a line do.
    var settledLine: String? = nil

    /// A beat is identified by what it is, not by what it is doing: the phase
    /// and the wait stay out of equality so a hand-off, or a wait recomputed
    /// from a longer rhythm, leaves `NativeTranscriptView`'s `.id(thinking)`
    /// alone. Remounting there would hand the dissolving line a fresh word and
    /// restart its clock in the middle of the dissolve.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.startedAt == rhs.startedAt
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(startedAt)
    }

    /// What is left of this beat's wait. A beat with no clock to count from — a
    /// running session whose transcript is still empty — has nothing to smooth,
    /// so it shows at once; serving the wait there is what left a reopened chat
    /// blank. Never longer than the wait itself, so a clock stepped backwards
    /// cannot park the line forever.
    func remainingWait(now: Date = Date()) -> TimeInterval {
        guard let start = parseWireTimestamp(startedAt) else { return 0 }
        return min(wait, max(0, wait - now.timeIntervalSince(start)))
    }

    /// The line that holds the beat while this one waits, if any: the one that
    /// just did the work.
    ///
    /// Providers disagree by orders of magnitude about how long a call *looks*
    /// like it takes. Median `command.started` to `command.completed` over a
    /// week of this app's own event log: OpenCode 0ms, Grok 4ms, Codex 54ms,
    /// Cursor 252ms, Claude 610ms. Three of the five report a call atomically,
    /// so marking only a *running* line live left their tool lines with no
    /// wave at all and the cue owning every gap — which is what an OpenCode
    /// turn looked like here. So the settled line keeps the beat until this
    /// wait elapses and the cue takes over; exactly one line is live either
    /// way, on every provider.
    func beatHolder(now: Date = Date()) -> String? {
        // A running line waves on its own status, and a leaving cue has
        // already handed the beat to it.
        guard phase == .live, remainingWait(now: now) > 0 else { return nil }
        return settledLine
    }

    static func current(items: [TranscriptItem], session: NativeSession?) -> Self? {
        guard let session, session.state == .running, session.attention == .normal else { return nil }
        let turn = items.suffix(from: items.lastIndex(where: {
            if case .user(let message) = $0 { return !message.isSteering }
            return false
        }) ?? items.startIndex)
        for item in turn {
            switch item {
            case .question(let card) where card.isOutstanding: return nil
            case .approval(let card) where card.status == .pending: return nil
            default: break
            }
        }
        guard var beat = settledBeat(in: turn,
                                     gapWait: TranscriptThinkingWait.gap(measuring: gaps(in: turn)),
                                     fallbackID: session.sessionId)
        else { return nil }
        // One live line at a time: a tool line owns the beat from the frame it
        // starts, and the cue goes down with it. It only dissolves if it was up
        // to lose — a gap too short to have earned a word shows none on its way
        // out either.
        let live = liveLine(in: turn)
        if live.running {
            guard let handOff = live.startedAt,
                  let start = parseWireTimestamp(beat.startedAt),
                  handOff.timeIntervalSince(start) >= beat.wait
            else { return nil }
            beat.phase = .leaving
        }
        return beat
    }

    /// Where the silence started: the last thing in the turn that finished.
    /// Live content — an answer, reasoning, an error — is a progress cue of its
    /// own and ends the beat outright.
    ///
    /// `gapWait` is read only by a beat that is actually a mid-turn gap: the
    /// timestamp parsing behind it is wasted work on the renders that matter
    /// most, since a turn streaming an answer has no beat at all.
    private static func settledBeat(
        in turn: ArraySlice<TranscriptItem>,
        gapWait: @autoclosure () -> TimeInterval,
        fallbackID: String
    ) -> Self? {
        for item in turn.reversed() {
            switch item {
            case .user(let message) where message.isSteering: continue
            case .notice, .todo, .multitask: continue
            case .thought, .assistant, .error: return nil
            case .user:
                // Nothing has come back yet, so this is the turn's first beat
                // and serves the floor rather than the turn's rhythm.
                return Self(id: item.id, startedAt: item.createdAt,
                            wait: TranscriptThinkingWait.firstBeat)
            case .tools(let group):
                // A group with nothing finished in it has not started a
                // silence; the beat belongs to whatever ran before it.
                guard let settled = group.tools.compactMap(\.completedAt).max() else { continue }
                return Self(id: item.id, startedAt: settled, wait: gapWait(),
                            settledLine: item.id)
            case .agents(let group):
                guard let settled = group.agents.compactMap(\.completedAt).max() else { continue }
                return Self(id: item.id, startedAt: settled, wait: gapWait(),
                            settledLine: item.id)
            default:
                return Self(id: item.id, startedAt: item.createdAt, wait: gapWait())
            }
        }
        return Self(id: fallbackID, startedAt: "", wait: TranscriptThinkingWait.firstBeat)
    }

    /// The line that owns the beat right now, if one does, and when it took
    /// over. A start that does not parse still counts as a live line: the cue
    /// must never sit on top of a running row, whatever that row's clock says.
    /// A backgrounded launch is the one running row that does not count: it
    /// is marked running by inference rather than by evidence
    /// (`TranscriptAgent.backgroundLaunch`), the same rule the desktop
    /// applies to its `backgroundLaunch` rows, and a turn that only launched
    /// one of those is silent, not busy.
    private static func liveLine(in turn: ArraySlice<TranscriptItem>) -> (running: Bool, startedAt: Date?) {
        var running = false
        var earliest: Date?
        for item in turn {
            let starts: [String]
            switch item {
            case .tools(let group): starts = group.tools.filter { $0.status == .running }.map(\.createdAt)
            case .agents(let group):
                starts = group.agents.filter { $0.status == .running && !$0.backgroundLaunch }.map(\.createdAt)
            default: continue
            }
            if starts.isEmpty { continue }
            running = true
            for start in starts.compactMap(parseWireTimestamp) {
                if let earliest, earliest <= start { continue }
                earliest = start
            }
        }
        return (running, earliest)
    }

    /// The rhythm the turn has shown so far: the gap between each pair of
    /// consecutive things that happened in it. A call's start and its
    /// completion both count, since a fold of six calls is six beats of work
    /// inside one row. Only positive gaps: a burst lands several calls on the
    /// same millisecond, and a zero would pull the median under every real
    /// pause in the turn.
    private static func gaps(in turn: ArraySlice<TranscriptItem>) -> [TimeInterval] {
        var stamps: [String] = []
        for item in turn {
            switch item {
            case .tools(let group):
                for tool in group.tools {
                    stamps.append(tool.createdAt)
                    if let completedAt = tool.completedAt { stamps.append(completedAt) }
                }
            case .agents(let group):
                for agent in group.agents {
                    stamps.append(agent.createdAt)
                    if let completedAt = agent.completedAt { stamps.append(completedAt) }
                }
            default:
                stamps.append(item.createdAt)
            }
        }
        let marks = stamps.compactMap(parseWireTimestamp).sorted()
        return zip(marks.dropFirst(), marks).map { $0.timeIntervalSince($1) }.filter { $0 > 0 }
    }

    var word: String {
        // FNV-1a matches the desktop's seeded selection, including its rare draws.
        let hash = (id + ":" + startedAt).utf16.reduce(UInt32(0x811c9dc5)) {
            ($0 ^ UInt32($1)) &* 0x01000193
        }
        if hash % 100 < 6 { return "Argmaxing" }
        if hash % 100 < 8 {
            let eggs = ["Yak-shaving", "Tail-chasing", "Overthinking", "Gradient-descending"]
            return eggs[Int(hash / 100) % eggs.count]
        }
        return Self.words[Int(hash) % Self.words.count]
    }

    // Same regular vocabulary as desktop ThinkingLabel.tsx.
    private static let words = [
        "Brainstorming", "Disentangling", "Sanity-checking", "Theorizing", "Deciphering",
        "Synthesizing", "Deconstructing", "Distilling", "Reconciling", "Refining",
        "Calculating", "Thinking", "Computing", "Analyzing", "Philosophizing", "Reasoning",
        "Deducing", "Inferring", "Extrapolating", "Hypothesizing", "Deliberating",
        "Contemplating", "Dissecting", "Unpacking", "Parsing", "Triangulating",
        "Cross-referencing", "Correlating", "Diagnosing", "Investigating", "Excavating",
        "Spelunking", "Retracing", "Surveying", "Sleuthing", "Formulating", "Composing",
        "Drafting", "Assembling", "Consolidating", "Architecting", "Scrutinizing",
        "Second-guessing", "Stress-testing", "Interrogating", "Falsifying", "Auditing",
        "Verifying", "Optimizing", "Converging", "Approximating", "Quantifying",
        "Simulating", "Enumerating", "Backpropagating", "Condensing", "Sharpening",
        "Tightening", "Weighing", "Prioritizing"
    ]
}

/// Which line holds the turn's beat: the transcript item whose work just
/// landed, or nil when the thinking cue has it and nothing else may wave.
/// `TranscriptThinking.beatHolder` decides it and `TranscriptThinkingLabel`
/// publishes it, since the cue's own clock is what ends the line's turn.
/// Desktop threads the same value through `lib/activityBeat.ts`.
private struct ActivityBeatKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

extension EnvironmentValues {
    var activityBeat: String? {
        get { self[ActivityBeatKey.self] }
        set { self[ActivityBeatKey.self] = newValue }
    }
}

struct TranscriptThinkingLabel: View {
    /// Nil holds the line's height without drawing it. The cue comes and goes
    /// several times within a turn, and collapsing its slot each time shortens
    /// the transcript under a reader pinned to the tail and walks the view up
    /// and down. Desktop reserves the same slot in `.conversation-tail`.
    let thinking: TranscriptThinking?
    /// The line that keeps the beat while this one waits out its gap, reported
    /// up because this view's clock is what ends that wait: the frame the cue
    /// appears is the frame the line it took over from goes quiet.
    @Binding var beatHolder: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var mountedAt = Date()
    /// Whether the line is on screen, which outlives the beat by the length of
    /// the fade out: an element has to survive the state that put it up or
    /// there are no frames left to dissolve in.
    @State private var drawn = false
    @State private var opacity: Double = 0

    var body: some View {
        Group {
            if let thinking, drawn {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let start = parseWireTimestamp(thinking.startedAt) ?? mountedAt
                    line(word: thinking.word, elapsed: context.date.timeIntervalSince(start), live: true)
                }
                .opacity(opacity)
            } else {
                line(word: "Thinking", elapsed: 0, live: false).hidden()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking")
        // A line on its way out has already handed the beat over, so a reader
        // on assistive tech hears the arriving line instead of both.
        .accessibilityHidden(!drawn || thinking?.phase != .live)
        // Keyed on the beat, which is stable across a hand-off: the wait is
        // served once per beat, not once per phase.
        .task(id: thinking) { await serveWait() }
        .task(id: thinking?.phase) { await handOff() }
    }

    /// The cue waits before it appears. A gap that a turn's own rhythm makes
    /// ordinary is a pause in the work rather than a stall worth a word, and
    /// popping a verb on screen for half a second between two calls a second
    /// apart is what read as a flash.
    private func serveWait() async {
        guard let thinking, thinking.phase == .live else {
            // Answer text and a settled turn cut. A beat that arrives already
            // leaving — a chat opened mid-hand-off — was never on screen to
            // dissolve, so it stays down.
            drawn = false
            opacity = 0
            beatHolder = nil
            return
        }
        let remaining = thinking.remainingWait()
        if remaining > 0 {
            // The slot goes quiet for the wait: a word from the previous beat
            // must not stand in for one that has not earned the screen yet.
            drawn = false
            opacity = 0
            beatHolder = thinking.beatHolder()
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled else { return }
        }
        // The word is earned, so the line that just worked gives the beat up.
        beatHolder = nil
        opacity = reduceMotion ? 1 : 0
        drawn = true
        guard !reduceMotion else { return }
        withAnimation(.easeOut(duration: TranscriptThinkingWait.fadeIn)) { opacity = 1 }
    }

    /// A tool line taking the beat is a hand-off between two lines of the same
    /// pitch, so this one dissolves into the one arriving. Cutting it left the
    /// word blinking between calls that land a second apart.
    private func handOff() async {
        guard thinking?.phase == .leaving, drawn else { return }
        guard !reduceMotion else {
            // With no animation the line would sit at full opacity for the
            // whole fade, which is the flash the fade is there to avoid.
            drawn = false
            opacity = 0
            return
        }
        withAnimation(.easeInOut(duration: TranscriptThinkingWait.fadeOut)) { opacity = 0 }
        try? await Task.sleep(for: .seconds(TranscriptThinkingWait.fadeOut))
        guard !Task.isCancelled else { return }
        drawn = false
    }

    private func line(word: String, elapsed: TimeInterval, live: Bool) -> some View {
        HStack(spacing: Spacing.snug) {
            // The words carry the motion; the seconds stay still, since a
            // band crossing a ticking number jitters.
            Text(word).readingWave(live)
            if elapsed >= 3 {
                let seconds = Int(elapsed)
                Text(seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s")
                    .monospacedDigit()
            }
        }
        .typeSubtitle()
        .foregroundStyle(Theme.muted)
    }
}
