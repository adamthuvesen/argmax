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
                            HStack(spacing: Spacing.snug) {
                                Text(agent.name.isEmpty ? "Delegated work" : agent.name)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Theme.ink)
                                    .lineLimit(2)
                                if let codename = agent.agentCodename, !codename.isEmpty {
                                    Text(codename)
                                        .font(.caption)
                                        .foregroundStyle(Theme.muted)
                                        .lineLimit(1)
                                }
                            }
                            Text(agentStatusLabel(agent.status))
                                .font(.footnote)
                                .foregroundStyle(agentStatusColor(agent.status))
                        }
                        Spacer(minLength: Spacing.snug)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, Spacing.row)
                    .padding(.vertical, Spacing.snug)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(PressDim())
                .accessibilityLabel("Open agent: \(agent.name), \(agentStatusLabel(agent.status))")

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
