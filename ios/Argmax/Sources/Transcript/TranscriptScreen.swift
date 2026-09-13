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
    @Environment(\.accentTint) private var accent
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
            ) {
                draft = "Please revise the plan: "
                focusRequest += 1
            }
            .environment(\.transcriptWorkspacePath,
                         store.snapshot.workspaces.first { $0.id == row.workspace.id }?.path ?? row.workspace.path)
            .background(Theme.ground.ignoresSafeArea())
            .safeAreaInset(edge: .top, spacing: 0) { header }
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
            ScreenHeader(title: title, subtitle: subtitle, onBack: { dismiss() }) {
                HStack(spacing: Spacing.tight) {
                    changesButton
                    menu
                }
            }
            if let draftFailure { Text(draftFailure).typeMeta().foregroundStyle(Theme.rose) }
            if transcript.showingCachedContent {
                Text("Saved on this iPhone. Updating when your Mac is available.").typeMeta()
            }
            if case .reconnecting = store.connection {
                Label {
                    Text("Reconnecting to your Mac…").typeStyle(.footnote)
                } icon: {
                    Image(systemName: "wifi.slash").typeSymbol(.caption)
                }
                    .foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.snug)
            }
        }
        .background(Theme.ground)
    }

    /// Changes, one tap from the transcript, carrying its own count.
    ///
    /// A side chat runs in an app-owned scratch directory with one empty
    /// commit, so this would open a permanently empty diff and an empty tree.
    /// A file reference tapped in the transcript still opens the review
    /// screen there — only the standing entry point is dropped.
    @ViewBuilder
    private var changesButton: some View {
        if row.workspace.kind == .git {
            Button {
                openReview(filePath: nil)
            } label: {
                GitBranchGlyph()
                    .stroke(
                        Theme.muted,
                        style: StrokeStyle(lineWidth: 17 / 12, lineCap: .round, lineJoin: .round)
                    )
                    .frame(width: 17, height: 17)
                    .frame(width: 32, height: 32)
                    .overlay(alignment: .topTrailing) { changedBadge }
                    .contentShape(.rect)
            }
            .buttonStyle(PressDim())
            .accessibilityLabel(
                changedFiles > 0
                    ? "Files and changes, \(changedFiles) changed"
                    : "Files and changes"
            )
        }
    }

    /// The count the desktop's own button carries. Drawn only when there is
    /// one: a standing "0" is a number the eye has to dismiss on every glance.
    @ViewBuilder
    private var changedBadge: some View {
        if changedFiles > 0 {
            Text(verbatim: changedFiles > 99 ? "99+" : "\(changedFiles)")
                // A badge numeral, below every text style: caption2 is the
                // nearest step, so it scales with the smallest type.
                .typeSize(10, relativeTo: .caption2, weight: .semibold)
                .monospacedDigit()
                .foregroundStyle(Theme.ground)
                .padding(.horizontal, 4)
                .frame(minWidth: 15, minHeight: 15)
                .background(accent.color, in: .capsule)
                .offset(x: 3, y: -1)
                .accessibilityHidden(true)
        }
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

    /// Project and current session state, with the opening row as fallback.
    private var subtitle: String {
        let state = stateLabel(transcript.session?.state ?? row.session.state)
        guard let project = row.projectName, !project.isEmpty else { return state }
        return "\(project) · \(state)"
    }

    private func stateLabel(_ state: SessionState) -> String {
        switch state {
        case .created: return "Starting"
        case .running: return "Running"
        case .waiting: return "Waiting on you"
        case .blocked: return "Blocked"
        case .complete: return "Idle"
        case .failed: return "Failed"
        case .cancelled: return "Stopped"
        case .unknown(let raw): return raw.capitalized
        }
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
                .foregroundStyle(Theme.muted)
                .frame(width: 32, height: 32)
                .contentShape(.rect)
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
                Haptics.warning()
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

/// Loading feedback that keeps the header and navigation available.
///
/// Not a `ProgressView`. A spinner centred in an empty screen is the shape of
/// "there is nothing here"; a line under the header is the shape of "the
/// thing under this is loading", and it leaves the header — the title, the
/// back chevron — usable while it runs.
struct IndeterminateLine: View {
    @Environment(\.accentTint) private var accent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            TimelineView(.animation(paused: reduceMotion)) { context in
                let cycle = 1.4
                let phase = context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: cycle) / cycle
                Rectangle()
                    .fill(accent.color)
                    .frame(width: width * 0.35)
                    // Reduce Motion gets a static third: the line still says
                    // "loading" without a thing sliding across the screen.
                    .offset(x: reduceMotion ? width * 0.33 : -width * 0.35 + phase * width * 1.35)
            }
        }
        .frame(height: 2)
        .clipped()
        .accessibilityLabel("Loading the chat")
    }
}
