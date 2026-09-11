import Combine
import SwiftUI

/// The chat list: the app's root screen and the only place a chat is opened
/// from.
///
/// Three sections in a fixed order — Pinned, Priority, Chats — grouped by
/// `ChatSections.swift`, which ports the desktop's rules rather than
/// inventing phone ones. The rows are the web list redrawn: the same
/// information, our own type and surfaces, and none of `List`'s stock cell
/// chrome. See the design brief in `docs/plan/hybrid-native-phone.md`.
struct ChatListView: View {
    /// The way out of a pairing the host has stopped honouring. Owned by
    /// `RootView`, which is what actually clears the keychain.
    let onPairAgain: () -> Void

    @EnvironmentObject private var store: DashboardStore
    /// Where a tapped notification lands. The list owns the path, so it is
    /// the only screen that can act on one.
    @EnvironmentObject private var push: PushDelegate
    /// A row is a button, not a `NavigationLink` — a link inside a list
    /// draws a disclosure chevron and there is no way to ask it not to — so
    /// the stack's path is held here and pushed by hand. Settings rides the
    /// same stack, hence `NavigationPath` rather than `[ChatRow]`.
    @State private var path = NavigationPath()
    /// Where a screen deeper in the stack asks for a chat to be started or
    /// opened. The list owns the path and the sheet, so it owns both intents.
    @StateObject private var navigator = ChatNavigator()
    @EnvironmentObject private var rowActions: ChatRowActionCenter
    /// The one-time row settle. False for exactly one frame after the first
    /// rows arrive.
    @State private var settled = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The Priority section ages rows out thirty minutes after their last
    /// message, and the times on the right go stale at about the same rate.
    /// One tick moves both.
    private let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationStack(path: $path) {
            ZStack(alignment: .top) {
                Theme.ground.ignoresSafeArea()
                Group {
                    if let placeholder {
                        placeholderView(placeholder)
                    } else {
                        list
                    }
                }
                .safeAreaInset(edge: .top, spacing: 0) { header }
                // Over the rows rather than above them: the chats on screen
                // are still the right chats, and moving them all down 28pt
                // is the one thing that makes a wobbly connection worse.
                if case .reconnecting = store.connection, placeholder == nil {
                    ReconnectingStrip()
                        .padding(.top, Spacing.headerHeight + Spacing.snug)
                        .transition(.opacity)
                }
            }
            // On the strip, not on the stack. A connection change is a
            // 28pt fade at the top of one screen; applied to the
            // `NavigationStack` — where this was — it ran a transaction
            // across every pushed screen as well, which is the shape of
            // problem that ends with a stack losing the screen it was on.
            .animation(.easeOut(duration: 0.2), value: store.connection)
            .overlay(alignment: .bottomTrailing) { newChatButton }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: ChatRow.self) { TranscriptScreen(row: $0) }
            .navigationDestination(for: NewChatRequest.self) { request in
                NewChatSheet(
                    store: store,
                    client: store.client,
                    preselectedProjectID: request.projectID,
                    branchFromWorkspaceID: request.workspaceID,
                    onLaunched: { workspace, session in
                        // The launch answered with the rows themselves, so
                        // the chat takes the form's place in one update:
                        // seeding them means the row exists now, and
                        // swapping the top of the path never shows the list
                        // between the two screens.
                        store.ingest(delta: DashboardDelta(workspaces: [workspace], sessions: [session]))
                        guard let row = store.row(forSessionID: session.id) else {
                            // Grouping kept it off the list. Fall back to
                            // waiting for the host's own row rather than
                            // stranding the reader on the form.
                            if !path.isEmpty { path.removeLast() }
                            navigator.awaitingSessionID = session.id
                            return
                        }
                        if !path.isEmpty { path.removeLast() }
                        path.append(row)
                    }
                )
            }
            .navigationDestination(for: SettingsRoute.self) { _ in
                SettingsScreen(
                    host: store.client.socketURL.host() ?? "your Mac",
                    onPairAgain: onPairAgain,
                    onBack: { path.removeLast() }
                )
            }
        }
        .environmentObject(navigator)
        .onReceive(clock) { _ in store.refreshClock() }
        // Outside the stack, so a sheet asked for from a transcript covers
        // the transcript rather than opening behind it.
        // A page, not a sheet: the request is pushed like any other screen, and
        // the chat it starts replaces it at the top of the stack.
        .onChange(of: navigator.newChat) { _, request in
            guard let request else { return }
            navigator.newChat = nil
            path.append(request)
        }
        .onChange(of: store.sections) { openWhenReady() }
        .onChange(of: navigator.awaitingSessionID) { openWhenReady() }
        .onChange(of: push.tappedSessionID) { openTappedNotification() }
        // A tap on the lock screen launches the app and is delivered before
        // any of this exists, so the value is read once on the way in as
        // well as watched.
        .task { openTappedNotification() }
        .task {
            guard !reduceMotion else {
                settled = true
                return
            }
            // One frame at rest, then the stagger runs. Set during the same
            // pass that first draws the rows it does nothing.
            try? await Task.sleep(for: .milliseconds(60))
            withAnimation(nil) { settled = true }
        }
    }

    // MARK: - Header

    /// Green while the socket is up, amber while it is not, rose when the
    /// pairing has been refused — the web header's dot, colour for colour.
    private var connectionTint: Color {
        if store.connection == .unauthorized { return Theme.rose }
        if store.loadFailure != nil { return Theme.amber }
        switch store.connection {
        case .live: return Theme.sage
        case .connecting, .reconnecting: return Theme.amber
        case .unauthorized: return Theme.rose
        }
    }

    private var header: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: "", showsMark: true, trailing: {
                HeaderGlyphButton(systemName: "ellipsis", label: "Settings", tint: Theme.ink, weight: .semibold, filled: true) {
                    path.append(SettingsRoute.root)
                }
            }, center: {
                // The Mac this phone is a remote for, as the web header put it:
                // what you are looking at, then whether the line to it is up.
                VStack(spacing: 2) {
                    Text("Remote")
                        .font(.headline)
                        .foregroundStyle(Theme.ink)
                    HStack(spacing: 5) {
                        Circle()
                            .fill(connectionTint)
                            .frame(width: 6, height: 6)
                        Image(systemName: "laptopcomputer")
                            .font(.caption.weight(.medium))
                        Text(MacName.from(host: store.client.socketURL.host()))
                            .font(.caption)
                    }
                    .foregroundStyle(Theme.muted)
                    .animation(.easeOut(duration: 0.2), value: store.connection)
                }
                .accessibilityElement(children: .combine)
            })
        }
    }

    // MARK: - New chat

    /// The one primary action on this screen, where a thumb rests. Inverse of
    /// the ground — cream on dark, near-black on light — rather than the
    /// accent, so the running nests stay the only orange in the list. The
    /// glyph is the desktop's "New chat here" (`SquarePen`): a plus adds a
    /// thing to a list, and this opens a sheet you write in.
    private var newChatButton: some View {
        Button {
            Haptics.light()
            navigator.newChat = NewChatRequest()
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(Theme.ground)
                .frame(width: 56, height: 56)
                .background(Theme.ink, in: Circle())
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New chat")
        .padding(.trailing, Spacing.gutter)
        // Sits close to the home indicator; the safe area already keeps it clear.
        .padding(.bottom, Spacing.snug)
    }

    // MARK: - The list

    private var list: some View {
        // `List`, not a `LazyVStack`: swipe actions, row recycling over a
        // hundred chats, and the context-menu lift are the platform's and
        // are worth having. Everything it would otherwise draw — background,
        // separators, cell insets, selection — is turned off below.
        List {
            section("Pinned", rows: store.sections.pinned, from: 0)
            section("Priority", rows: store.sections.priority, from: store.sections.pinned.count)
            section("Chats", rows: store.sections.chats, from: store.sections.pinned.count + store.sections.priority.count)
            // The last row needs somewhere to end, and the home indicator is
            // not it.
            Color.clear.frame(height: Spacing.section).plainRow()
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollDismissesKeyboard(.immediately)
        .refreshable { await store.reload() }
        .chatRowActionPresentations(rowActions)
    }

    /// A heading and its rows, all of them ordinary rows.
    ///
    /// Not `Section(header:)`: a plain list pins its section headers, so
    /// "Priority · 3" stayed welded under our own header while the chats it
    /// counted scrolled away beneath it — two stacked headers, and a count
    /// that no longer described what was on screen. The heading is content,
    /// so it scrolls with the content.
    @ViewBuilder
    private func section(_ label: String, rows: [ChatRow], from offset: Int) -> some View {
        if !rows.isEmpty {
            Group {
                SectionHeading(label: label, count: rows.count).plainRow()
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    ChatListRow(
                        row: row,
                        now: store.now,
                        // None after the last row of a section: the section
                        // gap below is the divider there.
                        separated: index < rows.count - 1,
                        settled: settled,
                        // Capped, because a hundred rows at 40ms is four
                        // seconds of a list assembling itself.
                        stagger: min(offset + index, 10)
                    ) {
                        Haptics.light()
                        path.append(row)
                    }
                    .chatRowActions(
                        row,
                        center: rowActions,
                        onFork: { navigator.awaitingSessionID = $0 },
                        onNewChatHere: { navigator.newChat = NewChatRequest(workspaceID: $0.workspace.id) }
                    )
                    .plainRow()
                }
            }
        }
    }


    // MARK: - Opening what was just started

    /// A fork answers with a session id whose row arrives a moment later on a
    /// `dashboard:delta`. Push as soon as it does. A launch does not come
    /// through here: it carries its own rows, so it opens straight away.
    private func openWhenReady() {
        guard let wanted = navigator.awaitingSessionID else { return }
        guard let row = store.row(forSessionID: wanted) else { return }
        navigator.awaitingSessionID = nil
        Task {
            // The New chat page is still popping; a push that starts during
            // that transition is dropped, so the row's push waits it out.
            try? await Task.sleep(for: .milliseconds(320))
            path.append(row)
        }
    }

    /// A tapped notification names a chat (`sessionId` in the payload). It
    /// opens the way a fork does — the id waits in the navigator until the
    /// row for it is in the snapshot — so a cold launch from the lock screen
    /// lands on the chat rather than on the list.
    private func openTappedNotification() {
        guard let sessionID = push.tappedSessionID else { return }
        push.tappedSessionID = nil
        // Already reading it. Pushing a second copy of the screen you are
        // looking at is the one outcome a tap must not have.
        guard push.openSessionID != sessionID else { return }
        path = NavigationPath()
        navigator.awaitingSessionID = sessionID
        openWhenReady()
    }

    // MARK: - Full-screen states
    //
    // One mark, one line, one action.

    private var placeholder: ChatListPlaceholder? {
        chatListPlaceholder(
            connection: store.connection,
            hasRows: !store.sections.isEmpty,
            loadedOnce: store.loadedOnce,
            failed: store.loadFailure != nil
        )
    }

    @ViewBuilder
    private func placeholderView(_ placeholder: ChatListPlaceholder) -> some View {
        switch placeholder {
        case .connecting:
            // No copy: this state lasts about a second on a live pairing,
            // and a sentence that flashes is worse than nothing.
            ProgressView()
                .tint(Theme.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .noChats:
            EmptyState(message: "No chats yet.", action: ("Start one", { navigator.newChat = NewChatRequest() }))
        case .unreachable:
            EmptyState(
                mark: .glyph("wifi.exclamationmark"),
                message: "Can’t reach your Mac.",
                action: ("Retry", { store.resume() })
            )
        case .unauthorized:
            EmptyState(
                mark: .glyph("lock.slash"),
                message: "This pairing has expired.",
                action: ("Pair again", onPairAgain)
            )
        }
    }
}

/// Two intents a pushed screen can raise that only the list can act on:
/// open a chat that does not exist yet, and start one.
///
/// A transcript can fork itself and can start a chat beside itself, but the
/// navigation path and the sheet both belong to the list. Rather than
/// threading two closures through `navigationDestination`, both sides write
/// here.
@MainActor
final class ChatNavigator: ObservableObject {
    /// A chat that has just been launched or forked, waiting for the row the
    /// host will send back so the stack has something to push.
    @Published var awaitingSessionID: String?
    @Published var newChat: NewChatRequest?
}

/// What "+" and "New chat here" open, as one value so there is one sheet.
struct NewChatRequest: Identifiable, Hashable {
    var projectID: String?
    var workspaceID: String?

    var id: String { "\(projectID ?? "-")/\(workspaceID ?? "-")" }
}

/// Settings is a screen on the same stack as a chat, not a sheet: it has a
/// back chevron and its own header like everything else here.
enum SettingsRoute: Hashable {
    case root
}

extension View {
    /// A `List` row with every piece of the platform's cell chrome off.
    func plainRow() -> some View {
        listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.ground)
    }
}

// MARK: - Header pieces

/// Live is silence. The dot only exists to say when something is wrong, so
/// when nothing is it is not drawn at all.
private struct ConnectionDot: View {
    let connection: BridgeConnection
    let unreachable: Bool

    var body: some View {
        Group {
            if let color {
                Circle()
                    .fill(color)
                    .frame(width: 6, height: 6)
                    .transition(.opacity)
                    .accessibilityLabel(label ?? "")
            }
        }
        .frame(width: 10)
    }

    private var color: Color? {
        switch connection {
        case .live: return unreachable ? Theme.amber : nil
        case .connecting, .reconnecting: return Theme.amber
        case .unauthorized: return Theme.rose
        }
    }

    private var label: String? {
        switch connection {
        case .live: return unreachable ? "Can’t reach your Mac" : nil
        case .connecting: return "Connecting"
        case .reconnecting: return "Reconnecting"
        case .unauthorized: return "Pairing expired"
        }
    }
}

/// Not the system header: the row subtitles' size and weight, the count the
/// web list carried, and its own air above and below.
private struct SectionHeading: View {
    let label: String
    let count: Int

    var body: some View {
        Text("\(label) · \(count)")
            .typeSectionHeading()
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .screenGutter()
            .padding(.top, Spacing.section)
            .padding(.bottom, Spacing.snug)
            .accessibilityLabel("\(label), \(count)")
    }
}

// MARK: - Row

/// What a row says about itself in the trailing column, or nothing.
///
/// Attention comes from `ChatSections`, which has already dropped the reasons
/// that were dismissed or have aged out — so a chip here means the claim is
/// live, not merely that it once was.
enum ChatRowAttention: Hashable {
    case needsYou
    case blocked
    case failed
    case done

    init?(_ attention: AttentionState?) {
        switch attention {
        case .approvalNeeded, .questionAsked: self = .needsYou
        case .blocked: self = .blocked
        case .failed: self = .failed
        case .reviewReady: self = .done
        case .normal, .unknown, .none: return nil
        }
    }

    var label: String {
        switch self {
        case .needsYou: return "Needs you"
        case .blocked: return "Blocked"
        case .failed: return "Failed"
        case .done: return "Done"
        }
    }

    /// Attention's own three, never the accent: the accent is the running
    /// mark and the primary button, and a list where everything is orange
    /// ranks nothing.
    var color: Color {
        switch self {
        case .needsYou, .blocked: return Theme.amber
        case .failed: return Theme.rose
        case .done: return Theme.sage
        }
    }
}

struct ChatListRow: View {
    let row: ChatRow
    /// The store's clock, so every row on screen ages against one instant.
    let now: Date
    let separated: Bool
    var settled = true
    var stagger = 0
    let open: () -> Void

    /// Settings → Appearance. It hides the provider's mark and nothing else:
    /// a running chat still shows its nest and a chat with an icon still
    /// shows that, so the column stays and the titles keep their column.
    @Environment(\.providerMarks) private var providerMarks

    var body: some View {
        Button(action: open) {
            HStack(alignment: .top, spacing: 0) {
                ChatRowGlyphView(glyph: ChatRowGlyph(row: row, providerMarks: providerMarks))
                    // Optically on the title's line rather than on the row's
                    // top edge.
                    .padding(.top, 2)
                    .frame(width: Spacing.glyphColumn, alignment: .leading)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.workspace.taskLabel)
                        .typeRowTitle()
                        .lineLimit(1)
                        .truncationMode(.tail)
                    subtitle
                }
                Spacer(minLength: Spacing.row)
                VStack(alignment: .trailing, spacing: Spacing.tight) {
                    Text(compactElapsed(since: lastActivity, now: now))
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .monospacedDigit()
                        // "2h" is a glance, not a sentence; VoiceOver gets
                        // the sentence.
                        .accessibilityLabel(spokenElapsed)
                    if let attention = ChatRowAttention(row.attention) {
                        AttentionCapsule(label: attention.label, color: attention.color)
                            .transition(.opacity)
                    }
                }
                .layoutPriority(1)
            }
            .padding(.vertical, Spacing.row)
            .screenGutter()
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .overlay(alignment: .bottomLeading) {
            if separated {
                HairlineDivider(inset: Spacing.gutter + Spacing.glyphColumn)
                    .padding(.trailing, Spacing.gutter)
            }
        }
        .animation(.easeOut(duration: 0.15), value: row.attention)
        // The list settles in once, on first load, 40ms apart.
        .opacity(settled ? 1 : 0)
        .offset(y: settled ? 0 : 8)
        .animation(.easeOut(duration: 0.24).delay(Double(stagger) * 0.04), value: settled)
    }

    /// Project · branch, as one string so the tail truncates the branch
    /// first — the project is what tells you where you are.
    ///
    /// Only an isolated workspace names its branch. A shared checkout is on
    /// whatever the main checkout is on, and a side chat's is an app-owned
    /// scratch repo's `main`: a column of "· main" that means nothing and
    /// costs the title its room.
    private var subtitle: some View {
        var text = Text(row.projectName ?? "")
        if showsBranch {
            let separator = row.projectName == nil ? "" : " · "
            text = text + Text(separator) + Text(row.workspace.branch).font(.argmaxMono(.caption))
        }
        return text
            .typeMeta()
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var showsBranch: Bool {
        row.workspace.kind == .git && !row.workspace.sharedWorkspace && !row.workspace.branch.isEmpty
    }

    private var lastActivity: Date? {
        parseWireTimestamp(row.session.lastActivityAt)
    }

    private var spokenElapsed: String {
        guard let lastActivity else { return "" }
        return Self.spoken.localizedString(for: lastActivity, relativeTo: now)
    }

    private static let spoken: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()
}

/// "now", "3m", "2h", "4d", "6w" — no "ago", because the column it sits in is
/// only ever the past and the characters it saves are the title's.
func compactElapsed(since date: Date?, now: Date) -> String {
    guard let date else { return "" }
    let elapsed = now.timeIntervalSince(date)
    switch elapsed {
    // A clock that has drifted the other way still has to say something.
    case ..<60: return "now"
    case ..<3600: return "\(Int(elapsed / 60))m"
    case ..<86_400: return "\(Int(elapsed / 3600))h"
    case ..<604_800: return "\(Int(elapsed / 86_400))d"
    default: return "\(Int(elapsed / 604_800))w"
    }
}

#if DEBUG

#Preview("Rows") {
    List {
        Section {
            ChatListRow(row: .preview(label: "Wire the review screen", running: true), now: .now, separated: true) {}
                .plainRow()
            // Running with an icon colour: the nest takes the colour, and the
            // icon waits until the turn ends.
            ChatListRow(
                row: .preview(
                    label: "Port the effort dial to the phone",
                    running: true,
                    icon: "Gauge",
                    iconColor: "violet"
                ),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "Rewrite the release notes", icon: "Newspaper", iconColor: "amber"),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(
                    label: "Fix the keyboard inset on the composer",
                    provider: "codex",
                    attention: .approvalNeeded
                ),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "Bump the Rust toolchain", provider: "grok", attention: .failed),
                now: .now,
                separated: false
            ) {}
            .plainRow()
        }
        Section {
            ChatListRow(
                row: .preview(label: "Port the sidebar grouping", attention: .reviewReady),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "Wire up open and merged PR glyphs", prState: "OPEN", prNumber: 214),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "Fix the keyboard inset on the composer", prState: "MERGED", prNumber: 209),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "A quiet finished chat with a very long task label indeed", provider: "cursor"),
                now: .now,
                separated: true
            ) {}
            .plainRow()
            ChatListRow(
                row: .preview(label: "Side chat about ISO timestamps", project: "Side chats", kind: .scratch),
                now: .now,
                separated: false
            ) {}
            .plainRow()
        }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Theme.ground)
    .environment(\.defaultMinListRowHeight, 0)
}

extension ChatRow {
    /// Preview-only rows. The real ones come off the wire; these only have to
    /// be shaped like them.
    static func preview(
        label: String,
        project: String? = "argmax",
        provider: String = "claude",
        kind: WorkspaceKind = .git,
        attention: AttentionState = .normal,
        running: Bool = false,
        icon: String? = nil,
        iconColor: String? = nil,
        prState: String? = nil,
        prNumber: Int? = nil,
        minutesAgo: Int = 7
    ) -> ChatRow {
        let at = ISO8601DateFormatter.withMilliseconds.string(
            from: Date.now.addingTimeInterval(-Double(minutesAgo) * 60)
        )
        let workspace = WorkspaceSummary(
            id: UUID().uuidString,
            projectId: "p-1",
            taskLabel: label,
            branch: kind == .git ? "argmax/hybrid-phone-2f3a" : "main",
            baseRef: "main",
            path: "/tmp/preview",
            state: .complete,
            kind: kind,
            sharedWorkspace: false,
            dirty: false,
            changedFiles: 0,
            lastActivityAt: at,
            pinned: false,
            priorityDismissedAt: nil,
            priorityAddedAt: nil,
            prState: prState,
            prNumber: prNumber,
            prCheckState: nil,
            prActivityAt: nil,
            icon: icon,
            iconColor: iconColor
        )
        let session = SessionSummary(
            id: UUID().uuidString,
            workspaceId: workspace.id,
            provider: provider,
            modelLabel: "Opus 5",
            modelId: "claude-opus-5",
            prompt: label,
            state: running ? .running : .complete,
            attention: attention,
            attentionChangedAt: at,
            startedAt: at,
            completedAt: nil,
            lastActivityAt: at,
            imported: false,
            launchKind: "agent",
            launchedBySessionId: nil
        )
        return ChatRow(
            workspace: workspace,
            session: session,
            projectName: project,
            attention: attention == .normal ? nil : attention,
            working: running
        )
    }
}

#endif
