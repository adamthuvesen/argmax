import SwiftUI

struct TranscriptMessageRow: View {
    let message: TranscriptMessage
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    @EnvironmentObject private var appearance: Appearance
    @Environment(\.accentTint) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            if message.isSteering {
                Label("Sent during the turn", systemImage: "arrow.turn.down.right")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
            TranscriptMarkdown(text: message.text, client: client, onOpenFile: onOpenFile)
            if !message.attachments.isEmpty {
                TranscriptAttachmentStrip(attachments: message.attachments, client: client,
                                          onOpenFile: onOpenFile)
            }
            if let origin = message.originLabel {
                Text(origin).font(.caption).foregroundStyle(Theme.muted)
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
}

struct TranscriptThoughtRow: View {
    let thought: TranscriptThought
    let client: BridgeClient
    let onOpenFile: (String) -> Void

    var body: some View {
        DisclosureGroup {
            TranscriptMarkdown(text: thought.text, client: client, onOpenFile: onOpenFile)
                .padding(.top, Spacing.snug)
        } label: {
            Label(thought.isStreaming ? "Thinking" : "Thought process", systemImage: "sparkle")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .frame(minHeight: 44)
        }
        .tint(Theme.muted)
    }
}

struct TranscriptToolsRow: View {
    let group: TranscriptToolGroup
    let onOpenFile: (String) -> Void

    private var running: Bool { group.tools.contains { $0.status == .running } }
    private var failed: Int { group.tools.filter { $0.status == .failed }.count }

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: Spacing.snug) {
                ForEach(group.tools) { tool in
                    TranscriptToolRow(tool: tool, onOpenFile: onOpenFile)
                }
            }
        } label: {
            HStack(spacing: Spacing.snug) {
                if running { WorkingNest(size: 16) }
                else { Image(systemName: failed > 0 ? "exclamationmark.circle" : "checkmark") }
                Text(summary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .font(.footnote)
            .foregroundStyle(failed > 0 ? Theme.rose : Theme.muted)
            .frame(minHeight: 44)
            .contentShape(.rect)
        }
        .tint(Theme.muted)
    }

    private var summary: String {
        if failed > 0 { return "\(failed) failed · \(group.tools.count) actions" }
        if running, let tool = group.tools.last(where: { $0.status == .running }) {
            return tool.summary.isEmpty ? tool.name : tool.summary
        }
        if group.tools.count == 1, let tool = group.tools.first {
            return tool.summary.isEmpty ? tool.name : tool.summary
        }
        return "\(group.tools.count) actions completed"
    }
}

private struct TranscriptToolRow: View {
    let tool: TranscriptTool
    let onOpenFile: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: Spacing.row) {
                    if let input = tool.input, !input.isEmpty { detail("Input", input) }
                    if let output = tool.output, !output.isEmpty { detail("Output", output) }
                    if let error = tool.error, !error.isEmpty {
                        Text(error).foregroundStyle(Theme.rose).textSelection(.enabled)
                    }
                }
                .padding(.vertical, Spacing.snug)
            } label: {
                Label(tool.summary.isEmpty ? tool.name : tool.summary,
                      systemImage: tool.status == .failed ? "exclamationmark.circle" : "terminal")
                    .font(.footnote)
                    .foregroundStyle(tool.status == .failed ? Theme.rose : Theme.ink)
                    .lineLimit(3)
                    .frame(minHeight: 44)
            }
            if let path = tool.filePath {
                Button { onOpenFile(path) } label: {
                    Label(path, systemImage: "doc.text")
                        .font(.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(minHeight: 44)
                }
                .accessibilityLabel("Open \(path)")
            }
        }
        .padding(.horizontal, Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.control))
    }

    private func detail(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            HStack {
                Text(title).font(.caption).foregroundStyle(Theme.muted)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Image(systemName: "doc.on.doc").frame(width: 44, height: 44)
                }
                .accessibilityLabel("Copy \(title.lowercased())")
            }
            // A bounded preview keeps a large command result from turning
            // expansion into a multi-screen scroll through one tool.
            ScrollView([.horizontal, .vertical]) {
                Text(text)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
            }
            .frame(maxHeight: 240)
        }
    }
}

struct TranscriptTodoRow: View {
    let list: TranscriptTodoList

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: Spacing.row) {
                ForEach(list.items) { item in
                    Label(item.text ?? "Task", systemImage: symbol(item.status))
                        .font(.footnote)
                        .foregroundStyle(item.status == .active ? Theme.ink : Theme.muted)
                        .strikethrough(item.status == .cancelled)
                }
            }
            .padding(.bottom, Spacing.snug)
        } label: {
            Text("Plan · \(list.items.filter { $0.status == .done }.count) of \(list.items.count) complete")
                .font(.footnote)
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
