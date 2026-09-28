import Combine
import SwiftUI
import UIKit

/// A native conversation, opened from the chat list.
struct TranscriptScreen: View {
    let row: ChatRow

    @EnvironmentObject private var transcript: TranscriptStore
    @EnvironmentObject private var navigator: ChatNavigator
    @EnvironmentObject private var store: DashboardStore
    @EnvironmentObject private var push: PushDelegate
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var forking = false
    @State private var screenID = UUID()
    @State private var draft = ""
    @State private var draftEdited = false
    @State private var draftFailure: String?
    @State private var draftWrite: Task<Void, Never>?
    @Environment(\.scenePhase) private var scenePhase
    @State private var focusRequest = 0
    @State private var screenHeight: CGFloat = 0
    @State private var keyboardInset: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            NativeTranscriptView(
                client: store.client,
                onOpenFile: { openReview(filePath: $0) },
                onOpenDiff: { openReview(diffPath: $0) }
            )
            .equatable()
            .environment(\.transcriptWorkspacePath,
                         store.snapshot.workspaces.first { $0.id == row.workspace.id }?.path ?? row.workspace.path)
            .background(Theme.ground.ignoresSafeArea())
            .screenHeaderBar { header }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                TranscriptComposerFloor(
                    workspaceID: row.workspace.id,
                    client: store.client,
                    screenHeight: screenHeight,
                    draft: $draft,
                    focusRequest: $focusRequest
                )
                .id(row.session.id)
                .padding(.bottom, keyboardInset)
                .background(Theme.ground)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) {
                keyboardInset = transcriptKeyboardInset(
                    notification: $0,
                    containerBottom: geometry.frame(in: .global).maxY + geometry.safeAreaInsets.bottom
                )
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardInset = 0
            }
        }
        // SwiftUI can retain its keyboard safe area after the keyboard has
        // left, pinning a safe-area inset at the old keyboard top. UIKit's
        // frame notifications above are the single source of keyboard space.
        .ignoresSafeArea(.keyboard)
        // Measured outside the insets, so the question dock's own growth
        // cannot feed back into the height it is allowed to grow to.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .onAppear {
            transcript.claim(screenID, sessionID: row.session.id)
            transcript.receive(snapshot: store.snapshot, authoritative: !store.isCachedSnapshot)
            push.openSessionID = row.session.id
        }
        .task(id: row.session.id) {
            do {
                let saved = try await ComposerDrafts.shared.read(scope: store.client.cacheNamespace, sessionID: row.session.id)
                guard !Task.isCancelled, !draftEdited else { return }
                draft = saved
            } catch { draftFailure = "The saved draft could not be restored." }
        }
        .onChange(of: draft) {
            draftEdited = true
            saveDraft(debounce: true)
        }
        .onChange(of: scenePhase) {
            if scenePhase != .active { saveDraft(debounce: false) }
            // iOS posts keyboard frames to a backgrounded app and can drop
            // the matching hide, which left the composer floating at the old
            // keyboard top on return. No focused field means no keyboard.
            if scenePhase == .active, !UIResponder.isEditingText { keyboardInset = 0 }
        }
        .onDisappear {
            saveDraft(debounce: false)
            if navigator.launchedSessionID == row.session.id { navigator.launchedSessionID = nil }
            guard transcript.relinquish(screenID) else { return }
            if push.openSessionID == row.session.id { push.openSessionID = nil }
        }
        .task(id: viewedActivityKey) {
            guard transcript.phase == .ready, store.connection == .live,
                  let workspace = store.snapshot.workspaces.first(where: { $0.id == row.workspace.id }) else { return }
            await store.markViewed(workspace)
        }
    }

    private func saveDraft(debounce: Bool) {
        guard draftEdited else { return }
        draftWrite?.cancel()
        let text = draft
        let id = row.session.id
        let scope = store.client.cacheNamespace
        draftWrite = Task {
            if debounce {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            }
            do {
                try await ComposerDrafts.shared.write(text, scope: scope, sessionID: id)
                draftFailure = nil
            } catch { draftFailure = "This draft could not be saved on the iPhone." }
        }
    }

    private var viewedActivityKey: String {
        let workspace = store.snapshot.workspaces.first { $0.id == row.workspace.id }
        return "\(workspace?.lastActivityAt ?? "")|\(transcript.phase)|\(store.connection)"
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: Spacing.row) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left")
                        .typeSymbol(.body, weight: .medium)
                        .frame(width: 44, height: 44)
                        .background(headerButtonBackground)
                        .contentShape(.circle)
                }
                .buttonStyle(PressDim())
                .accessibilityLabel("Back")
                VStack(spacing: 2) {
                    Text(title)
                        .typeSubtitle(weight: .semibold)
                        .lineLimit(1)
                        .accessibilityIdentifier("transcript-title")
                        .accessibilityAddTraits(.isHeader)
                    Text(subtitle)
                        .typeStyle(.footnote)
                        .foregroundStyle(Theme.mutedStrong)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .accessibilityIdentifier("transcript-subtitle")
                }
                .frame(maxWidth: .infinity)
                menu
            }
            .foregroundStyle(Theme.ink)
            .frame(minHeight: Spacing.headerHeight)
            .screenGutter()
            .padding(.bottom, Spacing.snug)
            if let draftFailure {
                Text(draftFailure).typeMeta().foregroundStyle(Theme.rose).screenGutter()
            }
        }
        .background(alignment: .top) { HeaderScrollScrim(fadeHeight: 24) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("transcript-header")
    }

    private var headerButtonBackground: some View {
        Circle()
            .fill(Theme.raised.opacity(reduceTransparency ? 1 : 0.92))
            .overlay {
                Circle().strokeBorder(Theme.line.opacity(0.35), lineWidth: 0.5)
            }
            .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
    }

    /// The live count, not the one this screen was pushed with: an agent
    /// writing mid-turn moves it on the dashboard delta.
    private var changedFiles: Int {
        store.snapshot.workspaces.first { $0.id == row.workspace.id }?.changedFiles
            ?? row.workspace.changedFiles
    }

    private func openReview(filePath: String?) {
        navigator.review = ReviewRoute(workspaceID: row.workspace.id, filePath: filePath)
    }

    private func openReview(diffPath: String) {
        navigator.review = ReviewRoute(workspaceID: row.workspace.id, diffPath: diffPath)
    }

    /// Live metadata takes precedence over the row used to open this screen.
    private var title: String {
        let reported = transcript.session?.title
        if let reported, !reported.isEmpty { return reported }
        return row.workspace.taskLabel
    }

    /// Location stays stable while the agent starts and stops. Connection
    /// trouble still takes precedence so a saved transcript is not mistaken
    /// for a live connection to the Mac.
    private var subtitle: String {
        // Refresh status must not change the transcript's safe-area height.
        if case .reconnecting = store.connection { return "Reconnecting to your Mac…" }
        if transcript.showingCachedContent { return "Saved on this iPhone · Waiting for your Mac" }
        let workspace = store.snapshot.workspaces.first { $0.id == row.workspace.id } ?? row.workspace
        guard workspace.kind == .git else { return "Chat" }
        let project = store.snapshot.projects.first { $0.id == workspace.projectId }?.name ?? row.projectName
        return [project, workspace.branch.isEmpty ? nil : workspace.branch]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    @ViewBuilder
    private var menu: some View {
        // A `Menu` rather than a sheet of our own: the long-press lift, the
        // dismissal and the placement are the platform's, and so are its
        // materials and label colours — so the icons read as label colour
        // like every other iOS menu rather than carrying the app tint
        // through, the same as the chat row's context menu.
        Menu {
            Group {
                // Scratch chats have no standing review entry. File links
                // in their transcript can still open individual files.
                if row.workspace.kind == .git {
                    Button(
                        changedFiles > 0 ? "Files and changes (\(changedFiles))" : "Files and changes",
                        systemImage: "arrow.triangle.branch"
                    ) { openReview(filePath: nil) }
                    Divider()
                }
                Button("Fork chat", systemImage: "arrow.triangle.pull") { fork() }
                    .disabled(!isForkable || forking)
                Button("New chat here", systemImage: "plus.bubble") {
                    navigator.newChat = NewChatRequest(workspaceID: row.workspace.id)
                }
                Divider()
                // Phase 5 hands this to the Mac over the bridge; until then it
                // is visible so the menu's shape is honest, and off so it cannot
                // lie.
                Button("Open on Mac", systemImage: "laptopcomputer") {}
                    .disabled(true)
            }
            .tint(Color.primary)
        } label: {
            Image(systemName: "ellipsis")
                .typeSymbol(.body, weight: .semibold)
                .foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44)
                .background(headerButtonBackground)
                .contentShape(.circle)
        }
        .accessibilityLabel("Chat actions")
    }

    /// The same gate the row's context menu and `fork_session` apply: a
    /// provider whose CLI can resume a copied conversation, and never
    /// mid-turn.
    private var isForkable: Bool {
        let capable = ProviderCatalog.bundled.provider(row.session.provider)?.forkCapable ?? false
        let state = transcript.session?.state ?? row.session.state
        return capable && state != .running && state != .waiting
    }

    private func fork() {
        guard !forking else { return }
        forking = true
        Task {
            if let forked = try? await store.client.forkSession(sessionID: row.session.id) {
                navigator.awaitingSessionID = forked.session.id
            } else {
                Haptics.error()
            }
            forking = false
        }
    }


}

func transcriptKeyboardInset(
    notification: Notification,
    containerBottom: CGFloat
) -> CGFloat {
    guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else {
        return 0
    }
    return transcriptKeyboardInset(
        keyboardTop: frame.minY,
        containerBottom: containerBottom
    )
}

func transcriptKeyboardInset(
    keyboardTop: CGFloat,
    containerBottom: CGFloat
) -> CGFloat {
    max(0, containerBottom - keyboardTop)
}

extension UIResponder {
    /// Whether a text input anywhere in the app holds first responder, found
    /// by sending an action down the responder chain — UIKit has no getter.
    @MainActor static var isEditingText: Bool {
        firstResponder = nil
        UIApplication.shared.sendAction(#selector(recordFirstResponder), to: nil, from: nil, for: nil)
        defer { firstResponder = nil }
        return firstResponder is UIKeyInput
    }

    @MainActor private static weak var firstResponder: UIResponder?

    @objc private func recordFirstResponder() {
        UIResponder.firstResponder = self
    }
}
