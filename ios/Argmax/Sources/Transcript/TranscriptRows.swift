import SwiftUI

private extension View {
    /// The 26pt fade a capped block ends in. The collapsed prompt and the
    /// long-press preview both cut a message short, and both say so the same
    /// way rather than one ending in a hard edge.
    func fadedTail(_ faded: Bool) -> some View {
        mask {
            if faded {
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
    }
}

struct TranscriptMessageRow: View {
    let message: TranscriptMessage
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    @EnvironmentObject private var appearance: Appearance
    @Environment(\.accentTint) private var accent
    @ScaledMetric(relativeTo: .body) private var previewHeight = 6 * 1.68 * 17.0
    @ScaledMetric(relativeTo: .body) private var menuPreviewHeight = 10 * 1.68 * 17.0
    @State private var contentHeight: CGFloat = 0
    @State private var rowSize: CGSize = .zero
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if !message.attachments.isEmpty {
                TranscriptAttachmentStrip(attachments: message.attachments, client: client,
                                          alignment: message.role == .user ? .trailing : .leading,
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
                            .fadedTail(contentHeight > previewHeight + 1 && !expanded)
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
                            .fill(appearance.accentBubbles ? accent.color.opacity(0.50) : Theme.userMessageNeutral)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, message.role == .user ? 24 : 0)
        .onGeometryChange(for: CGSize.self) { $0.size } action: { rowSize = $0 }
        .contextMenu {
            Button("Copy message", systemImage: "doc.on.doc") {
                UIPasteboard.general.string = message.text
            }
            ShareLink(item: message.text)
        } preview: {
            // The automatic snapshot lifts the whole answer, transparent, over
            // the rows behind it, and a `Text` of the same source shows its
            // Markdown delimiters and cuts mid-token. This is the message as
            // the row drew it, in the row's own column, ending in the fade a
            // collapsed prompt already uses.
            TranscriptMarkdown(text: message.text, client: client)
                .frame(width: max(rowSize.width - 2 * Spacing.row, 240), alignment: .topLeading)
                // Before the height cap, or the stack pays for it by
                // truncating every paragraph in the answer to one line.
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxHeight: menuPreviewHeight, alignment: .top)
                .fadedTail(rowSize.height > menuPreviewHeight)
                .padding(Spacing.row)
                .background(Theme.raised)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card))
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
    @Environment(\.activityIconColorMode) private var activityIconColorMode

    var body: some View {
        if detail == .detailed {
            TranscriptMarkdown(text: thought.text, client: client, onOpenFile: onOpenFile, isThinking: true)
        } else {
        // Steps previews the burst still being written and folds every settled
        // one to its header, the way `ThoughtBlock` does at `display: "preview"`
        // (`display === "preview" && live && !expanded`). Printed inline, a
        // finished twenty-burst Codex turn was eight thousand characters of
        // reasoning where the desktop shows twenty one-line titles.
        VStack(alignment: .leading, spacing: Spacing.tight) {
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
                    target: thought.isStreaming ? nil : TranscriptThought.title(of: thought.text),
                    // Reasoning in flight is the turn's progress cue. Without
                    // the wave here the row stated "Thinking" and then sat
                    // still for the whole burst.
                    live: thought.isStreaming
                ) {
                    Image(systemName: "brain")
                        .typeSymbol(size: 14)
                        .foregroundStyle(
                            (activityIconColorMode == .color ? Theme.activityPurple : Theme.muted)
                                .opacity(thought.isStreaming ? 1 : 0.78)
                        )
                        .frame(width: 16, height: 16)
                }
            }
            .disclosureGroupStyle(TranscriptDisclosureStyle(chevron: false, minHeight: TranscriptActivityRow<EmptyView>.height))
            .tint(Theme.muted)
            if detail == .steps, thought.isStreaming {
                // Plain text, not Markdown: three lines of the reasoning's tail
                // are a progress cue, and mounting a Markdown tree per delta
                // for them is what made a long burst cost O(n²).
                Text(TranscriptThought.previewTail(of: thought.text))
                    .typeStyle(.body)
                    .foregroundStyle(Theme.mutedStrong)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, TranscriptActivityRow<EmptyView>.targetInset)
                    .accessibilityLabel("Thinking preview")
            }
        }
        }
    }
}

struct TranscriptToolsRow: View {
    let group: TranscriptToolGroup
    let onOpenFile: (String) -> Void
    var onOpenDiff: ((String) -> Void)? = nil
    @Environment(\.mobileChatDetail) private var detail
    @Environment(\.activityToolsAreRevealed) private var activityToolsAreRevealed
    @Environment(\.activityBeat) private var beat

    private var running: Bool { group.tools.contains { $0.status == .running } }

    /// The row that just did the work, when this group holds the beat between
    /// calls: the one whose completion the silence started at, the same stamp
    /// `TranscriptThinking.settledBeat` reads. From `.steps` up and inside an
    /// expanded fold the group shows bare rows, so the beat would otherwise
    /// publish here and nothing would claim it — the fold's headline gets it
    /// only where the fold exists. Static so the projection tests can pin it.
    static func beatToolID(of group: TranscriptToolGroup, beat: String?) -> String? {
        guard let beat, beat == group.id else { return nil }
        return group.tools
            .compactMap { tool in tool.completedAt.map { (id: tool.id, at: $0) } }
            .max(by: { $0.at < $1.at })?
            .id
    }

    private var beatToolID: String? {
        Self.beatToolID(of: group, beat: beat)
    }

    var body: some View {
        // A row reserves its own height, so the rows stack without a gap.
        if detail == .steps || detail == .detailed || activityToolsAreRevealed {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(group.tools) { tool in
                    TranscriptToolRow(tool: tool, holdsBeat: tool.id == beatToolID,
                                      onOpenFile: onOpenFile, onOpenDiff: onOpenDiff)
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
                                running: running, lines: [group.id],
                                maxIcons: 3, lineLimit: 2)
        }
        .tint(Theme.muted)
        }
    }
}

/// The collapsed line of a fold: up to a few tool icons and the headline,
/// which carries the reading wave while a call runs. Each piece changes on
/// its own clock while a turn works, so the label owns the pacing
/// (`TranscriptDwell`): while the fold runs, the headline re-words on the
/// kinds of work in it rather than on the count, at most once every 800ms,
/// and the counts land when the work settles. Desktop paces the same line the
/// same way in `lib/pacedHeadline.ts`.
///
/// Desktop goes one step further and fades in only the clause that changed,
/// holding the verb (`[data-arriving]`, 220ms). A phone headline is one
/// `Text` that wraps to two lines, and neither a wrapping `HStack` of clauses
/// nor a concatenated `Text` can transition one run of glyphs on its own, so
/// the whole line still cross-fades over 180ms — now only on a real change of
/// kind, which is about half as often as before.
struct TranscriptFoldLabel: View {
    let tools: [TranscriptTool]
    let summary: String
    /// A call in flight in this fold, and the only thing that moves the
    /// headline. The fold re-words for work it is doing, and its counts are
    /// news the moment they land, so the beat between calls must not hold them
    /// behind a dwell.
    let running: Bool
    /// The transcript items this line speaks for — one fold, or the several a
    /// merged activity row folds together — so it can tell whether it is the
    /// line holding the beat between calls (`\.activityBeat`).
    let lines: [String]
    let maxIcons: Int
    let lineLimit: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.activityBeat) private var beat

    private var motion: Animation? { reduceMotion ? nil : .easeOut(duration: 0.18) }
    /// Whether this line carries the reading wave: a call of its own in
    /// flight, or the beat between calls, which the line that just did the
    /// work keeps until the cue earns its word. Three of the five providers
    /// report a call atomically (`TranscriptThinking.beatHolder`), so without
    /// the second clause their folds never wave at all.
    private var live: Bool { running || (beat.map(lines.contains) ?? false) }

    /// The live line drops its counts, whether it is running or holding the
    /// beat between calls: a number that lands before the work does reads as
    /// a total. Recomputed here rather than passed in, since only this view
    /// knows which line the beat is on.
    private var shownSummary: String {
        guard live, !tools.isEmpty else { return summary }
        return TranscriptToolActivity.summary(for: tools, counting: false).headline
    }

    var body: some View {
        TranscriptDwelledValue(value: Shown(summary: shownSummary, live: live, icons: iconTools),
                               key: Self.kindKey(for: tools), running: running) { shown in
            HStack(spacing: Spacing.snug) {
                ForEach(shown.icons) { tool in
                    TranscriptToolIcon(name: tool.name, activity: tool.activity, state: tool.activityState)
                        .transition(.opacity)
                }
                Text(shown.summary)
                    .readingWave(shown.live)
                    .lineLimit(lineLimit)
                    .contentTransition(.opacity)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .geometryGroup()
            .animation(motion, value: shown)
        }
        .typeSubtitle()
        .foregroundStyle(Theme.muted)
        .frame(minHeight: 44)
        .contentShape(.rect)
    }

    private struct Shown: Equatable {
        var summary: String
        var live: Bool
        var icons: [TranscriptTool]
    }

    /// The kinds of work in the fold, in the order the headline names them —
    /// what a running headline is allowed to re-word on. An edit's operation
    /// belongs to it, since creating and moving are different words. The
    /// outcome does not: a call finishing is a count, and a fold that is still
    /// working has no news in it.
    static func kindKey(for tools: [TranscriptTool]) -> String {
        var seen = Set<String>()
        return tools.compactMap { tool -> String? in
            let key = tool.activity.kind.rawValue
                + (tool.activity.operation.map { ":\($0.rawValue)" } ?? "")
            return seen.insert(key).inserted ? key : nil
        }.joined(separator: "+")
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
    /// Live work marked on the row's own words, the way the desktop's
    /// `ToolCallRow` marks a running row: the band reads the verb and the
    /// target as one pass, and each keeps its own resting colour, because a
    /// renderer paints the glyphs it is given and would erase whichever
    /// colour ran underneath (`ReadingWaveText`).
    var live = false
    @ViewBuilder let icon: () -> Icon

    @State private var verbWidth: CGFloat = 0
    @State private var targetWidth: CGFloat = 0
    @ScaledMetric(relativeTo: .subheadline) private var em: CGFloat = 15

    /// One pass over both word runs, sized like the desktop's container
    /// measures it: the words from the verb's left edge to the target's
    /// right, plus the band's own entry and exit. Measured rather than
    /// assumed, because the target truncates while the verb does not, and a
    /// pass timed from the row's width crawled on the short lines.
    private var sharedTravel: CGFloat? {
        guard live, verb != nil, target != nil else { return nil }
        let sigma = ReadingWave.sigma * em
        return verbWidth + (Spacing.snug + Spacing.hair) + targetWidth + 6 * sigma
    }

    /// Where the target starts, relative to the verb: the band has already
    /// read that far by the time it arrives there.
    private var targetOffset: CGFloat { verbWidth + Spacing.snug + Spacing.hair }

    var body: some View {
        HStack(alignment: .center, spacing: Spacing.snug + Spacing.hair) {
            icon()
            if let verb {
                Text(verb)
                    .readingWave(live, sharedTravel: sharedTravel, restInk: Theme.mutedStrong)
                    .typeSubtitle()
                    .foregroundStyle(Theme.mutedStrong)
                    .fixedSize()
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { verbWidth = $0 }
            }
            if let target {
                Text(target)
                    .readingWave(live, offset: targetOffset, sharedTravel: sharedTravel, restInk: Theme.muted)
                    .typeSubtitle(mono: mono)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { targetWidth = $0 }
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
    /// The beat between calls, when the group this row belongs to holds it,
    /// is this row's to carry: it is the row the silence started at. The cue
    /// hands the beat over only for the length of its own wait, so a settled
    /// row here waves exactly where a running one would.
    var holdsBeat = false
    let onOpenFile: (String) -> Void
    let onOpenDiff: ((String) -> Void)?
    @Environment(\.mobileChatDetail) private var detail
    @Environment(\.transcriptRowInLatestTurn) private var inLatestTurn
    @State private var userExpanded: Bool?
    @State private var showsAllOutput = false

    /// How much of an output an opened Detailed row shows before "Show all".
    static let outputPreviewLines = 8

    private var isCommand: Bool { tool.activity.kind == .command }

    /// Detailed opens the latest turn's outputs, which is what the reader is
    /// watching; older turns stay folded so scrolling back is not a wall of
    /// payloads. A row the reader toggled keeps their choice.
    private var opensByDefault: Bool {
        guard detail == .detailed, inLatestTurn else { return false }
        return [tool.output, tool.error].contains { text in
            text.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        }
    }

    private var expanded: Binding<Bool> {
        Binding(get: { userExpanded ?? opensByDefault }, set: { userExpanded = $0 })
    }

    /// Live work marked on the words: a call in flight, or this row holding
    /// the beat between calls. Providers that report a call atomically never
    /// have a running row, so without the second clause their detailed rows
    /// never wave at all.
    private var live: Bool { tool.status == .running || holdsBeat }

    private var hasExpandableDetail: Bool {
        if tool.filePath != nil { return true }
        if !isCommand, let input = tool.input?.trimmingCharacters(in: .whitespacesAndNewlines), !input.isEmpty {
            return true
        }
        if let output = tool.output?.trimmingCharacters(in: .whitespacesAndNewlines), !output.isEmpty {
            return true
        }
        if let error = tool.error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
            return true
        }
        return false
    }

    @ViewBuilder
    var body: some View {
        if let diffPath = tool.diffPath, let onOpenDiff {
            Button {
                onOpenDiff(diffPath)
            } label: {
                rowLabel(showsNavigation: true)
            }
            .buttonStyle(PressDim())
            .accessibilityHint("Opens this file's diff")
        } else if hasExpandableDetail {
            DisclosureGroup(isExpanded: expanded) {
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
        } else {
            rowLabel()
        }
    }

    private func rowLabel(showsNavigation: Bool = false) -> some View {
        let parts = Self.splitLeadingVerb(tool.summary.isEmpty ? tool.name : tool.summary)
        return TranscriptActivityRow(
            verb: parts.verb,
            target: parts.target,
            mono: isCommand && parts.verb != nil,
            changeCounts: tool.visibleChangeCounts,
            showsNavigation: showsNavigation,
            live: live
        ) {
            TranscriptToolIcon(name: tool.name, activity: tool.activity, state: tool.activityState)
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
        let outputLines = output.map { $0.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) } ?? []
        let capsOutput = detail == .detailed && !showsAllOutput && outputLines.count > Self.outputPreviewLines
        VStack(alignment: .leading, spacing: 0) {
            if let input, !input.isEmpty { payload(input, label: "Input") }
            if let output, !output.isEmpty {
                payload(capsOutput ? outputLines.prefix(Self.outputPreviewLines).joined(separator: "\n") + "\n…" : output,
                        label: nil)
            }
            if let error, !error.isEmpty { payload(error, label: "Error", ink: Theme.rose) }
            footer(lines: outputLines.count, copyText: output ?? input ?? error)
        }
        .background(Theme.raised, in: .rect(cornerRadius: Radius.control - Spacing.hair))
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
            if detail == .detailed && lines > Self.outputPreviewLines {
                Button(showsAllOutput ? "Show less" : "Show all \(lines) lines") { showsAllOutput.toggle() }
                    .monospacedDigit()
            } else if lines > 1 {
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
    var running = false

    @State private var userExpanded: Bool?

    private var expanded: Bool { userExpanded ?? running }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) { userExpanded = !expanded }
            } label: {
                HStack(spacing: Spacing.tight) {
                    Image(systemName: "chevron.right")
                        .typeSymbol(.caption2, weight: .semibold)
                        .foregroundStyle(Theme.muted.opacity(expanded ? 0.55 : 0.28))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                        .accessibilityHidden(true)
                    Text("Plan")
                        .typeSubtitle()
                        .foregroundStyle(Theme.mutedStrong)
                        .fixedSize()
                    Text("\(list.doneCount) of \(list.items.count)")
                        .typeSubtitle(monospacedDigit: true)
                        .foregroundStyle(Theme.muted)
                        .fixedSize()
                    if !expanded, let tail = list.collapsedTail {
                        Text(tail)
                            .typeSubtitle()
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: TranscriptActivityRow<EmptyView>.height)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(headLabel)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(.isButton)

            if expanded {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(list.visibleItems.enumerated()), id: \.offset) { _, item in
                        todoItem(item)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var headLabel: String {
        var label = "Plan \(list.doneCount) of \(list.items.count)"
        if !expanded, let tail = list.collapsedTail {
            label += " \(tail)"
        }
        return label
    }

    private func todoItem(_ item: TranscriptTodoItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.tight) {
            todoMark(item.status)
                .frame(width: 12, height: 12)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            Text(TranscriptTodoList.label(for: item))
                .typeSubtitle(weight: item.status == .active && item.text != nil ? .medium : .regular)
                .foregroundStyle(labelInk(item))
                .strikethrough(item.status == .cancelled, color: Theme.line)
        }
        .padding(.vertical, Spacing.tight)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(statusLabel(item.status)), \(TranscriptTodoList.label(for: item))")
    }

    @ViewBuilder
    private func todoMark(_ status: TranscriptTodoStatus) -> some View {
        switch status {
        case .done:
            Image(systemName: "checkmark")
                .typeSymbol(size: 9, weight: .semibold)
                .foregroundStyle(Theme.sage)
                .accessibilityHidden(true)
        case .active:
            WorkingNest(size: 12, active: running)
                .accessibilityHidden(true)
        case .cancelled:
            Image(systemName: "xmark")
                .typeSymbol(size: 8, weight: .semibold)
                .foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
        case .pending, .removed:
            Circle()
                .strokeBorder(Theme.muted.opacity(0.55), lineWidth: 1.25)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
        }
    }

    private func labelInk(_ item: TranscriptTodoItem) -> Color {
        if item.text == nil { return Theme.muted }
        switch item.status {
        case .done, .cancelled, .removed: return Theme.muted
        case .pending: return Theme.mutedStrong
        case .active: return Theme.ink
        }
    }

    private func statusLabel(_ status: TranscriptTodoStatus) -> String {
        switch status {
        case .done: "Done"
        case .active: "In progress"
        case .pending: "Pending"
        case .cancelled: "Cancelled"
        case .removed: "Removed"
        }
    }
}
