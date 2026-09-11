import SwiftUI

struct NativeTranscriptView: View {
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    let onRevisePlan: () -> Void
    @EnvironmentObject private var transcript: TranscriptStore
    @EnvironmentObject private var appearance: Appearance
    @EnvironmentObject private var navigator: ChatNavigator
    @Environment(\.transcriptWorkspacePath) private var workspacePath
    @State private var following = true
    @State private var scrollRequest = 0

    private var rows: [MobileTranscriptRow] {
        MobileTranscriptRow.rows(transcript.items.filter { item in
            if case .question = item { return false }
            return true
        }, detail: appearance.chatDetail)
    }

    /// The last row owns the turn's live work while the session runs.
    private var tailIsLive: Bool {
        transcript.session?.state == .running && transcript.connection == .live
    }

    private var thinking: TranscriptThinking? {
        guard transcript.phase == .ready, transcript.connection == .live else { return nil }
        return transcript.thinkingStart
            ?? TranscriptThinking.current(items: transcript.items, session: transcript.session)
    }

    var body: some View {
        let rows = rows
        let liveRowID = tailIsLive ? rows.last?.id : nil
        return VStack(spacing: 0) {
            if case .failed(let message) = transcript.phase {
                HStack(alignment: .top, spacing: Spacing.snug) {
                    Text(message).typeStyle(.footnote).foregroundStyle(Theme.rose)
                    Spacer(minLength: 0)
                    Button("Retry") { Task { await transcript.reload() } }
                        .typeStyle(.footnote, weight: .semibold)
                        .frame(minHeight: 44)
                }
                .screenGutter()
                .accessibilityElement(children: .contain)
            }
            NativeTranscriptList(
                items: rows,
                sessionID: transcript.session?.sessionId ?? "",
                scrollRequest: scrollRequest,
                presentationID: appearance.tint.rawValue + appearance.bubbleTint + (workspacePath ?? "") + String(appearance.chatDetail.rawValue),
                following: $following
            ) { row in
                MobileTranscriptRowView(row: row) { item in
                TranscriptContentRow(item: item, client: client,
                                     onOpenFile: onOpenFile, onRevisePlan: onRevisePlan,
                                     onOpenSession: { navigator.awaitingSessionID = $0 })
                }
                    .padding(.vertical, row.verticalPadding)
                    .environment(\.transcriptTailIsLive, row.id == liveRowID)
            } footer: {
                TranscriptThinkingLabel(thinking: thinking)
                    .id(thinking)
                    .padding(.vertical, Spacing.snug)
            }
            .overlay(alignment: .bottom) {
                if !following && !rows.isEmpty {
                    Button {
                        scrollRequest += 1
                    } label: {
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
            .overlay {
                if transcript.phase == .ready && rows.isEmpty {
                    Text("Send a message to start the conversation.")
                        .typeStyle(.body)
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                        .screenGutter()
                        .allowsHitTesting(false)
                }
            }
        }
        .onChange(of: transcript.session?.sessionId) { following = true }
    }
}

struct TranscriptContentRow: View {
    let item: TranscriptItem
    let client: BridgeClient
    let onOpenFile: (String) -> Void
    var onRevisePlan: () -> Void = {}
    var onOpenSession: ((String) -> Void)?

    var body: some View {
        switch item {
        case .user(let message), .assistant(let message):
            TranscriptMessageRow(message: message, client: client, onOpenFile: onOpenFile)
        case .thought(let thought):
            TranscriptThoughtRow(thought: thought, client: client, onOpenFile: onOpenFile)
        case .tools(let group):
            TranscriptToolsRow(group: group, onOpenFile: onOpenFile)
        case .todo(let list):
            TranscriptTodoRow(list: list)
        case .notice(let notice):
            Text(notice.text)
                .typeStyle(.footnote)
                .foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, alignment: .center)
        case .error(let error):
            Label {
                Text(error.message).textSelection(.enabled).typeStyle(.footnote)
            } icon: {
                Image(systemName: "exclamationmark.circle").typeSymbol(.footnote)
            }
            .foregroundStyle(Theme.rose)
            .padding(Spacing.row)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.rose.opacity(0.08), in: .rect(cornerRadius: Radius.control))
        case .question:
            EmptyView()
        case .plan, .approval, .agents, .multitask:
            TranscriptInteractiveRow(item: item, client: client,
                                     onOpenFile: onOpenFile, onRevisePlan: onRevisePlan,
                                     onOpenSession: onOpenSession)
        }
    }
}

struct TranscriptComposerFloor: View {
    let workspaceID: String
    /// Full height of the screen the floor sits in, measured outside the safe
    /// area insets so it does not move when the dock grows.
    let screenHeight: CGFloat
    @Binding var draft: String
    @Binding var focusRequest: Int
    @EnvironmentObject private var transcript: TranscriptStore
    @EnvironmentObject private var dashboard: DashboardStore
    @StateObject private var interactions: TranscriptInteractionCoordinator
    @State private var dismissed: Set<String> = []
    @State private var dockHeight: CGFloat = 0

    init(workspaceID: String, client: BridgeClient, screenHeight: CGFloat,
         draft: Binding<String>, focusRequest: Binding<Int>) {
        self.workspaceID = workspaceID
        self.screenHeight = screenHeight
        _draft = draft
        _focusRequest = focusRequest
        _interactions = StateObject(wrappedValue: TranscriptInteractionCoordinator(client: client))
    }

    /// The dock keeps its slot at the bottom but may grow up over most of the
    /// screen, so a question with long options is read in place instead of
    /// scrolled inside a short window. A peek of the transcript stays above it.
    private var dockCeiling: CGFloat {
        screenHeight > 0 ? screenHeight * 0.72 : 380
    }

    private var question: TranscriptQuestionCard? {
        transcript.items.reversed().compactMap { item in
            guard case .question(let card) = item, card.isOutstanding,
                  !dismissed.contains(card.id) else { return nil }
            return card
        }.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if let question {
                ScrollView {
                    TranscriptQuestionDock(card: question, onAnswer: { response in
                        guard let context = sendContext else { return false }
                        let sent = await interactions.answerQuestion(
                            response,
                            card: question,
                            context: context
                        )
                        if sent {
                            dismissed.insert(question.id)
                            await transcript.reload()
                        }
                        return sent
                    }, onDismiss: {
                        guard let context = sendContext else { return false }
                        let resolved = await interactions.dismissQuestion(card: question, context: context)
                        if resolved {
                            dismissed.insert(question.id)
                            await transcript.reload()
                            focusRequest += 1
                        }
                        return resolved
                    })
                    .id(question.id)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { dockHeight = $0 }
                }
                // maxHeight, not height: the scroll view is greedy, so it takes
                // the question's own height, and gives the space back when the
                // keyboard leaves it less room than that.
                .frame(maxHeight: min(dockHeight > 0 ? dockHeight : dockCeiling, dockCeiling))
                .scrollBounceBehavior(.basedOnSize)
                if let failure = interactions.failure {
                    Text(failure).typeStyle(.footnote).foregroundStyle(Theme.rose).screenGutter()
                }
            }
            // Keep the composer mounted while a question occupies its slot.
            // A draft, image selection, or model choice must survive dismissal.
            TranscriptComposer(workspaceID: workspaceID, input: $draft,
                               focusRequest: focusRequest, isObscured: question != nil)
                .frame(height: question == nil ? nil : 0)
                .clipped()
                .opacity(question == nil ? 1 : 0)
                .allowsHitTesting(question == nil)
                .accessibilityHidden(question != nil)
        }
    }

    private var sendContext: TranscriptSendContext? {
        guard let composer = transcript.composer else { return nil }
        return TranscriptSendContext(
            sessionID: composer.sessionId,
            provider: composer.provider,
            modelLabel: composer.modelLabel,
            modelID: composer.modelId,
            reasoningEffort: composer.effort,
            agentMode: dashboard.snapshot.sessions.first { $0.id == composer.sessionId }?.agentMode ?? "auto",
            isRunning: composer.running
        )
    }
}
