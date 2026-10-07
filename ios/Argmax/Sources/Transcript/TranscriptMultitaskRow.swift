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

enum TranscriptMultitaskDisplayStatus: Equatable {
    case running
    case done
    case needsYou
    case failed
    case stopped
}

/// Session state is authoritative; attention can claim the reader mid-turn.
func transcriptMultitaskDisplayStatus(
    state: String?,
    attention: AttentionState? = nil
) -> TranscriptMultitaskDisplayStatus {
    if state == "failed" { return .failed }
    if state == "cancelled" { return .stopped }
    if state == "blocked" { return .needsYou }
    if let attention {
        switch attention {
        case .approvalNeeded, .questionAsked, .blocked: return .needsYou
        default: break
        }
    }
    if state == "complete" { return .done }
    return .running
}

func transcriptMultitaskStatus(
    _ state: String?,
    attention: AttentionState? = nil
) -> (label: String, status: TranscriptToolStatus) {
    switch transcriptMultitaskDisplayStatus(state: state, attention: attention) {
    case .done: return ("Completed", .done)
    case .stopped: return ("Stopped", .failed)
    case .failed: return ("Failed", .failed)
    case .needsYou: return ("Waiting for you", .running)
    case .running: return ("Running", .running)
    }
}

enum TranscriptComposerMultitasks {
    static func notices(from items: [TranscriptItem]) -> [TranscriptMultitask] {
        items.compactMap { item in
            guard case .multitask(let multitask) = item else { return nil }
            return multitask
        }
    }

    static func visible(
        _ multitasks: [TranscriptMultitask],
        sessions: [SessionSummary],
        defaults: UserDefaults = .standard
    ) -> [TranscriptMultitask] {
        multitasks.filter { multitask in
            guard let childID = multitask.childSessionId else { return true }
            if !TranscriptMultitaskDismissals.contains(childID, defaults: defaults) { return true }
            let session = sessions.first { $0.id == childID }
            let status = transcriptMultitaskDisplayStatus(
                state: session?.state.rawWire ?? multitask.state,
                attention: session?.attention
            )
            return status == .running || status == .needsYou
        }
    }
}

struct TranscriptMultitaskRow: View {
    let multitask: TranscriptMultitask
    let liveState: String?
    let liveLabel: String?
    let liveAttention: AttentionState?
    let client: BridgeClient
    let onLoad: (String) async throws -> TranscriptMultitaskDetailSnapshot
    var onOpenFile: (String) -> Void = { _ in }
    var onOpenFullChat: ((String) -> Void)?
    /// When true, the row is one lane inside the composer stack — no outer card.
    var embedInComposerLane = false

    @State private var showingDetail = false
    @State private var dismissed: Bool
    @State private var stopping = false
    @State private var failure: String?

    private var resolvedWireState: String? { liveState ?? multitask.state }

    private var state: (label: String, status: TranscriptToolStatus) {
        transcriptMultitaskStatus(resolvedWireState, attention: liveAttention)
    }

    private var displayStatus: TranscriptMultitaskDisplayStatus {
        transcriptMultitaskDisplayStatus(state: resolvedWireState, attention: liveAttention)
    }

    private var taskLabel: String {
        let current = liveLabel?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return current.isEmpty ? multitask.taskLabel : current
    }

    init(
        multitask: TranscriptMultitask,
        liveState: String? = nil,
        liveLabel: String? = nil,
        liveAttention: AttentionState? = nil,
        client: BridgeClient,
        onLoad: @escaping (String) async throws -> TranscriptMultitaskDetailSnapshot,
        onOpenFile: @escaping (String) -> Void = { _ in },
        onOpenFullChat: ((String) -> Void)? = nil,
        embedInComposerLane: Bool = false
    ) {
        self.multitask = multitask
        self.liveState = liveState
        self.liveLabel = liveLabel
        self.liveAttention = liveAttention
        self.client = client
        self.onLoad = onLoad
        self.onOpenFile = onOpenFile
        self.onOpenFullChat = onOpenFullChat
        self.embedInComposerLane = embedInComposerLane
        let persisted = multitask.childSessionId.map { TranscriptMultitaskDismissals.contains($0) } ?? false
        let resolvedState = liveState ?? multitask.state
        let status = transcriptMultitaskDisplayStatus(state: resolvedState, attention: liveAttention)
        _dismissed = State(initialValue: persisted && status != .running && status != .needsYou)
    }

    var body: some View {
        if !dismissed {
            HStack(alignment: .top, spacing: Spacing.tight) {
                Button {
                    showingDetail = multitask.childSessionId != nil
                } label: {
                    VStack(alignment: .leading, spacing: Spacing.tight) {
                        Text(taskLabel)
                            .typeSubtitle(weight: .medium)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: Spacing.tight) {
                            if state.status == .running {
                                WorkingNest(size: 14)
                                    .accessibilityHidden(true)
                            } else {
                                Image(systemName: state.status == .failed ? "exclamationmark.circle" : "checkmark.circle")
                                    .typeSymbol(.footnote)
                                    .accessibilityHidden(true)
                            }
                            Text(state.label)
                                .typeStyle(.footnote)
                        }
                        .foregroundStyle(agentStatusColor(state.status))
                        if state.status != .running,
                           let preview = transcriptMultitaskAnswerPreview(multitask.answer) {
                            Text(preview)
                                .typeMeta()
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let failure {
                            Text(failure).typeStyle(.footnote).foregroundStyle(Theme.rose)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, Spacing.snug)
                    .contentShape(.rect)
                }
                .buttonStyle(PressDim())
                .disabled(multitask.childSessionId == nil)
                .accessibilityLabel("Open multitask: \(taskLabel), \(state.label)")
                .accessibilityValue(failure ?? (state.status == .running ? "" : transcriptMultitaskAnswerPreview(multitask.answer) ?? ""))

                if displayStatus == .running || displayStatus == .needsYou,
                   let childSessionID = multitask.childSessionId {
                    Button {
                        stop(childSessionID)
                    } label: {
                        Group {
                            if stopping {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "stop.fill")
                                    .typeSymbol(.footnote)
                            }
                        }
                        .frame(width: 44, height: 44)
                        .contentShape(.rect)
                    }
                    .buttonStyle(PressDim())
                    .foregroundStyle(Theme.stop)
                    .disabled(stopping)
                    .accessibilityLabel("Stop multitask: \(taskLabel)")
                } else if displayStatus != .running {
                    Button {
                        dismissRow()
                    } label: {
                        Image(systemName: "xmark")
                            .typeSymbol(.caption, weight: .medium)
                            .frame(width: 44, height: 44)
                            .contentShape(.rect)
                    }
                    .buttonStyle(PressDim())
                    .foregroundStyle(Theme.muted)
                    .accessibilityLabel("Dismiss multitask: \(taskLabel)")
                }
            }
            .padding(.horizontal, embedInComposerLane ? Spacing.row : Spacing.row)
            .padding(.vertical, Spacing.tight)
            .frame(minHeight: embedInComposerLane ? 52 : 60)
            .background {
                if !embedInComposerLane {
                    Theme.raised
                        .clipShape(.rect(cornerRadius: Radius.card, style: .continuous))
                }
            }
            .contentShape(.rect)
            .onLongPressGesture(minimumDuration: 0.45) {
                guard displayStatus != .running else { return }
                dismissRow()
            }
            .accessibilityAction(named: "Dismiss") {
                guard displayStatus != .running else { return }
                dismissRow()
            }
            .sheet(isPresented: $showingDetail) {
                if let childSessionID = multitask.childSessionId {
                    TranscriptMultitaskDetail(
                        title: taskLabel,
                        childSessionID: childSessionID,
                        client: client,
                        onLoad: onLoad,
                        onOpenFile: onOpenFile,
                        onOpenFullChat: onOpenFullChat,
                        onDismiss: { showingDetail = false }
                    )
                }
            }
            .onChange(of: displayStatus) {
                if displayStatus == .running || displayStatus == .needsYou { dismissed = false }
            }
        }
    }

    private func dismissRow() {
        if let childSessionID = multitask.childSessionId {
            TranscriptMultitaskDismissals.dismiss(childSessionID)
        }
        dismissed = true
        Haptics.selection()
    }

    private func stop(_ sessionID: String) {
        guard !stopping else { return }
        stopping = true
        failure = nil
        Task {
            do {
                _ = try await client.terminateSession(sessionID: sessionID)
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
    @State private var following = true
    @State private var scrollRequest = 0
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
                        WorkingNest(size: 24, tint: Theme.muted)
                            .accessibilityLabel("Loading multitask")
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if let snapshot {
                        VStack(spacing: 0) {
                            if let displayedFailure {
                                Text(displayedFailure)
                                    .typeStyle(.footnote)
                                    .foregroundStyle(Theme.rose)
                                    .accessibilityLabel("Action failed. \(displayedFailure)")
                                    .screenGutter()
                            }
                            NativeTranscriptList(
                                items: MobileTranscriptRow.rows(
                                    snapshot.items, detail: detail,
                                    latestTurnIsLive: snapshot.sendContext.isRunning
                                ),
                                sessionID: childSessionID,
                                scrollRequest: scrollRequest,
                                turnAnchorID: turnAnchorID,
                                presentationID: String(detail.rawValue),
                                following: $following
                            ) { row in
                                MobileTranscriptRowView(row: row) { item in
                                    detailRow(item, context: snapshot.sendContext)
                                }
                            }
                            .environment(\.transcriptWorkspacePath, snapshot.workspacePath)
                            .overlay(alignment: .bottom) {
                                if !following && !snapshot.items.isEmpty {
                                    Button { scrollRequest += 1 } label: {
                                        Label {
                                            Text("Jump to latest").typeStyle(.footnote, weight: .medium)
                                        } icon: {
                                            Image(systemName: "arrow.down").typeSymbol(.footnote, weight: .medium)
                                        }
                                        .padding(.horizontal, Spacing.row)
                                        .frame(minHeight: 44)
                                        .background(Theme.raised, in: .capsule)
                                        .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                                    }
                                    .buttonStyle(PressDim())
                                    .padding(.bottom, Spacing.snug)
                                }
                            }
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
                    HeaderGlyphButton(systemName: "xmark", label: "Close", tint: Theme.muted) {
                        onDismiss()
                    }
                }
            }
        }
        .task(id: childSessionID) { await requestReload() }
        .onReceive(dashboard.transcriptChanged) { changed in
            guard changed?.contains(childSessionID) ?? true else { return }
            requestReloadSoon()
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    @Environment(\.accentTint) private var accent

    private var displayedFailure: String? {
        actions.failure ?? failure
    }

    private var turnAnchorID: String? {
        for item in (snapshot?.items ?? []).reversed() {
            if case .user(let message) = item, !message.isSteering { return message.id }
        }
        return nil
    }

    @ViewBuilder
    private func detailRow(_ item: TranscriptItem, context: TranscriptSendContext) -> some View {
        switch item {
        case .question(let question) where question.isOutstanding
            && !dismissedQuestions.contains(question.id):
            TranscriptQuestionDock(
                card: question,
                onAnswer: { response in
                    let sent = await actions.answerQuestion(
                        response,
                        card: question,
                        context: context
                    )
                    if sent {
                        dismissedQuestions.insert(question.id)
                        await requestReload()
                    }
                    return sent
                },
                onDismiss: {
                    let resolved = await actions.dismissQuestion(card: question, context: context)
                    if resolved {
                        dismissedQuestions.insert(question.id)
                        await requestReload()
                        composerFocused = true
                    }
                    return resolved
                }
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
            // Each read is the whole sub-transcript, so a streaming child
            // refetches at most once a second instead of once per chunk.
            if reloadRequested { try? await Task.sleep(for: .seconds(1)) }
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
        // The keyboard leaves with the message, as in the chat composer.
        composerFocused = false
        Task {
            if await actions.sendMessage(text, context: context) {
                draft = ""
                Haptics.success()
                await requestReload()
            } else {
                Haptics.error()
            }
            sending = false
        }
    }
}

/// Multitasks pinned above the composer (and above queued follow-ups), matching
/// the desktop checks lane rather than scrolling away in the transcript.
struct TranscriptComposerMultitaskSection: View {
    let multitasks: [TranscriptMultitask]
    let client: BridgeClient
    let onLoad: (String) async throws -> TranscriptMultitaskDetailSnapshot
    var onOpenFile: (String) -> Void = { _ in }
    var onOpenFullChat: ((String) -> Void)?

    @EnvironmentObject private var store: DashboardStore
    @State private var expanded = true

    private static let openGroupMaxRows = 3

    var body: some View {
        if !multitasks.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if multitasks.count > 1 {
                    Button {
                        withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                    } label: {
                        HStack(spacing: Spacing.tight) {
                            Image(systemName: "rectangle.split.2x1")
                                .typeSymbol(.caption2)
                                .foregroundStyle(Theme.muted)
                                .accessibilityHidden(true)
                            Text("Alongside")
                                .typeStyle(.caption2, weight: .semibold)
                                .foregroundStyle(Theme.mutedStrong)
                            Text(summary)
                                .typeStyle(.caption2)
                                .foregroundStyle(Theme.muted)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.down")
                                .typeSymbol(.caption2, weight: .semibold)
                                .foregroundStyle(Theme.muted)
                                .rotationEffect(.degrees(expanded ? 0 : -90))
                                .accessibilityHidden(true)
                        }
                        .padding(.horizontal, Spacing.row)
                        .padding(.vertical, Spacing.tight + 2)
                        .frame(minHeight: 40, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Alongside multitasks, \(summary)")
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                }

                if expanded || multitasks.count == 1 {
                    ForEach(Array(multitasks.enumerated()), id: \.element.id) { index, multitask in
                        if index > 0 {
                            HairlineDivider().padding(.leading, Spacing.row)
                        }
                        let live = liveSession(for: multitask)
                        TranscriptMultitaskRow(
                            multitask: multitask,
                            liveState: live?.state.rawWire,
                            liveLabel: live?.taskLabel,
                            liveAttention: live?.attention,
                            client: client,
                            onLoad: onLoad,
                            onOpenFile: onOpenFile,
                            onOpenFullChat: onOpenFullChat,
                            embedInComposerLane: true
                        )
                        .accessibilityIdentifier("composer-multitask-\(multitask.id)")
                    }
                }
            }
            .background(Theme.raised, in: .rect(cornerRadius: Radius.composer, style: .continuous))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("composer-multitask-lane")
            .onAppear {
                expanded = multitasks.count <= Self.openGroupMaxRows
            }
            .onChange(of: multitasks.count) {
                if multitasks.count <= Self.openGroupMaxRows { expanded = true }
            }
        }
    }

    private var summary: String {
        var running = 0
        var needsYou = 0
        var done = 0
        var failed = 0
        var stopped = 0
        for multitask in multitasks {
            let live = liveSession(for: multitask)
            switch transcriptMultitaskDisplayStatus(
                state: live?.state.rawWire ?? multitask.state,
                attention: live?.attention
            ) {
            case .running: running += 1
            case .needsYou: needsYou += 1
            case .done: done += 1
            case .failed: failed += 1
            case .stopped: stopped += 1
            }
        }
        return [
            running > 0 ? "\(running) running" : nil,
            needsYou > 0 ? "\(needsYou) needs you" : nil,
            failed > 0 ? "\(failed) failed" : nil,
            stopped > 0 ? "\(stopped) stopped" : nil,
            done > 0 ? "\(done) finished" : nil
        ].compactMap { $0 }.joined(separator: " · ")
    }

    private func liveSession(for multitask: TranscriptMultitask) -> (state: SessionState, attention: AttentionState, taskLabel: String?)? {
        guard let childID = multitask.childSessionId,
              let session = store.snapshot.sessions.first(where: { $0.id == childID })
        else { return nil }
        let label = store.snapshot.workspaces.first(where: { $0.id == session.workspaceId })?.taskLabel
        return (session.state, session.attention, label)
    }
}
