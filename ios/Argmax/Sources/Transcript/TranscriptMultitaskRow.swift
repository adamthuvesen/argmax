import SwiftUI

struct TranscriptMultitaskDetailSnapshot: Sendable {
    var items: [TranscriptItem]
    var sendContext: TranscriptSendContext
    var workspacePath: String?
}

enum TranscriptMultitaskDismissals {
    static let key = "argmax.multitask.dismissed"
    static let limit = 200

    static func read(defaults: UserDefaults = .standard) -> [String] {
        defaults.stringArray(forKey: key) ?? []
    }

    static func contains(_ id: String, defaults: UserDefaults = .standard) -> Bool {
        read(defaults: defaults).contains(id)
    }

    static func dismiss(_ id: String, defaults: UserDefaults = .standard) {
        var entries = read(defaults: defaults).filter { $0 != id }
        entries.append(id)
        defaults.set(Array(entries.suffix(limit)), forKey: key)
    }
}

func transcriptMultitaskAnswerPreview(_ answer: String?) -> String? {
    guard let answer else { return nil }
    let ignored = CharacterSet.alphanumerics.inverted
    let line = answer.components(separatedBy: .newlines).lazy
        .map { raw in
            raw
                .replacingOccurrences(of: #"^\s*(?:[#>*+-]+\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
                .replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "$1", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        .first { line in
            line != "(no answer)" && line.unicodeScalars.contains { !ignored.contains($0) }
        }
    guard let line else { return nil }
    if line.count <= 120 { return line }
    return String(line.prefix(119)).trimmingCharacters(in: .whitespaces) + "…"
}

func transcriptMultitaskStatus(_ state: String?) -> (label: String, status: TranscriptToolStatus) {
    switch state {
    case "complete": return ("Completed", .done)
    case "cancelled": return ("Stopped", .failed)
    case "failed": return ("Failed", .failed)
    case "blocked": return ("Waiting for you", .running)
    default: return ("Running", .running)
    }
}

struct TranscriptMultitaskRow: View {
    let multitask: TranscriptMultitask
    let client: BridgeClient
    let onLoad: (String) async throws -> TranscriptMultitaskDetailSnapshot
    var onOpenFile: (String) -> Void = { _ in }
    var onOpenFullChat: ((String) -> Void)?

    @State private var showingDetail = false
    @State private var dismissed: Bool
    @State private var stopping = false
    @State private var failure: String?

    private var state: (label: String, status: TranscriptToolStatus) {
        transcriptMultitaskStatus(multitask.state)
    }

    init(
        multitask: TranscriptMultitask,
        client: BridgeClient,
        onLoad: @escaping (String) async throws -> TranscriptMultitaskDetailSnapshot,
        onOpenFile: @escaping (String) -> Void = { _ in },
        onOpenFullChat: ((String) -> Void)? = nil
    ) {
        self.multitask = multitask
        self.client = client
        self.onLoad = onLoad
        self.onOpenFile = onOpenFile
        self.onOpenFullChat = onOpenFullChat
        let persisted = multitask.childSessionId.map { TranscriptMultitaskDismissals.contains($0) } ?? false
        _dismissed = State(initialValue: persisted && transcriptMultitaskStatus(multitask.state).status != .running)
    }

    var body: some View {
        if !dismissed {
            HStack(spacing: Spacing.row) {
                if state.status == .running {
                    WorkingNest(size: 18)
                        .frame(width: 24, height: 24)
                } else {
                    Image(systemName: state.status == .failed ? "exclamationmark.circle.fill" : "arrow.triangle.branch")
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(agentStatusColor(state.status))
                        .frame(width: 24, height: 24)
                }

                Button {
                    Haptics.light()
                    showingDetail = multitask.childSessionId != nil
                } label: {
                    VStack(alignment: .leading, spacing: Spacing.hair) {
                        HStack(spacing: Spacing.snug) {
                            Text(multitask.taskLabel)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Theme.ink)
                                .lineLimit(2)
                            Text("Multitask")
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                        }
                        HStack(spacing: Spacing.tight) {
                            Text(state.label)
                                .font(.footnote)
                                .foregroundStyle(agentStatusColor(state.status))
                            if state.status != .running,
                               let preview = transcriptMultitaskAnswerPreview(multitask.answer) {
                                Text("· \(preview)")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.muted)
                                    .lineLimit(1)
                            }
                        }
                        if let failure {
                            Text(failure).font(.caption).foregroundStyle(Theme.rose)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
                }
                .buttonStyle(PressDim())
                .disabled(multitask.childSessionId == nil)
                .accessibilityLabel("Open multitask: \(multitask.taskLabel), \(state.label)")

                if state.status == .running, let childSessionID = multitask.childSessionId {
                    Button {
                        stop(childSessionID)
                    } label: {
                        if stopping {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "stop.fill")
                        }
                    }
                    .frame(width: 44, height: 44)
                    .buttonStyle(PressDim())
                    .foregroundStyle(Theme.stop)
                    .disabled(stopping)
                    .accessibilityLabel("Stop multitask: \(multitask.taskLabel)")
                } else if state.status != .running {
                    Button {
                        Haptics.light()
                        if let childSessionID = multitask.childSessionId {
                            TranscriptMultitaskDismissals.dismiss(childSessionID)
                        }
                        dismissed = true
                    } label: {
                        Image(systemName: "xmark").frame(width: 44, height: 44)
                    }
                    .buttonStyle(PressDim())
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("Dismiss multitask: \(multitask.taskLabel)")
                }
            }
            .padding(.horizontal, Spacing.row)
            .padding(.vertical, Spacing.snug)
            .frame(minHeight: 60)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
            .sheet(isPresented: $showingDetail) {
                if let childSessionID = multitask.childSessionId {
                    TranscriptMultitaskDetail(
                        title: multitask.taskLabel,
                        childSessionID: childSessionID,
                        client: client,
                        onLoad: onLoad,
                        onOpenFile: onOpenFile,
                        onOpenFullChat: onOpenFullChat,
                        onDismiss: { showingDetail = false }
                    )
                }
            }
            .onChange(of: multitask.state) {
                if state.status == .running { dismissed = false }
            }
        }
    }

    private func stop(_ sessionID: String) {
        guard !stopping else { return }
        stopping = true
        failure = nil
        Task {
            do {
                _ = try await client.terminateSession(sessionID: sessionID)
                Haptics.warning()
            } catch {
                failure = hostFailureMessage(error)
            }
            stopping = false
        }
    }
}

private struct TranscriptMultitaskDetail: View {
    let title: String
    let childSessionID: String
    let client: BridgeClient
    let onLoad: (String) async throws -> TranscriptMultitaskDetailSnapshot
    let onOpenFile: (String) -> Void
    let onOpenFullChat: ((String) -> Void)?
    let onDismiss: () -> Void

    @State private var snapshot: TranscriptMultitaskDetailSnapshot?
    @State private var loading = true
    @State private var failure: String?
    @State private var draft = ""
    @State private var sending = false
    @State private var loadInFlight = false
    @State private var reloadRequested = false
    @State private var dismissedQuestions: Set<String> = []
    @StateObject private var actions: TranscriptInteractionCoordinator
    @FocusState private var composerFocused: Bool
    @EnvironmentObject private var dashboard: DashboardStore
    @Environment(\.mobileChatDetail) private var detail

    init(
        title: String,
        childSessionID: String,
        client: BridgeClient,
        onLoad: @escaping (String) async throws -> TranscriptMultitaskDetailSnapshot,
        onOpenFile: @escaping (String) -> Void,
        onOpenFullChat: ((String) -> Void)?,
        onDismiss: @escaping () -> Void
    ) {
        self.title = title
        self.childSessionID = childSessionID
        self.client = client
        self.onLoad = onLoad
        self.onOpenFile = onOpenFile
        self.onOpenFullChat = onOpenFullChat
        self.onDismiss = onDismiss
        _actions = StateObject(wrappedValue: TranscriptInteractionCoordinator(client: client))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Group {
                    if loading && snapshot == nil {
                        ProgressView("Loading multitask…")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let snapshot {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: Spacing.row) {
                                if let displayedFailure {
                                    Text(displayedFailure)
                                        .font(.footnote)
                                        .foregroundStyle(Theme.rose)
                                        .accessibilityLabel("Action failed. \(displayedFailure)")
                                }
                                ForEach(MobileTranscriptRow.rows(snapshot.items, detail: detail)) { row in
                                    MobileTranscriptRowView(row: row) { item in
                                        detailRow(item, context: snapshot.sendContext)
                                    }
                                }
                            }
                            .environment(\.transcriptWorkspacePath, snapshot.workspacePath)
                            .screenGutter()
                            .padding(.vertical, Spacing.row)
                        }
                    } else {
                        EmptyState(
                            mark: .glyph("exclamationmark.triangle"),
                            message: failure ?? "This multitask could not be loaded.",
                            action: ("Try again", load)
                        )
                    }
                }

                if let snapshot {
                    HairlineDivider()
                    HStack(alignment: .bottom, spacing: Spacing.snug) {
                        TextField("Steer or follow up", text: $draft, axis: .vertical)
                            .lineLimit(1...5)
                            .textFieldStyle(.plain)
                            .focused($composerFocused)
                            .padding(.horizontal, Spacing.row)
                            .padding(.vertical, Spacing.snug)
                            .background(Theme.raised, in: .rect(cornerRadius: Radius.control, style: .continuous))
                        Button { send(snapshot.sendContext) } label: {
                            if sending {
                                ProgressView().tint(accent.onAccent)
                            } else {
                                Image(systemName: "arrow.up")
                            }
                        }
                        .frame(width: 44, height: 44)
                        .background(accent.color, in: .circle)
                        .foregroundStyle(accent.onAccent)
                        .buttonStyle(PressDim())
                        .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                        .accessibilityLabel("Send to multitask")
                    }
                    .screenGutter()
                    .padding(.vertical, Spacing.snug)
                }
            }
            .background(Theme.ground)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let onOpenFullChat {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Open chat") {
                            onDismiss()
                            onOpenFullChat(childSessionID)
                        }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { onDismiss() }
                }
            }
        }
        .task(id: childSessionID) { await requestReload() }
        .onChange(of: dashboard.transcriptRevision) { requestReloadSoon() }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @Environment(\.accentTint) private var accent

    private var displayedFailure: String? {
        actions.failure ?? failure
    }

    @ViewBuilder
    private func detailRow(_ item: TranscriptItem, context: TranscriptSendContext) -> some View {
        switch item {
        case .question(let question) where question.isOutstanding
            && !dismissedQuestions.contains(question.id):
            TranscriptQuestionDock(
                card: question,
                onAnswer: { answer in
                    let sent = await actions.answerQuestion(answer, context: context)
                    if sent {
                        dismissedQuestions.insert(question.id)
                        await requestReload()
                    }
                    return sent
                },
                onDismiss: {
                    dismissedQuestions.insert(question.id)
                    composerFocused = true
                }
            )
        case .plan(let plan):
            TranscriptPlanCard(
                plan: plan,
                client: client,
                onOpenFile: openFile,
                onAccept: {
                    let sent = await actions.acceptPlan(context: context)
                    if sent { await requestReload() }
                    return sent
                },
                onRevise: { composerFocused = true }
            )
        case .approval(let approval):
            TranscriptApprovalCard(approval: approval) { resolution in
                let resolved = await actions.resolveApproval(id: approval.id, resolution: resolution)
                if resolved { await requestReload() }
                return resolved
            }
        default:
            TranscriptAgentActivityRow(item: item, client: client, onOpenFile: openFile)
        }
    }

    private func openFile(_ path: String) {
        onDismiss()
        onOpenFile(path)
    }

    private func load() { requestReloadSoon() }

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
        loading = snapshot == nil
        failure = nil
        do {
            snapshot = try await onLoad(childSessionID)
        } catch {
            failure = hostFailureMessage(error)
        }
        loading = false
    }

    private func send(_ context: TranscriptSendContext) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        Task {
            if await actions.sendMessage(text, context: context) {
                draft = ""
                Haptics.success()
                await requestReload()
            } else {
                Haptics.warning()
            }
            sending = false
        }
    }
}
