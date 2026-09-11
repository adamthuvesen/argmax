import SwiftUI

struct TranscriptAgentDetail: View {
    let agent: TranscriptAgent
    let client: BridgeClient
    let onLoadEvents: (TranscriptAgent) async throws -> [TranscriptItem]
    var onOpenFile: (String) -> Void = { _ in }
    let onDismiss: () -> Void

    @State private var items: [TranscriptItem] = []
    @State private var loading = true
    @State private var failure: String?
    @State private var loadInFlight = false
    @State private var reloadRequested = false
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.mobileChatDetail) private var detail

    var body: some View {
        NavigationStack {
            Group {
                if loading && items.isEmpty {
                    VStack(spacing: Spacing.row) {
                        WorkingNest(size: 24)
                        Text("Loading agent activity…").typeMeta()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityElement(children: .combine)
                } else if let failure, items.isEmpty {
                    EmptyState(
                        mark: .glyph("exclamationmark.triangle"),
                        message: failure,
                        action: ("Try again", load)
                    )
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Spacing.row) {
                            if let failure {
                                Text("Some activity could not be loaded. \(failure)")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.rose)
                            }
                            if items.isEmpty {
                                Text(agent.status == .running
                                    ? "Waiting for agent activity."
                                    : "This provider reported the agent run without child activity.")
                                    .typeMeta()
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .padding(.vertical, Spacing.section)
                            }
                            ForEach(MobileTranscriptRow.rows(items, detail: detail)) { row in
                                MobileTranscriptRowView(row: row) { item in
                                TranscriptAgentActivityRow(
                                    item: item,
                                    client: client,
                                    onOpenFile: openFile
                                )
                                }
                            }
                        }
                        .screenGutter()
                        .padding(.vertical, Spacing.row)
                    }
                    .refreshable { await requestReload() }
                }
            }
            .background(Theme.ground)
            .navigationTitle(agent.agentCodename ?? agent.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { onDismiss() }
                }
            }
        }
        .task(id: agent.id) { await requestReload() }
        .onChange(of: dashboard.transcriptRevision) { requestReloadSoon() }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func load() {
        requestReloadSoon()
    }

    private func openFile(_ path: String) {
        onDismiss()
        onOpenFile(path)
    }

    private func requestReloadSoon() {
        Task { await requestReload() }
    }

    private func requestReload() async {
        reloadRequested = true
        guard !loadInFlight else { return }
        loadInFlight = true
        repeat {
            reloadRequested = false
            await reloadOnce()
        } while reloadRequested && !Task.isCancelled
        loadInFlight = false
    }

    private func reloadOnce() async {
        loading = items.isEmpty
        failure = nil
        do {
            items = try await onLoadEvents(agent)
        } catch {
            failure = hostFailureMessage(error)
        }
        loading = false
    }
}

struct TranscriptAgentActivityRow: View {
    let item: TranscriptItem
    let client: BridgeClient
    let onOpenFile: (String) -> Void

    var body: some View {
        switch item {
        case .user(let message), .assistant(let message):
            VStack(alignment: .leading, spacing: Spacing.tight) {
                Text(message.role == .user ? "Steering" : "Agent")
                    .typeChip()
                    .foregroundStyle(Theme.muted)
                TranscriptMarkdown(text: message.text, client: client, onOpenFile: onOpenFile)
            }
        case .thought(let thought):
            TranscriptThoughtRow(thought: thought, client: client, onOpenFile: onOpenFile)
        case .tools(let group):
            TranscriptToolsRow(group: group, onOpenFile: onOpenFile)
        case .error(let error):
            Label(error.message, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(Theme.rose)
        case .notice(let notice):
            Text(notice.text).typeMeta()
        case .plan(let plan):
            TranscriptMarkdown(text: plan.markdown, client: client, onOpenFile: onOpenFile)
        case .question(let question):
            Text(question.questions.first?.question ?? "Question from agent").typeContent()
        case .approval(let approval):
            Label(approval.command, systemImage: "lock.shield").typeMeta()
        case .todo(let list):
            VStack(alignment: .leading, spacing: Spacing.tight) {
                ForEach(list.items) { item in
                    Label(item.text ?? "Untitled task", systemImage: item.status == .done ? "checkmark.circle.fill" : "circle")
                        .typeMeta()
                }
            }
        case .agents(let group):
            Text("\(group.agents.count) nested agent\(group.agents.count == 1 ? "" : "s")").typeMeta()
        case .multitask(let multitask):
            Text(multitask.taskLabel).typeMeta()
        }
    }
}
