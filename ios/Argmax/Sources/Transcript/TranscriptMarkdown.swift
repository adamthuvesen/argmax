import Foundation
import SwiftUI

/// Native transcript prose. Foundation remains the Markdown parser so links,
/// emphasis, nested lists, quotes, and code share Apple's CommonMark behavior.
/// The small preparation pass only lifts content Foundation cannot represent:
/// GFM tables, images, and math.
struct TranscriptMarkdown: View {
    @State private var prepared: (key: TranscriptMarkdownKey, document: TranscriptMarkdownDocument)?
    let text: String
    let isThinking: Bool
    @Environment(\.transcriptWorkspacePath) private var workspacePath
    @Environment(\.foldedNarration) private var foldedNarration
    let client: BridgeClient?
    let onOpenFile: (String) -> Void

    init(
        text: String,
        client: BridgeClient? = nil,
        onOpenFile: @escaping (String) -> Void = { _ in },
        isThinking: Bool = false
    ) {
        self.text = text
        self.isThinking = isThinking
        self.client = client
        self.onOpenFile = onOpenFile
    }

    var body: some View {
        let key = TranscriptMarkdownKey(text: text, workspacePath: workspacePath, isThinking: isThinking)
        // While a changed text is being prepared, keep the last document this
        // row painted. A streamed answer changes text on every chunk, and
        // dropping to the plain fallback in between is the paragraph
        // re-wrapping in a different font a few times a second. Plain text
        // is only for a row that has never had a document.
        let document = TranscriptMarkdownCache.shared.cached(key) ?? prepared?.document
        VStack(alignment: .leading, spacing: 0) {
            if let document {
                let blocks = document.blocks
                ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
                    blockView(block, math: document.math)
                        .padding(.top, index == 0 ? 0 : Self.gap(before: block, after: blocks[index - 1]))
                }
            } else {
                Text(text).typeStyle(proseStyle)
                    .foregroundStyle(proseInk)
            }
        }
        .task(id: key) {
            guard let document = try? await TranscriptMarkdownCache.shared.document(key),
                  !Task.isCancelled else { return }
            prepared = (key, document)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            if TranscriptMarkdownDocument.isAnchorLink(url) { return .handled }
            if let external = TranscriptMarkdownDocument.httpsURL(forProtocolRelative: url) {
                return .systemAction(external)
            }
            guard TranscriptMarkdownDocument.isLocalLink(url) else { return .systemAction }
            onOpenFile(TranscriptMarkdownDocument.localPath(from: url))
            return .handled
        })
    }

    @ViewBuilder
    private func blockView(_ block: TranscriptMarkdownBlock, math: [String: TranscriptMath]) -> some View {
        switch block {
        case .paragraph(let text):
            TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing, strongStyle: proseStyle)
                .typeStyle(proseStyle)
                .foregroundStyle(proseInk)
        case .heading(let level, let text):
            TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing)
                .typeStyle(isThinking ? .footnote : foldedNarration ? proseStyle : headingStyle(level),
                           weight: isThinking ? nil : .bold)
                .foregroundStyle(proseInk)
                .padding(.top, level == 1 ? 10 : 6)
                .accessibilityAddTraits(.isHeader)
        case .listItem(let ordinal, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordinal.map { "\($0)." } ?? "•")
                    .typeStyle(proseStyle, monospacedDigit: true)
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 15, alignment: .trailing)
                    .accessibilityHidden(true)
                TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing, strongStyle: proseStyle)
                    .typeStyle(proseStyle)
                    .foregroundStyle(proseInk)
            }
            .padding(.leading, CGFloat(max(depth - 1, 0)) * 18)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(Theme.line).frame(width: 3)
                TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing, strongStyle: proseStyle)
                    .typeStyle(proseStyle)
                    .foregroundStyle(Theme.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let source):
            TranscriptCodeBlock(language: language, source: source, onOpenFile: onOpenFile)
        case .table(let table):
            TranscriptTableBlock(table: table)
        case .image(let image):
            TranscriptMarkdownImage(image: image, client: client, onOpenFile: onOpenFile)
        case .math(let source, let display):
            TranscriptRichBlock(kind: .math, source: source, display: display)
        case .thematicBreak:
            Divider().overlay(Theme.line)
        }
    }

    /// The gap above a block. Two list rows sit closer than any other pair
    /// so a list has a tighter texture than the paragraphs around it and
    /// reads as one group; one shared VStack spacing made four bullets look
    /// like four paragraphs (docs/design/prose-rhythm, P1).
    private static func gap(before block: TranscriptMarkdownBlock, after previous: TranscriptMarkdownBlock) -> CGFloat {
        if case .listItem = block, case .listItem = previous { return 7 }
        return 13
    }

    /// Headings are all bold, so only the step changes with the level. An
    /// `h3` sits a step over the body (title3, 20pt on 17), mirroring the
    /// Mac's `--text-md-plus` over `--text-base`: at body size a heading was
    /// only its weight away from a bold lead-in and the two read as one
    /// (docs/design/prose-rhythm).
    private func headingStyle(_ level: Int) -> Font.TextStyle {
        switch level {
        case 1: return .title
        case 2: return .title2
        default: return .title3
        }
    }

    private var proseLineSpacing: CGFloat {
        isThinking ? 0 : Spacing.proseLine
    }

    /// Three registers: the answer at body in ink; reasoning at footnote in
    /// muted; and narration folded into an activity group one step under
    /// each — subheadline, muted-strong — so what the agent said on the way
    /// does not read as the reply (docs/design/phone-activity-group).
    private var proseStyle: Font.TextStyle {
        isThinking ? .footnote : foldedNarration ? .subheadline : .body
    }

    private var proseInk: Color {
        isThinking ? Theme.muted : foldedNarration ? Theme.mutedStrong : Theme.ink
    }
}

private struct FoldedNarrationKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Set on the prose an activity group folds in with its work.
    var foldedNarration: Bool {
        get { self[FoldedNarrationKey.self] }
        set { self[FoldedNarrationKey.self] = newValue }
    }
}

struct TranscriptInlineMarkdown: View {
    @Environment(\.typeScale) private var scale
    let text: AttributedString
    let math: [String: TranscriptMath]
    let lineSpacing: CGFloat
    /// The style the text is set in, for drawing its bold runs semibold. Nil
    /// leaves bold on the trait, for text that is already semibold (headings).
    var strongStyle: Font.TextStyle? = nil

    var body: some View {
        let styled = strongStyle.map { text.semiboldStrongRuns(scale.font($0, weight: .semibold)) } ?? text
        let pieces = TranscriptMarkdownDocument.inlinePieces(styled, math: math)
        if pieces.count == 1, case .text(let attributed) = pieces[0] {
            Text(attributed)
                .lineSpacing(lineSpacing)
                .textSelection(.enabled)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                    switch piece {
                    case .text(let attributed):
                        Text(attributed)
                            .lineSpacing(lineSpacing)
                            .textSelection(.enabled)
                    case .math(let math):
                        TranscriptRichBlock(kind: .math, source: math.source, display: true)
                    }
                }
            }
        }
    }
}

extension AttributedString {
    /// `**bold**` in `font`, the semibold cut, as the Mac sets bold a step
    /// under its headings. The bold trait reaches Geist Bold (700), the
    /// headings' own cut. Bold italic and bold code keep the trait:
    /// only the 700 cut has a sheared italic, and code runs are mono.
    func semiboldStrongRuns(_ font: Font) -> AttributedString {
        var styled = self
        for run in Array(styled.runs) {
            guard var intent = run.inlinePresentationIntent,
                  intent.contains(.stronglyEmphasized),
                  !intent.contains(.emphasized),
                  !intent.contains(.code)
            else { continue }
            intent.remove(.stronglyEmphasized)
            styled[run.range].inlinePresentationIntent = intent
            styled[run.range].font = font
        }
        return styled
    }
}
