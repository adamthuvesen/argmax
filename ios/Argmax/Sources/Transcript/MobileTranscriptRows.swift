import SwiftUI

/// Presentation groups preserve the underlying events and their inspection controls.
/// Minimal also folds pre-answer narration into the work it describes.
enum MobileTranscriptRow: Equatable, Identifiable {
    case item(TranscriptItem)
    case activity([TranscriptItem])

    var id: String {
        switch self {
        case .item(let item): return item.id
        case .activity(let items): return "mobile-activity-\(items[0].id)"
        }
    }

    /// Activity controls already reserve a 44-point tap target.
    var verticalPadding: CGFloat {
        switch self {
        case .activity: return 0
        case .item(let item):
            switch item {
            case .thought, .tools, .todo, .notice: return 0
            default: return Spacing.snug
            }
        }
    }

    /// A remark about the work runs to about three sentences; past that it is writing.
    private static let narrationMaxCharacters = 400

    /// What `String.prototype.trim` strips: WhiteSpace ∪ LineTerminator. Swift's
    /// `.whitespacesAndNewlines` is the same set plus U+0085 and minus U+FEFF.
    private static let jsWhitespace = CharacterSet.whitespacesAndNewlines
        .union(CharacterSet(charactersIn: "\u{FEFF}"))
        .subtracting(CharacterSet(charactersIn: "\u{0085}"))

    /// `/\n\s*\n/`. ICU's `\s` is `[\t\n\f\r\p{Z}]`, which is JS's set without
    /// the vertical tab and the BOM; the two ends stay literal line feeds, so a
    /// lone `\r\r` is no more a paragraph break here than it is there.
    private static let blankLine = try! NSRegularExpression(pattern: "\n[\\s\\u000B\\uFEFF]*\n")

    /// `/^ {0,3}(…)/m`. Spelled out rather than taken from `(?m)`: ICU also
    /// starts a line after a vertical tab, a form feed and U+0085, where JS
    /// breaks only on `\n`, `\r`, U+2028 and U+2029. `[0-9]` rather than `\d`,
    /// which ICU reads as `\p{Nd}` — "١. build it" is not a list on the desktop.
    private static let blockStart = try! NSRegularExpression(
        pattern: "(?:^|(?<=[\\n\\r\\u2028\\u2029])) {0,3}(#{1,6} |[-*+] |[0-9]+[.)] |> |\\||```|~~~)"
    )

    /// Is this prose a passing remark about the work, or writing meant to be read?
    ///
    /// Mirrors `isProgressNarration` in sessionTurnView.ts. "Let me check the
    /// docs." is a remark: one short paragraph of plain sentences. Anything
    /// carrying a heading, list, table, quote or code fence, or running past a
    /// few sentences or a blank line, is the answer itself — it stays visible
    /// at Minimal even when a closing tool call follows it.
    ///
    /// The cap counts UTF-16 units, because `String.length` does: a Swift
    /// `count` of grapheme clusters puts the boundary somewhere else for every
    /// emoji and combining mark in the text.
    ///
    /// Matched through `NSRegularExpression` rather than `range(of:options:
    /// .regularExpression)`, which reports a match as a `Range<String.Index>`
    /// and returns nil when one ends inside a grapheme cluster. A blank line
    /// written `\n\r\n` puts the closing line feed inside the `\r\n` cluster,
    /// so the answer above it read as a remark and hid — and only for a
    /// natively stored string, which is why it survived a round trip through
    /// `JSONSerialization` in a scratch harness.
    static func isProgressNarration(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: jsWhitespace)
        if trimmed.contains("\u{E200}visualize\u{E202}") { return false }
        let length = trimmed.utf16.count
        if length > narrationMaxCharacters { return false }
        let whole = NSRange(location: 0, length: length)
        if blankLine.firstMatch(in: trimmed, range: whole) != nil { return false }
        return blockStart.firstMatch(in: trimmed, range: whole) == nil
    }

    /// Past this, prose after the turn's last tool is an answer, not a sign-off.
    private static let closingRemarkMaxCharacters = 160

    /// Does the prose after the last tool acknowledge that tool rather than
    /// answer? Mirrors `isClosingRemark` in sessionTurnView.ts. Lengths are
    /// UTF-16 units, as there.
    private static func isClosingRemark(candidateLength: Int, tailLength: Int) -> Bool {
        tailLength > 0 && tailLength < closingRemarkMaxCharacters && tailLength * 2 < candidateLength
    }

    private static func trimmedLength(_ text: String) -> Int {
        text.trimmingCharacters(in: jsWhitespace).utf16.count
    }

    /// The prose Minimal folds into the work it narrates: the phone's
    /// `preToolNarrationGroupIds`, one turn at a time. A turn runs from one
    /// regular user message to the next, steering included, as in
    /// `foldConversation`. Reading order stands in for the desktop's
    /// timestamps, because the projection already put each item in its place.
    ///
    /// The boundary is the last *tool*: a tool-less reasoning turn (Grok
    /// alternates tiny thinking/text pairs) keeps every remark it wrote. The
    /// last prose stays, and so does the prose before the last tool when all
    /// that follows that tool is a sign-off: an agent that answers, records
    /// the answer with one closing edit and says "Done." keeps its answer.
    ///
    /// A message with attachments stays on the phone only: its row draws the
    /// image, and a desktop assistant group carries none.
    static func minimalNarrationIDs(_ items: [TranscriptItem], latestTurnIsLive: Bool) -> Set<String> {
        var turns: [[TranscriptItem]] = [[]]
        for item in items {
            if case .user(let message) = item, !message.isSteering { turns.append([]) }
            turns[turns.count - 1].append(item)
        }
        var narration = Set<String>()
        for (index, turn) in turns.enumerated() {
            if latestTurnIsLive && index == turns.count - 1 { continue }
            guard let lastTool = turn.lastIndex(where: { if case .tools = $0 { return true } else { return false } })
            else { continue }
            let prose: [(index: Int, message: TranscriptMessage)] = turn.enumerated().compactMap { offset, item in
                if case .assistant(let message) = item { return (offset, message) }
                return nil
            }
            var kept = Set<String>()
            if let last = prose.last { kept.insert(last.message.id) }
            let tailLength = prose.filter { $0.index > lastTool }.reduce(0) { $0 + trimmedLength($1.message.text) }
            let beforeLastTool = prose.filter { $0.index < lastTool }
            if let candidate = beforeLastTool.last,
               isClosingRemark(candidateLength: trimmedLength(candidate.message.text), tailLength: tailLength) {
                kept.insert(candidate.message.id)
            }
            for (_, message) in beforeLastTool
            where !kept.contains(message.id) && message.attachments.isEmpty && isProgressNarration(message.text) {
                narration.insert(message.id)
            }
        }
        return narration
    }

    /// - Parameter latestTurnIsLive: the newest turn is still working. Only
    ///   that turn can be, and while it is, its narration stays on screen so
    ///   the reader can watch the agent talk while tools run — the desktop's
    ///   `isStreamingTurn` gate on `preToolNarrationGroupIds`. Folding it live
    ///   swallowed a sentence mid-read, and moved the activity row's id from
    ///   the tool it started on to the narration in front of it, which rebuilt
    ///   the row and lost both its expansion and its scroll anchor.
    static func rows(_ items: [TranscriptItem], detail: MobileChatDetail,
                     latestTurnIsLive: Bool) -> [MobileTranscriptRow] {
        guard detail.foldsActivity else { return items.map(Self.item) }
        let narration = detail.hidesNarration
            ? minimalNarrationIDs(items, latestTurnIsLive: latestTurnIsLive)
            : []
        var result: [MobileTranscriptRow] = []
        var run: [TranscriptItem] = []
        var runHasTools = false
        // Narration describes work that has not been reached yet, so it only
        // joins a run once that run holds some. Held back it is prose like any
        // other, rather than a fold promising thinking and activity that opens
        // to one sentence.
        var pendingNarration: [TranscriptItem] = []
        func flush() {
            // A run of reasoning alone keeps the thought's own disclosure: an
            // outer fold over it is a nested control, and its static label
            // hides the one row that says "Thinking" while the model reasons.
            // `ToolCallGroupBubble` makes the same call for the same reason.
            if runHasTools { result.append(.activity(run)) }
            else { result.append(contentsOf: run.map(Self.item)) }
            run = []
            runHasTools = false
        }
        func dropPending() {
            result.append(contentsOf: pendingNarration.map(Self.item))
            pendingNarration = []
        }
        for item in items {
            switch item {
            case .thought, .tools:
                if case .tools = item { runHasTools = true }
                run.append(contentsOf: pendingNarration)
                pendingNarration = []
                run.append(item)
            case .assistant where narration.contains(item.id):
                if run.isEmpty { pendingNarration.append(item) } else { run.append(item) }
            default:
                dropPending()
                flush()
                result.append(.item(item))
            }
        }
        dropPending()
        flush()
        return result
    }

    /// The collapsed line of a folded run: what it says, and whether it is
    /// working. Reasoning still streaming counts as work — the desktop's
    /// `activityIsLive` — so the fold waves and drops its counts through a
    /// reasoning phase instead of standing there as one static grey line.
    static func foldHeadline(_ items: [TranscriptItem])
        -> (tools: [TranscriptTool], summary: String, running: Bool) {
        let tools = items.flatMap { item -> [TranscriptTool] in
            if case .tools(let group) = item { return group.tools }
            return []
        }
        let thinking = items.contains { item in
            if case .thought(let thought) = item { return thought.isStreaming }
            return false
        }
        return (
            tools,
            tools.isEmpty
                ? (thinking ? "Thinking" : "Thought")
                : TranscriptToolActivity.summary(for: tools).headline,
            tools.contains { $0.status == .running } || thinking
        )
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
                let headline = MobileTranscriptRow.foldHeadline(items)
                TranscriptFoldLabel(
                    tools: headline.tools,
                    summary: headline.summary,
                    running: headline.running,
                    lines: items.map(\.id),
                    maxIcons: detail == .minimal ? 1 : 3,
                    lineLimit: 1
                )
            }
            .tint(Theme.muted)
            .onChange(of: detail) { expanded = false }
        }
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

/// Whether a row belongs to the newest turn, the one Detailed opens outputs
/// in. False outside the main transcript, so subagent and multitask details
/// keep their steps folded.
private struct TranscriptRowInLatestTurnKey: EnvironmentKey {
    static let defaultValue = false
}

/// Whether the open chat's turn is still running on a live connection. Rows
/// read it from the environment rather than observing `TranscriptStore`: an
/// observing row re-renders on every change the store publishes, which is
/// every streamed chunk and every composer keystroke's metadata.
private struct TranscriptSessionWorkingKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var transcriptRowInLatestTurn: Bool {
        get { self[TranscriptRowInLatestTurnKey.self] }
        set { self[TranscriptRowInLatestTurnKey.self] = newValue }
    }

    var transcriptSessionWorking: Bool {
        get { self[TranscriptSessionWorkingKey.self] }
        set { self[TranscriptSessionWorkingKey.self] = newValue }
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
