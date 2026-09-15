import SwiftUI
import UIKit

/// A fence's info string. The agent cites source as `startLine:endLine:path`,
/// so a citation carries a file to name and to open; every other fence carries
/// a language tag, or nothing.
struct TranscriptCodeFence: Equatable, Sendable {
    let title: String
    /// Set only for a citation — the only header worth a tap.
    let path: String?
    let lines: ClosedRange<Int>?

    static func parse(_ info: String?) -> TranscriptCodeFence {
        guard let info, !info.isEmpty else { return Self(title: "Code", path: nil, lines: nil) }
        let fields = info.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard fields.count == 3,
              let start = Int(fields[0]),
              let end = Int(fields[1]), end >= start,
              !fields[2].isEmpty
        else { return Self(title: info, path: nil, lines: nil) }
        let path = String(fields[2])
        return Self(title: URL(fileURLWithPath: path).lastPathComponent, path: path, lines: start...end)
    }

    /// The cited range, collapsed to one number when it is one line.
    var range: String? {
        guard let lines else { return nil }
        return lines.count == 1 ? "\(lines.lowerBound)" : "\(lines.lowerBound)–\(lines.upperBound)"
    }

    /// VoiceOver gets the directory the visible label spends its width dropping.
    var spokenLabel: String {
        guard let path, let lines else { return title }
        return lines.count == 1
            ? "\(path), line \(lines.lowerBound)"
            : "\(path), lines \(lines.lowerBound) to \(lines.upperBound)"
    }
}

struct TranscriptCodeBlock: View {
    let language: String?
    let source: String
    let onOpenFile: (String) -> Void
    @State private var expanded = false

    init(language: String?, source: String, onOpenFile: @escaping (String) -> Void = { _ in }) {
        self.language = language
        self.source = source
        self.onOpenFile = onOpenFile
    }

    private var fence: TranscriptCodeFence { .parse(language) }

    private var isMermaid: Bool {
        guard let language else { return false }
        return language.lowercased() == "mermaid" || language.lowercased() == "mmd"
    }

    /// CommonMark keeps the newline that closes the fence. Painted, it is an
    /// empty last line that reads as a card padded wrong. `CodeBlock.tsx` drops
    /// exactly one on the Mac, so doing the same here also keeps what the copy
    /// button puts on the clipboard identical between the two.
    private var text: String {
        source.hasSuffix("\n") ? String(source.dropLast()) : source
    }

    var body: some View {
        if isMermaid {
            TranscriptRichBlock(kind: .mermaid, source: text, display: true)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().overlay(Theme.line)
                ScrollView(.horizontal) {
                    code
                        .padding(.horizontal, 10)
                        .padding(.top, Spacing.snug)
                        .padding(.bottom, Spacing.row)
                }
            }
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .fullScreenCover(isPresented: $expanded) { fullScreen }
        }
    }

    private var header: some View {
        HStack(spacing: 2) {
            if let path = fence.path {
                Button { onOpenFile(path) } label: { label }
                    .buttonStyle(PressDim())
                    .accessibilityLabel(fence.spokenLabel)
                    .accessibilityHint("Opens the file")
            } else {
                label
            }
            Spacer(minLength: Spacing.snug)
            Button { UIPasteboard.general.string = text } label: {
                Image(systemName: "doc.on.doc").frame(width: 32, height: 32)
            }
            .accessibilityLabel("Copy code")
            Button { expanded = true } label: {
                Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 32, height: 32)
            }
            .accessibilityLabel("View code full screen")
        }
        .foregroundStyle(Theme.muted)
        .padding(.horizontal, 10)
        .padding(.vertical, Spacing.tight)
    }

    /// Name over path: a transcript is read for *which* file, and a phone card
    /// has one line to say it — the call `formatFileChipLabel` already makes on
    /// the Mac, with the directory kept in the accessible name. The range holds
    /// its width so the name is what gives when the two do not fit.
    private var label: some View {
        HStack(spacing: 6) {
            Text(fence.title)
                .typeStyle(.footnote, weight: .semibold, mono: fence.path != nil)
                .foregroundStyle(fence.path == nil ? Theme.muted : Theme.mutedStrong)
                .lineLimit(1)
                .truncationMode(.tail)
            if let range = fence.range {
                Text(range)
                    .typeStyle(.footnote, monospacedDigit: true)
                    .foregroundStyle(Theme.muted)
                    .fixedSize()
            }
        }
    }

    private var fullScreen: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) { code.padding(16) }
                .background(Theme.ground)
                .navigationTitle(fence.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Done") { expanded = false } }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { UIPasteboard.general.string = text } label: {
                            Label("Copy", systemImage: "doc.on.doc")
                        }
                    }
                }
        }
    }

    private var code: some View {
        Text(text)
            .typeStyle(.footnote, mono: true)
            .foregroundStyle(Theme.ink)
            .textSelection(.enabled)
            .fixedSize(horizontal: true, vertical: true)
    }
}
