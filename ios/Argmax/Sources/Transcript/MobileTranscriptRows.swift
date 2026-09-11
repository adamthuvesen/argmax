import SwiftUI

/// Presentation groups preserve the underlying events and their inspection controls.
/// Minimal also folds pre-answer narration into the work it describes.
enum MobileTranscriptRow: Equatable, Identifiable {
    case item(TranscriptItem)
    case activity([TranscriptItem])
    case thinking(TranscriptThinking)

    var id: String {
        switch self {
        case .item(let item): return item.id
        case .thinking(let thinking): return "thinking-\(thinking.id)"
        case .activity(let items): return "mobile-activity-\(items[0].id)"
        }
    }

    /// Activity controls already reserve a 44-point tap target.
    var verticalPadding: CGFloat {
        switch self {
        case .activity: return 0
        case .thinking: return Spacing.snug
        case .item(let item):
            switch item {
            case .thought, .tools, .todo, .notice: return 0
            default: return Spacing.snug
            }
        }
    }

    static func rows(_ items: [TranscriptItem], detail: MobileChatDetail) -> [MobileTranscriptRow] {
        guard detail == .minimal || detail == .compact else { return items.map(Self.item) }
        var narration = Set<String>()
        if detail == .minimal {
            var laterWork = false
            var laterAnswer = false
            for item in items.reversed() {
                switch item {
                case .user:
                    laterWork = false
                    laterAnswer = false
                case .thought, .tools, .todo: laterWork = true
                case .assistant(let message):
                    if laterWork && laterAnswer && message.attachments.isEmpty { narration.insert(item.id) }
                    laterAnswer = true
                default: break
                }
            }
        }
        var result: [MobileTranscriptRow] = []
        var activity: [TranscriptItem] = []
        func flush() {
            if !activity.isEmpty { result.append(.activity(activity)); activity = [] }
        }
        for item in items {
            let fold: Bool
            switch item {
            case .thought, .todo, .tools: fold = true
            case .assistant: fold = narration.contains(item.id)
            default: fold = false
            }
            if fold { activity.append(item) }
            else { flush(); result.append(.item(item)) }
        }
        flush()
        return result
    }
}

struct MobileTranscriptRowView<Content: View>: View {
    let row: MobileTranscriptRow
    @ViewBuilder var content: (TranscriptItem) -> Content
    @State private var expanded = false
    @Environment(\.mobileChatDetail) private var detail

    var body: some View {
        rowContent.disclosureGroupStyle(TranscriptDisclosureStyle())
    }

    @ViewBuilder
    private var rowContent: some View {
        switch row {
        case .item(let item): content(item)
        case .thinking(let thinking): TranscriptThinkingLabel(thinking: thinking).id(thinking)
        case .activity(let items):
            DisclosureGroup(isExpanded: $expanded) {
                // Unfolded work used to sit flush with the answers around it,
                // so a nested "Thought process" read as a sibling of the reply
                // above it. One rule down the left says where the fold ends.
                HStack(alignment: .top, spacing: Spacing.row + Spacing.hair) {
                    Theme.line.frame(width: 2)
                    // Folded rows keep the rhythm of the list they came out
                    // of: an activity row reserves its own height, and
                    // stacking a gap on top of it opened a hole.
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(items) { item in
                            content(item)
                                .padding(.vertical, MobileTranscriptRow.item(item).verticalPadding)
                                .environment(\.activityToolsAreRevealed, true)
                                .environment(\.foldedNarration, true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // SwiftUI resets a custom style for the groups a style's
                    // own body renders, so the thinking inside this fold drew
                    // the system chevron — heavier and brighter than the one
                    // that opened it. Asking for the style again restores it.
                    .disclosureGroupStyle(TranscriptDisclosureStyle())
                }
                .padding(.top, Spacing.snug)
                .padding(.bottom, Spacing.tight)
            } label: {
                HStack(spacing: Spacing.snug) {
                    if tools(in: items).contains(where: { $0.status == .running }) {
                        WorkingNest(size: 16)
                    }
                    ForEach(iconTools(in: items)) { tool in
                        TranscriptToolIcon(name: tool.name, activity: tool.activity)
                    }
                    Text(summary(items)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .typeStyle(.footnote)
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .tint(Theme.muted)
            .onChange(of: detail) { expanded = false }
        }
    }

    private func tools(in items: [TranscriptItem]) -> [TranscriptTool] {
        items.flatMap { item in
            if case .tools(let group) = item { return group.tools }
            return []
        }
    }

    private func iconTools(in items: [TranscriptItem]) -> [TranscriptTool] {
        var seen = Set<String>()
        return Array(tools(in: items).filter { tool in
            let identity = TranscriptToolIcon.assetName(for: tool.name, activity: tool.activity)
                ?? "activity:\(tool.activity.kind.rawValue)"
            return seen.insert(identity).inserted
        }.prefix(detail == .minimal ? 1 : 3))
    }

    private func summary(_ items: [TranscriptItem]) -> String {
        let tools = tools(in: items)
        if tools.isEmpty { return "Thought process and activity" }
        return TranscriptToolActivity.summary(for: tools).headline
    }
}

private struct ActivityToolsAreRevealedKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var activityToolsAreRevealed: Bool {
        get { self[ActivityToolsAreRevealedKey.self] }
        set { self[ActivityToolsAreRevealedKey.self] = newValue }
    }
}

/// Keep the whole row tappable without the system disclosure's extra insets.
///
/// A group headline keeps its chevron: it is sometimes a turn's only
/// control. The rows inside a fold drop it — every line wearing one read as
/// a column of controls — and sit at the ledger's own height.
struct TranscriptDisclosureStyle: DisclosureGroupStyle {
    var chevron = true
    var minHeight: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: Spacing.snug) {
                    configuration.label
                    if chevron {
                        Spacer(minLength: 0)
                        Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                            .typeSymbol(.caption, weight: .semibold)
                            .foregroundStyle(Theme.muted)
                            .accessibilityHidden(true)
                    }
                }
                .frame(minHeight: minHeight)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded { configuration.content }
        }
    }
}
