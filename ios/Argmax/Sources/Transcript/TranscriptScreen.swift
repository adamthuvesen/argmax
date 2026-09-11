import SwiftUI

/// One chat, pushed from the list.
///
/// The screen itself is a frame: our header, a trailing menu, and the shared
/// web view filling everything under it. Everything inside the transcript —
/// streaming, cards, approvals, the composer, the review screen — is the
/// page's, which is the whole point of the seam.
struct TranscriptScreen: View {
    /// The row this was pushed from. A snapshot from the moment of the push,
    /// so it is the fallback title and the source of everything the page
    /// does not report: which project, whether there is a diff to open,
    /// whether the chat can be forked.
    let row: ChatRow

    @EnvironmentObject private var transcript: TranscriptHost
    @EnvironmentObject private var navigator: ChatNavigator
    @EnvironmentObject private var store: DashboardStore
    /// Told which chat is on screen, so a push about this one does not draw
    /// a banner over the transcript it is announcing.
    @EnvironmentObject private var push: PushDelegate
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var forking = false

    var body: some View {
        ZStack(alignment: .top) {
            // Painted under a web view that is transparent until the page
            // draws, so the load never flashes white.
            Theme.ground.ignoresSafeArea()
            TranscriptWebView(host: transcript)
                .opacity(transcript.ready ? 1 : 0)
                .safeAreaInset(edge: .top, spacing: 0) { header }
                // The native composer's own bottom edge — the web page hid
                // its own, so nothing under this needs the home-indicator
                // inset twice. Standard keyboard avoidance (no
                // `.ignoresSafeArea(.keyboard)` here) is what shrinks the web
                // view and lifts the card together when the composer's field
                // takes focus.
                .safeAreaInset(edge: .bottom, spacing: 0) { composerFloor }
            if let failure = transcript.failure {
                fallback(failure)
                    .padding(.top, Spacing.headerHeight + Spacing.section)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .onAppear {
            transcript.onBack = { dismiss() }
            transcript.onHaptic = Haptics.play(_:)
            transcript.setTheme(colorScheme == .dark ? .dark : .light)
            transcript.loadIfNeeded()
            transcript.openSession(row.session.id)
            transcript.setComposerHidden(true)
            push.openSessionID = row.session.id
        }
        .onDisappear {
            transcript.onBack = nil
            transcript.onHaptic = nil
            transcript.closeSession()
            if push.openSessionID == row.session.id { push.openSessionID = nil }
        }
        .onChange(of: colorScheme) {
            transcript.setTheme(colorScheme == .dark ? .dark : .light)
        }
    }

    /// The composer card, unless the page has raised its peek at delegated
    /// work: that sheet is drawn to cover the composer, and it can only reach
    /// the bottom of the screen if the native card gives the room up. Reading
    /// delegated work and replying to the chat that spawned it are two acts;
    /// the card comes back the moment the peek closes.
    @ViewBuilder
    private var composerFloor: some View {
        if !transcript.agentsOpen {
            TranscriptComposer()
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        // The review screen draws its own bar. Two would be one too many.
        if !transcript.reviewOpen {
            VStack(spacing: 0) {
                ScreenHeader(title: title, subtitle: subtitle, onBack: { dismiss() }) {
                    menu
                }
                // Until the page names the chat: one thin line under the
                // header rather than a spinner in the middle of an empty
                // screen, which reads as "nothing is here" instead of
                // "something is coming". It runs past `ready` on purpose —
                // a warm page still has to find a chat started a moment ago,
                // and that wait is the blank one worth explaining.
                if transcript.session == nil && transcript.failure == nil {
                    IndeterminateLine()
                }
            }
        }
    }

    /// What the page says the chat is called, until it has said anything.
    private var title: String {
        let reported = transcript.session?.title
        if let reported, !reported.isEmpty { return reported }
        return row.workspace.taskLabel
    }

    /// Project · state. The project never changes under a chat; the state is
    /// whatever the page last reported, and falls back to the row's.
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
        // dismissal and the placement are the platform's, and the rows take
        // our tint.
        Menu {
            // A side chat runs in an app-owned scratch directory with one
            // empty commit, so this would open a permanently empty diff.
            if row.workspace.kind == .git {
                Button("Changes", systemImage: "arrow.triangle.branch") {
                    transcript.openReview()
                }
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
        } label: {
            Image(systemName: "ellipsis")
                .font(.body.weight(.semibold))
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

    /// One line of copy, one action.
    private func fallback(_ message: String) -> some View {
        EmptyState(
            mark: .glyph("exclamationmark.triangle"),
            message: message,
            action: ("Retry", { transcript.reload() })
        )
    }
}

/// The wait before the page speaks: a 2pt line that sweeps under the header.
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
