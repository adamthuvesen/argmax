import SwiftUI

struct TranscriptAgentGroupView: View {
    let group: TranscriptAgentGroup
    let client: BridgeClient
    let onLoadEvents: (TranscriptAgent) async throws -> [TranscriptItem]
    var onOpenFile: (String) -> Void = { _ in }

    @State private var selectedAgent: TranscriptAgent?

    var body: some View {
        VStack(spacing: Spacing.tight) {
            ForEach(group.agents) { agent in
                Button {
                    Haptics.light()
                    selectedAgent = agent
                } label: {
                    HStack(spacing: Spacing.row) {
                        agentMark(agent)
                            .frame(width: 24, height: 24)
                        VStack(alignment: .leading, spacing: Spacing.hair) {
                            // A named agent projects its codename as its name,
                            // so the second line here only ever repeated it.
                            Text(agentTitle(agent))
                                .typeStyle(.footnote, weight: .medium)
                                .foregroundStyle(Theme.ink)
                                .lineLimit(2)
                            Text(agentStatusLabel(agent.status))
                                .typeStyle(.footnote)
                                .foregroundStyle(agentStatusColor(agent.status))
                        }
                        Spacer(minLength: Spacing.snug)
                        Image(systemName: "chevron.right")
                            .typeSymbol(.caption, weight: .semibold)
                            .foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, Spacing.row)
                    .padding(.vertical, Spacing.snug)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(PressDim())
                .accessibilityLabel("Open agent: \(agentTitle(agent)), \(agentStatusLabel(agent.status))")

                if agent.id != group.agents.last?.id {
                    HairlineDivider(inset: 36)
                }
            }
        }
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        .sheet(item: $selectedAgent) { agent in
            TranscriptAgentDetail(
                agent: agent,
                client: client,
                onLoadEvents: onLoadEvents,
                onOpenFile: onOpenFile,
                onDismiss: { selectedAgent = nil }
            )
        }
        .onChange(of: group.agents) { _, agents in
            guard let selectedAgent else { return }
            self.selectedAgent = agents.first { $0.id == selectedAgent.id }
        }
    }

    @ViewBuilder
    private func agentMark(_ agent: TranscriptAgent) -> some View {
        if agent.status == .running {
            WorkingNest(size: 18)
        } else {
            Image(systemName: agent.status == .failed ? "exclamationmark.circle.fill" : "circle.hexagongrid.fill")
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(agentStatusColor(agent.status))
                .accessibilityHidden(true)
        }
    }
}

/// What to call an agent on a card and over its sheet.
///
/// Without a codename the name is the first slice of the prompt, and a prompt
/// that opens with an attachment token used to put `[local_image:/Users/…]`
/// in the navigation bar — a file path where the reader looks for a task.
func agentTitle(_ agent: TranscriptAgent) -> String {
    if let codename = agent.agentCodename, !codename.isEmpty { return codename }
    let stripped = agent.name.replacing(/\[[a-z_]+:[^\]]*\]/, with: " ")
    let title = stripped
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")
    return title.isEmpty ? "Delegated work" : title
}

func agentStatusLabel(_ status: TranscriptToolStatus) -> String {
    switch status {
    case .running: return "Running"
    case .done: return "Completed"
    case .failed: return "Failed"
    }
}

func agentStatusColor(_ status: TranscriptToolStatus) -> Color {
    switch status {
    case .running: return Theme.muted
    case .done: return Theme.sage
    case .failed: return Theme.rose
    }
}
