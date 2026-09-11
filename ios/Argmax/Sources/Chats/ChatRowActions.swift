import SwiftUI

// What a chat row can do without opening.
//
// Swipe for the two the thumb wants — pin one way, archive the other — and a
// long-press menu for the rest, which is the platform's own division and the
// one the design brief asks for. The same set the web's chat-actions sheet
// carries (`src/renderer/mobile/MobileApp.tsx`), behind the same gates.
//
// The row only *asks*. Every dialog, alert and in-flight mutation lives in one
// `ChatRowActionCenter` owned by the screen, presented once from the list, not
// from the row: a `confirmationDialog` bound inside a swipe action is presented
// from a row that is re-rendering as the swipe closes, and on a device that
// tore the app down (on the simulator it merely dropped the dialog). A hundred
// rows each carrying three presentation modifiers was also a hundred places
// for the platform to get that wrong.
//
// Nothing here paints an optimistic row. Each call is a mutation the host
// records and answers with a `dashboard:delta`, so the list corrects itself;
// what a caller does need is for the control not to fire twice, which is what
// `inFlight` is for.

/// The screen's single owner of row-action state and mutations.
@MainActor
final class ChatRowActionCenter: ObservableObject {
    /// The row a confirmation is open for. Nil closes the dialog.
    @Published var archiving: ChatRow?
    /// The row a rename is open for, and the field's text.
    @Published var renaming: ChatRow?
    @Published var draftLabel = ""
    /// One line the host or the transport gave back, shown in an alert.
    @Published var failure: String?
    /// Workspace ids with a mutation in flight; their controls stay off.
    @Published private(set) var inFlight: Set<String> = []

    private let store: DashboardStore
    private let client: BridgeClient

    init(store: DashboardStore, client: BridgeClient) {
        self.store = store
        self.client = client
    }

    func isBusy(_ row: ChatRow) -> Bool { inFlight.contains(row.workspace.id) }

    // MARK: - Intents

    func togglePin(_ row: ChatRow) {
        run(row) { [client] in
            _ = try await client.setPinned(workspaceID: row.workspace.id, pinned: !row.workspace.pinned)
        }
    }

    func requestArchive(_ row: ChatRow) { archiving = row }

    func requestRename(_ row: ChatRow) {
        draftLabel = row.workspace.taskLabel
        renaming = row
    }

    func fork(_ row: ChatRow, then open: @escaping (String) -> Void) {
        run(row) { [client] in
            open(try await client.forkSession(sessionID: row.session.id).session.id)
        }
    }

    // MARK: - Confirmed actions

    /// The same gate `fork_session` applies host-side: a provider whose CLI
    /// can resume a copied conversation, and never mid-turn — forking a
    /// half-written transcript is what the backend refuses.
    static func isForkable(_ row: ChatRow) -> Bool {
        let capable = ProviderCatalog.bundled.provider(row.session.provider)?.forkCapable ?? false
        return capable && row.session.state != .running && row.session.state != .waiting
    }

    /// What archiving this row does, for the dialog's message.
    static func archiveMessage(_ row: ChatRow) -> String {
        guard row.workspace.dirty, !row.workspace.sharedWorkspace else {
            return "Its worktree is removed. The branch and its commits stay."
        }
        let files = row.workspace.changedFiles
        let count = files == 1 ? "1 uncommitted change" : "\(files) uncommitted changes"
        return "This worktree has \(count). Archiving moves the files to recovery storage."
    }

    func archive(_ row: ChatRow) {
        run(row) { [client, weak self] in
            // Dirty and unshared is the case the host refuses without `force`,
            // and the dialog has already asked about exactly that.
            let force = row.workspace.dirty && !row.workspace.sharedWorkspace
            let result = try await client.archiveWorkspace(workspaceID: row.workspace.id, force: force)
            if result.workspace.state != .archived {
                self?.failure = "Uncommitted changes turned up, so the worktree is kept. Commit or discard, then archive again."
            }
        }
    }

    func saveRename() {
        guard let row = renaming else { return }
        let next = draftLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next != row.workspace.taskLabel else { return }
        run(row) { [client] in
            _ = try await client.setLabel(workspaceID: row.workspace.id, taskLabel: next)
        }
    }

    /// Run one mutation, keeping the row's controls off until it answers and
    /// the list has the host's version of what happened.
    private func run(_ row: ChatRow, _ work: @escaping () async throws -> Void) {
        let id = row.workspace.id
        guard !inFlight.contains(id) else { return }
        inFlight.insert(id)
        Task {
            do {
                try await work()
            } catch {
                failure = hostFailureMessage(error)
            }
            // The delta usually arrives first; reloading covers the frame a
            // lagging client never sees, which is what the web does too.
            await store.reload()
            inFlight.remove(id)
        }
    }
}

extension View {
    /// Swipe actions and a context menu for one chat row, reporting to the
    /// screen's `ChatRowActionCenter`.
    ///
    /// `onFork` receives the forked chat's session id, and `onNewChatHere`
    /// the row to start beside — both are navigation, which belongs to the
    /// screen holding the list rather than to a row.
    func chatRowActions(
        _ row: ChatRow,
        center: ChatRowActionCenter,
        onFork: @escaping (String) -> Void,
        onNewChatHere: @escaping (ChatRow) -> Void
    ) -> some View {
        modifier(ChatRowActions(row: row, center: center, onFork: onFork, onNewChatHere: onNewChatHere))
    }

    /// The dialog and alerts every row's actions resolve into. Attached once,
    /// to the list, never to a row.
    func chatRowActionPresentations(_ center: ChatRowActionCenter) -> some View {
        modifier(ChatRowActionPresentations(center: center))
    }
}

private struct ChatRowActions: ViewModifier {
    let row: ChatRow
    @ObservedObject var center: ChatRowActionCenter
    let onFork: (String) -> Void
    let onNewChatHere: (ChatRow) -> Void

    @Environment(\.accentTint) private var accent

    private var busy: Bool { center.isBusy(row) }
    private var pinTitle: String { row.workspace.pinned ? "Unpin" : "Pin" }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    center.togglePin(row)
                } label: {
                    Label(pinTitle, systemImage: row.workspace.pinned ? "pin.slash" : "pin")
                }
                .tint(accent.color)
                .disabled(busy)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) {
                    center.requestArchive(row)
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .disabled(busy)
            }
            .contextMenu {
                Button(pinTitle, systemImage: row.workspace.pinned ? "pin.slash" : "pin") {
                    center.togglePin(row)
                }
                .disabled(busy)
                Button("Rename", systemImage: "pencil") {
                    center.requestRename(row)
                }
                .disabled(busy)
                Button("Fork chat", systemImage: "arrow.triangle.branch") {
                    center.fork(row, then: onFork)
                }
                .disabled(busy || !ChatRowActionCenter.isForkable(row))
                Button("New chat here", systemImage: "plus.bubble") {
                    onNewChatHere(row)
                }
                Divider()
                Button(role: .destructive) {
                    center.requestArchive(row)
                } label: {
                    Label("Archive", systemImage: "archivebox")
                }
                .disabled(busy)
            }
    }
}

private struct ChatRowActionPresentations: ViewModifier {
    @ObservedObject var center: ChatRowActionCenter

    func body(content: Content) -> some View {
        content
            // The system dialog, alert and rename field stay stock on
            // purpose: each one is a modal decision the platform already
            // draws over the keyboard and the swipe that opened it, and
            // rebuilding them would mean rebuilding that too. They take our
            // tint through the app's `.tint`.
            .confirmationDialog(
                "Archive \(center.archiving?.workspace.taskLabel ?? "")?",
                isPresented: Binding(
                    get: { center.archiving != nil },
                    set: { if !$0 { center.archiving = nil } }
                ),
                titleVisibility: .visible,
                presenting: center.archiving
            ) { row in
                Button("Archive", role: .destructive) { center.archive(row) }
                Button("Cancel", role: .cancel) {}
            } message: { row in
                Text(ChatRowActionCenter.archiveMessage(row))
            }
            .alert(
                "Rename chat",
                isPresented: Binding(
                    get: { center.renaming != nil },
                    set: { if !$0 { center.renaming = nil } }
                )
            ) {
                TextField("Chat name", text: $center.draftLabel)
                Button("Cancel", role: .cancel) {}
                Button("Save") { center.saveRename() }
            }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { center.failure != nil },
                    set: { if !$0 { center.failure = nil } }
                )
            ) {
                Button("OK", role: .cancel) { center.failure = nil }
            } message: {
                Text(center.failure ?? "")
            }
    }
}

#Preview("Row actions") {
    // A list, because the swipe actions only exist inside one.
    let center = ChatRowActionCenter(store: previewStore(), client: previewClient())
    return List {
        Text(previewRow.workspace.taskLabel)
            .chatRowActions(previewRow, center: center, onFork: { _ in }, onNewChatHere: { _ in })
    }
    .chatRowActionPresentations(center)
}
