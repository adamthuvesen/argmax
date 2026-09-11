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
            case .thought, .todo: fold = true
            case .tools(let group): fold = !group.tools.contains { $0.status == .failed }
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
                VStack(alignment: .leading, spacing: Spacing.snug) {
                    ForEach(items) { item in content(item) }
                }
                .padding(.top, Spacing.snug)
            } label: {
                HStack(spacing: Spacing.snug) {
                    if tools(in: items).contains(where: { $0.status == .running }) {
                        WorkingNest(size: 16)
                    }
                    ForEach(iconTools(in: items)) { tool in TranscriptToolIcon(name: tool.name) }
                    Text(summary(items)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .font(.footnote)
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
            guard let asset = TranscriptToolIcon.assetName(for: tool.name) else { return false }
            return seen.insert(asset).inserted
        }.prefix(detail == .minimal ? 1 : 3))
    }

    private func summary(_ items: [TranscriptItem]) -> String {
        let tools = tools(in: items)
        let running = tools.contains { $0.status == .running }
        if tools.isEmpty { return "Thought process and activity" }
        return "\(running ? "Working" : "Activity") · \(tools.count) action\(tools.count == 1 ? "" : "s")"
    }
}

/// Keep the whole row tappable without the system disclosure's extra insets.
private struct TranscriptDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                configuration.isExpanded.toggle()
            } label: {
                HStack(spacing: Spacing.snug) {
                    configuration.label
                    Spacer(minLength: 0)
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.muted)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "Expanded" : "Collapsed")
            if configuration.isExpanded { configuration.content }
        }
    }
}
