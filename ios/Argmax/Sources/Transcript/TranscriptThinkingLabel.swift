import SwiftUI

/// A silent beat has a stable identity, so navigation never rerolls its verb.
struct TranscriptThinking: Hashable {
    let id: String
    let startedAt: String

    static func current(items: [TranscriptItem], session: NativeSession?) -> Self? {
        guard let session, session.state == .running, session.attention == .normal else { return nil }
        let turn = items.suffix(from: items.lastIndex(where: {
            if case .user(let message) = $0 { return !message.isSteering }
            return false
        }) ?? items.startIndex)
        for item in turn {
            switch item {
            case .tools(let group) where group.tools.contains(where: { $0.status == .running }): return nil
            case .agents(let group) where group.agents.contains(where: { $0.status == .running }): return nil
            case .question(let card) where card.isOutstanding: return nil
            case .plan(let card) where card.isOutstanding: return nil
            case .approval(let card) where card.status == .pending: return nil
            default: break
            }
        }
        for item in turn.reversed() {
            switch item {
            case .user(let message) where message.isSteering: continue
            case .notice, .todo, .multitask: continue
            case .thought: return nil
            case .assistant: return nil
            case .error: return nil
            case .tools(let group):
                return Self(id: item.id, startedAt: group.tools.compactMap(\.completedAt).max() ?? item.createdAt)
            default: return Self(id: item.id, startedAt: item.createdAt)
            }
        }
        return Self(id: session.sessionId, startedAt: "")
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

struct TranscriptThinkingLabel: View {
    let thinking: TranscriptThinking
    @State private var mountedAt = Date()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let start = parseWireTimestamp(thinking.startedAt) ?? mountedAt
            HStack(spacing: Spacing.snug) {
                WorkingNest(size: 16)
                Text(thinking.word)
                if context.date.timeIntervalSince(start) >= 3 {
                    let seconds = Int(context.date.timeIntervalSince(start))
                    Text(seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s")
                        .monospacedDigit()
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Thinking")
    }
}
