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
        let document = TranscriptMarkdownCache.shared.cached(key)
            ?? (prepared?.key == key ? prepared?.document : nil)
        VStack(alignment: .leading, spacing: 12) {
            if let document {
                ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                    blockView(block, math: document.math)
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
            TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing)
                .typeStyle(proseStyle)
                .foregroundStyle(proseInk)
        case .heading(let level, let text):
            TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing)
                .typeStyle(isThinking ? .footnote : foldedNarration ? proseStyle : headingStyle(level),
                           weight: isThinking ? nil : .semibold)
                .foregroundStyle(proseInk)
                .padding(.top, level == 1 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
        case .listItem(let ordinal, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordinal.map { "\($0)." } ?? "•")
                    .typeStyle(proseStyle, monospacedDigit: true)
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 15, alignment: .trailing)
                    .accessibilityHidden(true)
                TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing)
                    .typeStyle(proseStyle)
                    .foregroundStyle(proseInk)
            }
            .padding(.leading, CGFloat(max(depth - 1, 0)) * 18)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(Theme.line).frame(width: 3)
                TranscriptInlineMarkdown(text: text, math: math, lineSpacing: proseLineSpacing)
                    .typeStyle(proseStyle)
                    .foregroundStyle(Theme.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let source):
            TranscriptCodeBlock(language: language, source: source)
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

    /// Headings are all semibold, so only the step changes with the level.
    private func headingStyle(_ level: Int) -> Font.TextStyle {
        switch level {
        case 1: return .title3
        case 2: return .headline
        default: return .body
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
    let text: AttributedString
    let math: [String: TranscriptMath]
    let lineSpacing: CGFloat

    var body: some View {
        let pieces = TranscriptMarkdownDocument.inlinePieces(text, math: math)
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
