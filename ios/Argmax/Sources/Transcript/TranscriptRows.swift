import SwiftUI

struct TranscriptMessageRow: View {
    let message: TranscriptMessage
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    @EnvironmentObject private var appearance: Appearance
    @Environment(\.accentTint) private var accent
    @ScaledMetric(relativeTo: .body) private var previewHeight = 6 * 1.68 * 17.0
    @State private var contentHeight: CGFloat = 0
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if !message.attachments.isEmpty {
                TranscriptAttachmentStrip(attachments: message.attachments, client: client,
                                          onOpenFile: onOpenFile)
            }
            if hasMessageCopy {
                VStack(alignment: .leading, spacing: 0) {
                    if message.role == .user {
                        messageContent
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                                contentHeight = $0
                            }
                            .frame(maxHeight: expanded ? nil : previewHeight, alignment: .top)
                            .mask {
                                if contentHeight > previewHeight + 1 && !expanded {
                                    VStack(spacing: 0) {
                                        Rectangle()
                                        LinearGradient(colors: [.black, .clear],
                                                       startPoint: .top, endPoint: .bottom)
                                            .frame(height: 26)
                                    }
                                } else {
                                    Rectangle()
                                }
                            }
                        if contentHeight > previewHeight + 1 {
                            Button {
                                expanded.toggle()
                            } label: {
                                HStack(spacing: Spacing.tight) {
                                    Text(expanded ? "Show less" : "Show more").typeStyle(.footnote)
                                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                        .typeSymbol(.caption)
                                }
                                .frame(minHeight: 44)
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.muted)
                            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                        }
                    } else {
                        messageContent
                    }
                }
                .padding(message.role == .user ? Spacing.row : 0)
                .background {
                    if message.role == .user {
                        RoundedRectangle(cornerRadius: Radius.card)
                            .fill(appearance.accentBubbles ? accent.color.opacity(0.12) : Theme.raised)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, message.role == .user ? 24 : 0)
        .contextMenu {
            Button("Copy message", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = message.text
            }
            ShareLink(item: message.text)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "Your message" : "Assistant message")
    }

    private var messageContent: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if message.isSteering {
                Label {
                    Text("Sent during the turn").typeStyle(.footnote)
                } icon: {
                    Image(systemName: "arrow.turn.down.right").typeSymbol(.caption)
                }
                    .foregroundStyle(Theme.muted)
            }
            if !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                TranscriptMarkdown(text: message.text, client: client, onOpenFile: onOpenFile)
            }
            if let origin = message.originLabel {
                Text(origin).typeStyle(.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    private var hasMessageCopy: Bool {
        !message.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            message.isSteering || message.originLabel != nil
    }
}

struct TranscriptThoughtRow: View {
    let thought: TranscriptThought
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    @Environment(\.mobileChatDetail) private var detail
    @State private var showFullThought = false

    var body: some View {
        if detail == .balanced || detail == .detailed {
            VStack(alignment: .leading, spacing: Spacing.tight) {
                TranscriptMarkdown(text: visibleText, client: client, onOpenFile: onOpenFile, isThinking: true)
                if thought.text.count > previewLength {
                    Button(showFullThought ? "Show less thinking" : "Show more thinking") {
                        showFullThought.toggle()
                    }
                    .typeStyle(.footnote)
                    .frame(minHeight: 44)
                }
            }
        } else {
        DisclosureGroup {
            TranscriptMarkdown(text: thought.text, client: client, onOpenFile: onOpenFile, isThinking: true)
                .padding(.top, Spacing.tight)
                .padding(.bottom, Spacing.snug)
                .padding(.leading, TranscriptActivityRow<EmptyView>.targetInset)
        } label: {
            // The row names itself from the reasoning's first line — a model
            // titles each burst ("Checking deletion history") — so nine rows
            // in a fold are nine different things rather than nine copies of
            // "Thought process".
            TranscriptActivityRow(
                verb: thought.isStreaming ? "Thinking" : "Thought",
                target: thought.isStreaming ? nil : TranscriptThought.title(of: thought.text)
            ) {
                Image(systemName: "circle.dashed")
                    .typeSymbol(size: 14)
                    .foregroundStyle(Theme.muted)
                    .frame(width: 16, height: 16)
            }
        }
        .disclosureGroupStyle(TranscriptDisclosureStyle(chevron: false, minHeight: TranscriptActivityRow<EmptyView>.height))
        .tint(Theme.muted)
        }
    }

    private var previewLength: Int { detail == .detailed ? 800 : 400 }
    private var visibleText: String {
        showFullThought || thought.text.count <= previewLength
            ? thought.text : String(thought.text.prefix(previewLength)) + "…"
    }
}

struct TranscriptToolsRow: View {
    let group: TranscriptToolGroup
    let onOpenFile: (String) -> Void
    var onOpenDiff: ((String) -> Void)? = nil
    @Environment(\.mobileChatDetail) private var detail
    @Environment(\.activityToolsAreRevealed) private var activityToolsAreRevealed

    private var running: Bool { group.tools.contains { $0.status == .running } }

    var body: some View {
        // A row reserves its own height, so the rows stack without a gap.
        if detail == .detailed || activityToolsAreRevealed {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(group.tools) { tool in
                    TranscriptToolRow(tool: tool, onOpenFile: onOpenFile, onOpenDiff: onOpenDiff)
                }
            }
        } else {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(group.tools) { tool in
                    TranscriptToolRow(tool: tool, onOpenFile: onOpenFile, onOpenDiff: onOpenDiff)
                }
            }
        } label: {
            // A failed call is not news on its own: the agent reads the error
            // and tries again in the next call, so counting failures here
            // marked a recovered turn as a broken one. The failure lives in
            // the row's expanded body, where the reader has asked for it.
            TranscriptFoldLabel(tools: group.tools, summary: group.activitySummary,
                                running: running, maxIcons: 3, lineLimit: 2)
        }
        .tint(Theme.muted)
        }
    }
}

/// The collapsed line of a fold: the running mark, up to a few tool icons,
/// and the headline. Each piece changes on its own clock while a turn
/// works, so the label owns the pacing: the headline dwells long enough
/// that a boundary's intermediate wording never paints, the mark keys on
/// the live tail rather than the in-flight call, and what does change
/// fades rather than snapping.
struct TranscriptFoldLabel: View {
    let tools: [TranscriptTool]
    let summary: String
    /// A call in flight in this fold. Kept alongside the tail signal so a
    /// long call above the tail (an agent) still shows as running.
    let running: Bool
    let maxIcons: Int
    let lineLimit: Int
    @Environment(\.transcriptTailIsLive) private var tailIsLive
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var live: Bool { running || tailIsLive }
    private var motion: Animation? { reduceMotion ? nil : .easeOut(duration: 0.18) }

    var body: some View {
        TranscriptDwelledValue(value: Shown(summary: summary, live: live, icons: iconTools)) { shown in
            HStack(spacing: Spacing.snug) {
                if shown.live {
                    WorkingNest(size: 16).transition(.opacity)
                }
                ForEach(shown.icons) { tool in
                    TranscriptToolIcon(name: tool.name, activity: tool.activity)
                        .transition(.opacity)
                }
                Text(shown.summary)
                    .lineLimit(lineLimit)
                    .contentTransition(.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .geometryGroup()
            .animation(motion, value: shown)
        }
        .typeStyle(.footnote)
        .foregroundStyle(Theme.muted)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private struct Shown: Equatable {
        var summary: String
        var live: Bool
        var icons: [TranscriptTool]
    }

    private var iconTools: [TranscriptTool] {
        var seen = Set<String>()
        return Array(tools.filter { tool in
            let identity = TranscriptToolIcon.assetName(for: tool.name, activity: tool.activity)
                ?? "activity:\(tool.activity.kind.rawValue)"
            return seen.insert(identity).inserted
        }.prefix(maxIcons))
    }
}

/// One line of the activity ledger: `icon · verb · target`, the desktop's
/// grammar (`docs/chat-cards.md`, "Activity Rows") on the phone. The verb
/// sits a token step above the target; a command's target is mono one type
/// step down, since Geist Mono reads larger than sans at the same nominal
/// size. No fill and no chevron — the fold's rail says where the work is,
/// and a filled card per call read as a stack of cards inside a card.
struct TranscriptActivityRow<Icon: View>: View {
    static var height: CGFloat { 36 }
    /// Where a row's target starts: icon plus the gap, so an opened row's
    /// block and a thought's reasoning line up under the words.
    static var targetInset: CGFloat { 16 + Spacing.snug + Spacing.hair }

    let verb: String?
    let target: String?
    var mono = false
    var changeCounts: TranscriptChangeCounts? = nil
    var showsNavigation = false
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.snug + Spacing.hair) {
            icon()
            if let verb {
                Text(verb)
                    .typeStyle(.footnote)
                    .foregroundStyle(Theme.mutedStrong)
                    .fixedSize()
            }
            if let target {
                Text(target)
                    .typeStyle(mono ? .caption : .footnote, mono: mono)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if let changeCounts {
                ChangeCount(
                    additions: changeCounts.additions,
                    deletions: changeCounts.deletions
                )
                .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
            if showsNavigation {
                Image(systemName: "chevron.right")
                    .typeSymbol(.caption, weight: .semibold)
                    .foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: Self.height)
        .contentShape(.rect)
        // iOS joins sibling texts with ", ", which reads "Edited, App.swift".
        // One label keeps the verb and target one spoken phrase.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var label = [verb, target].compactMap { $0 }.joined(separator: " ")
        if let changeCounts {
            label += ", \(changeCounts.additions) added, \(changeCounts.deletions) removed"
        }
        return label
    }
}

private struct TranscriptToolRow: View {
    let tool: TranscriptTool
    let onOpenFile: (String) -> Void
    let onOpenDiff: ((String) -> Void)?

    private var isCommand: Bool { tool.activity.kind == .command }

    @ViewBuilder
    var body: some View {
        if let diffPath = tool.diffPath, let onOpenDiff {
            Button {
                Haptics.light()
                onOpenDiff(diffPath)
            } label: {
                rowLabel(showsNavigation: true)
            }
            .buttonStyle(PressDim())
            .accessibilityHint("Opens this file's diff")
        } else {
            DisclosureGroup {
                block
                    .padding(.leading, TranscriptActivityRow<EmptyView>.targetInset)
                    .padding(.top, Spacing.hair)
                    .padding(.bottom, Spacing.snug)
            } label: {
                rowLabel()
            }
            .disclosureGroupStyle(TranscriptDisclosureStyle(
                chevron: false,
                minHeight: TranscriptActivityRow<EmptyView>.height
            ))
            .tint(Theme.muted)
        }
    }

    private func rowLabel(showsNavigation: Bool = false) -> some View {
        let parts = Self.splitLeadingVerb(tool.summary.isEmpty ? tool.name : tool.summary)
        return TranscriptActivityRow(
            verb: parts.verb,
            target: parts.target,
            mono: isCommand && parts.verb != nil,
            changeCounts: tool.visibleChangeCounts,
            showsNavigation: showsNavigation
        ) {
            TranscriptToolIcon(name: tool.name, activity: tool.activity)
        }
    }

    /// The opened row grows one block, in the order the call happened:
    /// arguments (never for a command, whose row already states it), then
    /// the payload, then a footer of facts and actions. One fill, hairlines
    /// inside it, so it reads as one object rather than three.
    @ViewBuilder
    private var block: some View {
        let input = isCommand ? nil : tool.input?.trimmingCharacters(in: .whitespacesAndNewlines)
        let output = tool.output?.trimmingCharacters(in: .whitespacesAndNewlines)
        let error = tool.error?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasPayload = [input, output, error].contains { !($0 ?? "").isEmpty }
        if !hasPayload, tool.filePath == nil {
            Text("No output")
                .typeStyle(.footnote)
                .foregroundStyle(Theme.muted)
                .padding(.vertical, Spacing.tight)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                if let input, !input.isEmpty { payload(input, label: "Input") }
                if let output, !output.isEmpty { payload(output, label: nil) }
                if let error, !error.isEmpty { payload(error, label: "Error", ink: Theme.rose) }
                footer(lines: output.map { $0.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).count } ?? 0,
                       copyText: output ?? input ?? error)
            }
            .background(Theme.raised, in: .rect(cornerRadius: Radius.control - Spacing.hair))
        }
    }

    private func payload(_ text: String, label: String?, ink: Color? = nil) -> some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            if let label {
                Text(label).typeStyle(.footnote).foregroundStyle(Theme.muted)
            }
            // A bounded preview keeps a large result from turning expansion
            // into a multi-screen scroll through one tool.
            ScrollView([.horizontal, .vertical]) {
                Text(text)
                    .typeStyle(.caption, mono: true)
                    .foregroundStyle(ink ?? Theme.mutedStrong)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
            }
            .frame(maxHeight: 240)
        }
        .padding(.horizontal, Spacing.row)
        .padding(.vertical, Spacing.snug + Spacing.hair)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .bottom) { Theme.line.frame(height: 1) }
    }

    private func footer(lines: Int, copyText: String?) -> some View {
        HStack(spacing: Spacing.row) {
            if lines > 1 {
                Text("\(lines) lines").monospacedDigit()
            }
            if let path = tool.filePath {
                let label = tool.fileLabel ?? path
                Button("Open") { onOpenFile(path) }
                    .accessibilityLabel("Open \(label)")
            }
            Spacer(minLength: 0)
            if let copyText, !copyText.isEmpty {
                Button("Copy") { UIPasteboard.general.string = copyText }
            }
        }
        .typeStyle(.footnote)
        .foregroundStyle(Theme.muted)
        .buttonStyle(.plain)
        .frame(minHeight: 32)
        .padding(.horizontal, Spacing.row)
    }

    /// "Ran cargo test" → ("Ran", "cargo test"); "Command failed" → (nil, whole).
    /// Only a leading verb the labels use gets split, so a tool's own name
    /// never loses its first word.
    static func splitLeadingVerb(_ summary: String) -> (verb: String?, target: String?) {
        let verbs: Set<String> = [
            "Ran", "Running", "Read", "Reading", "Edited", "Editing", "Created", "Creating",
            "Deleted", "Deleting", "Moved", "Moving", "Viewed", "Viewing", "Captured", "Capturing",
            "Generated", "Generating", "Searched", "Searching", "Listed", "Listing", "Fetched",
            "Fetching", "Loaded", "Used", "Using", "Started", "Starting", "Activated", "Activating"
        ]
        guard let space = summary.firstIndex(of: " "), verbs.contains(String(summary[..<space])) else {
            return (nil, summary)
        }
        let target = summary[summary.index(after: space)...].trimmingCharacters(in: .whitespaces)
        return (String(summary[..<space]), target.isEmpty ? nil : target)
    }
}

struct TranscriptTodoRow: View {
    let list: TranscriptTodoList

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: Spacing.row) {
                ForEach(list.items) { item in
                    Label {
                        Text(item.text ?? "Task").typeStyle(.footnote)
                    } icon: {
                        Image(systemName: symbol(item.status)).typeSymbol(.footnote)
                    }
                        .foregroundStyle(item.status == .active ? Theme.ink : Theme.muted)
                        .strikethrough(item.status == .cancelled)
                }
            }
            .padding(.bottom, Spacing.snug)
        } label: {
            Text("Plan · \(list.items.filter { $0.status == .done }.count) of \(list.items.count) complete")
                .typeStyle(.footnote)
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 44)
        }
        .tint(Theme.muted)
    }

    private func symbol(_ status: TranscriptTodoStatus) -> String {
        switch status {
        case .pending: "circle"
        case .active: "circle.lefthalf.filled"
        case .done: "checkmark.circle.fill"
        case .cancelled: "minus.circle"
        }
    }
}
