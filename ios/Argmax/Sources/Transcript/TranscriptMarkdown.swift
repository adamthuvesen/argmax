import Foundation
import SwiftUI

/// Native transcript prose. Foundation remains the Markdown parser so links,
/// emphasis, nested lists, quotes, and code share Apple's CommonMark behavior.
/// The small preparation pass only lifts content Foundation cannot represent:
/// GFM tables, images, and math.
struct TranscriptMarkdown: View {
    let document: TranscriptMarkdownDocument
    let client: BridgeClient?
    let onOpenFile: (String) -> Void

    init(
        text: String,
        client: BridgeClient? = nil,
        onOpenFile: @escaping (String) -> Void = { _ in }
    ) {
        document = TranscriptMarkdownDocument(markdown: text)
        self.client = client
        self.onOpenFile = onOpenFile
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
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
    private func blockView(_ block: TranscriptMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            TranscriptInlineMarkdown(text: text, math: document.math)
                .font(.body)
                .foregroundStyle(Theme.ink)
        case .heading(let level, let text):
            TranscriptInlineMarkdown(text: text, math: document.math)
                .font(headingFont(level))
                .foregroundStyle(Theme.ink)
                .padding(.top, level == 1 ? 6 : 2)
                .accessibilityAddTraits(.isHeader)
        case .listItem(let ordinal, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordinal.map { "\($0)." } ?? "•")
                    .font(.body.monospacedDigit())
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 15, alignment: .trailing)
                    .accessibilityHidden(true)
                TranscriptInlineMarkdown(text: text, math: document.math)
                    .font(.body)
                    .foregroundStyle(Theme.ink)
            }
            .padding(.leading, CGFloat(max(depth - 1, 0)) * 18)
        case .quote(let text):
            HStack(alignment: .top, spacing: 10) {
                Capsule().fill(Theme.line).frame(width: 3)
                TranscriptInlineMarkdown(text: text, math: document.math)
                    .font(.body)
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

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.weight(.semibold)
        case 2: return .headline.weight(.semibold)
        default: return .body.weight(.semibold)
        }
    }
}

struct TranscriptInlineMarkdown: View {
    let text: AttributedString
    let math: [String: TranscriptMath]

    var body: some View {
        let pieces = TranscriptMarkdownDocument.inlinePieces(text, math: math)
        if pieces.count == 1, case .text(let attributed) = pieces[0] {
            Text(attributed).textSelection(.enabled)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                    switch piece {
                    case .text(let attributed):
                        Text(attributed)
                            .textSelection(.enabled)
                    case .math(let math):
                        TranscriptRichBlock(kind: .math, source: math.source, display: true)
                    }
                }
            }
        }
    }
}
