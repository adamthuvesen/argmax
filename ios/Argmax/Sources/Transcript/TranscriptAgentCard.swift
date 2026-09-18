import SwiftUI

struct TranscriptAgentGroupView: View {
    let group: TranscriptAgentGroup
    let client: BridgeClient
    let onLoadEvents: (TranscriptAgent) async throws -> [TranscriptItem]
    var onOpenFile: (String) -> Void = { _ in }

    @State private var selectedAgent: TranscriptAgent?
    @Environment(\.activityBeat) private var beat

    /// The card whose work the silence started at, when the group holds the
    /// beat between calls: the same stamp `TranscriptThinking.settledBeat`
    /// reads. The card's words are the band's home — the desktop gave the
    /// band to a subagent's launch row and kept the dot only for list and
    /// roster dots — so a settled group that published a beat nothing could
    /// show would leave the gap between calls with no live line at all.
    /// Static so the projection tests can pin it.
    static func beatAgentID(of group: TranscriptAgentGroup, beat: String?) -> String? {
        guard let beat, beat == group.id else { return nil }
        return group.agents
            .compactMap { agent in agent.completedAt.map { (id: agent.id, at: $0) } }
            .max(by: { $0.at < $1.at })?
            .id
    }

    private func isLive(_ agent: TranscriptAgent) -> Bool {
        Self.isLive(agent, in: group, beat: beat)
    }

    /// Whether this card carries the reading wave. A launch the turn is
    /// blocked on is live work; a backgrounded one is marked running by
    /// inference (`TranscriptAgent.backgroundLaunch`) and takes neither the
    /// beat nor the band. Otherwise live only while the card holds the beat
    /// between calls. Static so the projection tests can pin it.
    static func isLive(
        _ agent: TranscriptAgent,
        in group: TranscriptAgentGroup,
        beat: String?
    ) -> Bool {
        (agent.status == .running && !agent.backgroundLaunch) || agent.id == Self.beatAgentID(of: group, beat: beat)
    }

    var body: some View {
        VStack(spacing: Spacing.tight) {
            ForEach(group.agents) { agent in
                Button {
                    selectedAgent = agent
                } label: {
                    HStack(spacing: Spacing.row) {
                        agentMark(agent)
                            .frame(width: 24, height: 24)
                        VStack(alignment: .leading, spacing: Spacing.hair) {
                            // A named agent projects its codename as its name,
                            // so the second line here only ever repeated it.
                            // The words carry the liveness (a nest beside a
                            // band would mark the same thing twice), so the
                            // status word below holds still, the way the
                            // desktop's launch row holds its status.
                            Text(agentTitle(agent))
                                .readingWave(isLive(agent), restInk: Theme.ink)
                                .typeSubtitle(weight: .medium)
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
        // The nest is the one mark left to a backgrounded launch: no
        // completion for one ever arrives, so its words never wave, and a
        // status mark is the honest reading — alive, somewhere else.
        if agent.status == .running && agent.backgroundLaunch {
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
