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
                        // The same rhythm as the main transcript: the stack
                        // itself adds nothing, and each row pays for the air it
                        // needs. Prose wants a gap on both sides; a disclosure
                        // row already carries a 44-point tap target.
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if let failure {
                                Text("Some activity could not be loaded. \(failure)")
                                    .typeStyle(.footnote)
                                    .foregroundStyle(Theme.rose)
                                    .padding(.bottom, Spacing.row)
                            }
                            if items.isEmpty {
                                // Held in the scroll view rather than replacing
                                // it, so a run that has not reported yet is
                                // still a pull away from reporting.
                                EmptyState(
                                    mark: .glyph("circle.hexagongrid"),
                                    message: agent.status == .running
                                        ? "Waiting for agent activity."
                                        : "This provider reported the agent run without child activity."
                                )
                                .containerRelativeFrame(.vertical)
                            }
                            ForEach(MobileTranscriptRow.rows(items, detail: detail)) { row in
                                MobileTranscriptRowView(row: row) { item in
                                    TranscriptAgentActivityRow(
                                        item: item,
                                        client: client,
                                        onOpenFile: openFile
                                    )
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, row.verticalPadding)
                            }
                        }
                        .screenGutter()
                        .padding(.top, Spacing.row)
                        .padding(.bottom, Spacing.gutter)
                    }
                    .refreshable { await requestReload() }
                }
            }
            .background(Theme.ground)
            .navigationTitle(agentTitle(agent))
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
            // Every word in this sheet is the one agent's, so a role chip over
            // each paragraph only repeats itself. The transcript's own message
            // row already distinguishes steering from answer, and it keeps
            // attachments, selection and the copy menu.
            TranscriptMessageRow(message: message, client: client, onOpenFile: onOpenFile)
        case .thought(let thought):
            TranscriptThoughtRow(thought: thought, client: client, onOpenFile: onOpenFile)
        case .tools(let group):
            TranscriptToolsRow(group: group, onOpenFile: onOpenFile)
        case .error(let error):
            Label {
                Text(error.message).typeStyle(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.triangle").typeSymbol(.footnote)
            }
                .foregroundStyle(Theme.rose)
        case .notice(let notice):
            Text(notice.text).typeMeta()
        case .plan(let plan):
            TranscriptMarkdown(text: plan.markdown, client: client, onOpenFile: onOpenFile)
        case .question(let question):
            Text(question.questions.first?.question ?? "Question from agent").typeChrome()
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
            // Named, because an agent that delegated further is the one thing
            // in this sheet the reader cannot open from here.
            Label {
                Text(group.agents.count == 1
                    ? "Delegated to \(group.agents.map(agentTitle).joined())"
                    : "Delegated to \(group.agents.count) agents")
            } icon: {
                Image(systemName: "circle.hexagongrid.fill").typeSymbol(.footnote)
            }
            .typeMeta()
        case .multitask(let multitask):
            Text(multitask.taskLabel).typeMeta()
        }
    }
}
