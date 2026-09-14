import SwiftUI

// The review surface: what this chat changed, and what the checkout holds.
//
// The desktop puts these side by side in a panel with a tree column and an
// editor. A phone has one column, so the list and one open file take turns on
// it: opening a file replaces the list and retitles the header, and the back
// chevron returns to the list. One file at a time, so the code column keeps
// the full width (see `CodeText.swift`).

struct ReviewScreen: View {
    let workspace: WorkspaceSummary
    let initialFilePath: String?
    let initialDiffPath: String?
    let onBack: () -> Void

    @EnvironmentObject private var dashboard: DashboardStore
    @StateObject private var store: ReviewStore
    @State private var mode: Mode = .changes
    @State private var scopeSheet = false
    /// The one file the screen is showing, or nil for the list. A file
    /// opens in place of the list and the back chevron returns to it.
    @State private var openDetail: ReviewDetail?
    @State private var fileRevision = 0
    /// The context rung the embedded diff is read at, and whether it has any
    /// unchanged lines left to give. The control lives on the header, so the
    /// state it drives lives here rather than inside the viewer.
    @State private var diffContext: Int?
    @State private var canExpandDiff = false
    @State private var refreshTask: Task<Void, Never>?
    /// A canvas render has no Mac to read from, so the screen skips its own
    /// reads and draws whatever the store was seeded with.
    private var canvas = false

    enum Mode: String, Hashable { case changes, files }

    init(
        workspace: WorkspaceSummary,
        client: BridgeClient,
        initialFilePath: String?,
        initialDiffPath: String? = nil,
        onBack: @escaping () -> Void
    ) {
        self.workspace = workspace
        self.initialFilePath = initialFilePath
        self.initialDiffPath = initialDiffPath
        self.onBack = onBack
        let reviewStore = ReviewStore(workspace: workspace, client: client)
        _store = StateObject(wrappedValue: reviewStore)
        let initialDetail = initialDiffPath.map {
            ReviewDetail.diff(workspaceID: workspace.id, path: $0, scope: reviewStore.scope)
        } ?? initialFilePath.map {
            ReviewDetail.file(workspaceID: workspace.id, path: $0)
        }
        _openDetail = State(initialValue: initialDetail)
        // A file reference opens Files behind its viewer. An edit activity
        // opens Changes behind its diff, matching the desktop review panel.
        _mode = State(initialValue: initialFilePath == nil ? .changes : .files)
    }

    #if DEBUG
    /// A screen over a store that is already full — the `#Preview` path.
    init(store: ReviewStore, mode: Mode = .changes) {
        workspace = store.workspace
        initialFilePath = nil
        initialDiffPath = nil
        onBack = {}
        _store = StateObject(wrappedValue: store)
        _mode = State(initialValue: mode)
        _openDetail = State(initialValue: nil)
        canvas = true
    }
    #endif

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            VStack(spacing: 0) {
                if let detail = openDetail {
                    ReviewDetailScreen(
                        detail: detail,
                        store: dashboard,
                        revision: reviewRevision,
                        chrome: .embedded,
                        contextLines: $diffContext,
                        onBack: onBack
                    )
                    // Diff and file viewers own local load and scrolling
                    // state, so opening another file must construct a new one.
                    .id(detail)
                    .onPreferenceChange(DiffCanExpandKey.self) { canExpandDiff = $0 }
                } else {
                    metaRow
                    body(for: mode)
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) { header }
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .task(id: reviewRevision) {
            guard !canvas else { return }
            await store.loadChangedFiles()
            if mode == .files { await store.loadFileList() }
        }
        .onReceive(dashboard.reviewChanged) { changed in
            guard changed.contains(workspace.id), !canvas, refreshTask == nil else { return }
            // Coalesce streaming events without postponing reads until the
            // entire turn ends. File counts alone miss repeated file edits.
            refreshTask = Task {
                do { try await Task.sleep(for: .milliseconds(500)) }
                catch { return }
                fileRevision += 1
                refreshTask = nil
            }
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
        .onChange(of: openDetail) { _, _ in
            // The rung belongs to the open file, so it starts over.
            diffContext = nil
            canExpandDiff = false
        }
        .onChange(of: mode) { _, current in
            openDetail = nil
            guard !canvas, current == .files else { return }
            Task { await store.loadFileList() }
        }
        .sheet(isPresented: $scopeSheet) {
            PickerSheet(
                title: "Changes shown",
                options: ReviewScope.allCases.map {
                    PickerOption(value: $0, label: $0.label, detail: $0.detail)
                },
                selection: $store.scope
            )
            .argmaxSheet(detents: [.medium])
        }
    }

    /// The workspace as the dashboard currently has it, which is not the
    /// snapshot this screen was pushed with.
    private var liveWorkspace: WorkspaceSummary? {
        dashboard.snapshot.workspaces.first { $0.id == workspace.id }
    }

    /// Workspace metadata plus coalesced transcript invalidations refresh
    /// repeated writes even when the changed-file count stays the same.
    private var reviewRevision: String {
        let current = liveWorkspace ?? workspace
        return "\(current.lastActivityAt)|\(current.changedFiles)|\(dashboard.connection)|\(fileRevision)"
    }

    // MARK: - Header

    /// One header, saying where you are. On the list that is the task and its
    /// branch, with the mode switch; on a file it is the file's own name and
    /// the directory it came from, and the chevron returns to the list rather
    /// than leaving Review. A file used to arrive under a tab strip instead,
    /// which was the only chrome in the app shaped like that and said the
    /// file's name in a bar the rest of the app spells as a header.
    @ViewBuilder
    private var header: some View {
        if let detail = openDetail {
            ScreenHeader(
                title: detail.fileName,
                subtitle: detail.pathAndKind,
                onBack: { openDetail = nil }
            ) {
                expandControl
            }
        } else {
            ScreenHeader(
                title: workspace.taskLabel,
                subtitle: workspace.branch,
                onBack: onBack
            ) {
                ReviewModeSwitch(mode: $mode)
            }
        }
    }

    /// The open diff's one control: climb to the next context rung. Only
    /// while there is a rung left, which is the viewer's answer, not ours.
    /// It rides the header's trailing slot, the only bar an embedded viewer
    /// has now that the tab strip is gone.
    @ViewBuilder
    private var expandControl: some View {
        if canExpandDiff {
            ReviewContextButton { diffContext = DiffParser.nextContext(after: diffContext) }
        }
    }

    /// One quiet line under the header: which slice, and what it adds up to.
    /// Files has nothing to say here — the tree is the whole worktree — so the
    /// row goes rather than standing empty.
    @ViewBuilder
    private var metaRow: some View {
        if mode == .changes {
            HStack(alignment: .center, spacing: Spacing.snug) {
                Button {
                    scopeSheet = true
                } label: {
                    HStack(spacing: Spacing.tight) {
                        Text(store.scope.label)
                        Image(systemName: "chevron.up.chevron.down")
                            .typeSymbol(.caption2, weight: .semibold)
                    }
                    .typeMeta()
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, Spacing.row)
                    .padding(.vertical, 7)
                    // `composerChipSurface` fills with the ground, which is
                    // the step *inside* a composer card. On the screen's own
                    // ground that is no step at all, so the chip takes the
                    // raised one instead and reads as a control.
                    .background(Theme.raised, in: .capsule)
                }
                .buttonStyle(PressDim())
                .accessibilityLabel("Changes shown, \(store.scope.label)")

                Spacer(minLength: 0)

                if !store.files.isEmpty {
                    HStack(spacing: Spacing.snug) {
                        Text(verbatim: "\(store.files.count) file\(store.files.count == 1 ? "" : "s")")
                            .foregroundStyle(Theme.muted)
                        ChangeCount(additions: store.totalAdditions, deletions: store.totalDeletions)
                    }
                    .typeMeta()
                }
            }
            .screenGutter()
            .padding(.bottom, Spacing.row)
        }
    }

    // MARK: - Body

    @ViewBuilder
    private func body(for mode: Mode) -> some View {
        switch mode {
        case .changes: changesBody
        case .files: filesBody
        }
    }

    @ViewBuilder
    private var changesBody: some View {
        if let message = store.filesLoad.message, store.files.isEmpty {
            EmptyState(
                mark: .glyph("exclamationmark.triangle"),
                message: message,
                action: ("Try again", { Task { await store.loadChangedFiles() } })
            )
        } else if store.files.isEmpty, store.filesLoad == .ready {
            // The copy follows the scope: "nothing changed on this branch"
            // under Uncommitted would be a claim the screen is not making.
            EmptyState(mark: .glyph("checkmark.circle"), message: store.scope.emptyMessage)
        } else if store.files.isEmpty, store.filesLoad.isLoading {
            LoadingRows()
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(store.files) { file in
                        Button {
                            openDetail = ReviewDetail.diff(
                                workspaceID: workspace.id,
                                path: file.path,
                                scope: store.scope
                            )
                        } label: {
                            ChangedFileRow(file: file)
                        }
                        .buttonStyle(PressDim())
                        if file.id != store.files.last?.id {
                            HairlineDivider(inset: ChangedFileRow.textInset)
                        }
                    }
                }
                .padding(.bottom, Spacing.section)
            }
            .refreshable { await store.loadChangedFiles() }
        }
    }

    @ViewBuilder
    private var filesBody: some View {
        if let message = store.entriesLoad.message, store.entries.isEmpty {
            EmptyState(
                mark: .glyph("exclamationmark.triangle"),
                message: message,
                action: ("Try again", { Task { await store.loadFileList(force: true) } })
            )
        } else if store.entries.isEmpty, store.entriesLoad.isLoading {
            LoadingRows()
        } else if store.entries.isEmpty {
            EmptyState(mark: .glyph("folder"), message: "This checkout has no files to show.")
        } else {
            FileTreeView(
                entries: store.entries,
                workspaceID: workspace.id,
                reveal: initialFilePath,
                onRefresh: { await store.loadFileList(force: true) },
                onOpenFile: {
                    openDetail = ReviewDetail.file(workspaceID: workspace.id, path: $0)
                }
            )
        }
    }
}

/// Two words, one of them live. Not a `Picker(.segmented)`: that control
/// arrives with the system's own fill, its own corner radius and the tint —
/// three decisions this app makes for itself — and it would be the only
/// capsule on a screen whose other controls are text.
struct ReviewModeSwitch: View {
    @Binding var mode: ReviewScreen.Mode

    var body: some View {
        HStack(spacing: Spacing.row) {
            word("Changes", for: .changes)
            word("Files", for: .files)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Review mode")
    }

    private func word(_ label: String, for value: ReviewScreen.Mode) -> some View {
        let selected = mode == value
        return Button {
            guard !selected else { return }
            Haptics.selection()
            mode = value
        } label: {
            Text(label)
                .typeStyle(.footnote, weight: selected ? .semibold : .regular)
                .foregroundStyle(selected ? Theme.ink : Theme.muted)
                .contentShape(.rect)
        }
        .buttonStyle(PressDim())
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// One changed file. The glyph column carries git's letter, the path keeps its
/// filename when it has to truncate, and the counts are the diff's own inks —
/// never the accent, which in this app means the running thing.
struct ChangedFileRow: View {
    let file: ChangedFileSummary

    /// The width the status letter gets. Narrower than `Spacing.glyphColumn`,
    /// which sizes the chat list's 36pt icon: one character needs a column,
    /// not a tile, and the gap it leaves pushes the filename off its own
    /// margin.
    static let statusColumn: CGFloat = 18
    /// Where the divider under a row starts, so the letters line up as their
    /// own column down the screen.
    static let textInset = Spacing.gutter + statusColumn + Spacing.snug

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
            Text(ChangedFileStatus.glyph(file.status))
                .typeStyle(.caption2, weight: .semibold, mono: true)
                .foregroundStyle(ChangedFileStatus.tint(file.status))
                .frame(width: Self.statusColumn, alignment: .leading)
                .accessibilityLabel(ChangedFileStatus.label(file.status))

            VStack(alignment: .leading, spacing: 3) {
                // The filename first and on its own line. A path folded into
                // one line has to truncate somewhere, and every somewhere
                // costs either the name — the thing being read — or the
                // directory that tells two `index.ts` apart.
                Text(fileName)
                    .typeRowTitle()
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !directory.isEmpty {
                    Text(directory)
                        .typeMeta()
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if let from = renamedFrom {
                    // Without this a rename reads as a bare add.
                    Text(verbatim: "from \(from)")
                        .typeMeta()
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            Spacer(minLength: Spacing.snug)
            ChangeCount(additions: file.additions, deletions: file.deletions, style: .rowTitle)
            Image(systemName: "chevron.right")
                .typeSymbol(.caption2, weight: .semibold)
                .foregroundStyle(Theme.muted.opacity(0.5))
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
        }
        .screenGutter()
        .padding(.vertical, Spacing.row)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }

    private var fileName: String {
        String(file.path.split(separator: "/").last ?? Substring(file.path))
    }

    private var directory: String {
        file.path.split(separator: "/").dropLast().joined(separator: "/")
    }

    /// A rename inside one folder is a new name, not a new place, so only the
    /// old name is worth the line. Across folders the whole old path is.
    private var renamedFrom: String? {
        guard let oldPath = file.oldPath, !oldPath.isEmpty else { return nil }
        let oldDirectory = oldPath.split(separator: "/").dropLast().joined(separator: "/")
        return oldDirectory == directory
            ? String(oldPath.split(separator: "/").last ?? Substring(oldPath))
            : oldPath
    }
}

/// `+12 −3`, in the diff's inks. Zero on either side is left off rather than
/// drawn as a quiet `+0`, which reads as a number the eye then has to dismiss.
struct ChangeCount: View {
    enum Style {
        case compact
        case rowTitle
    }

    let additions: Int
    let deletions: Int
    var style: Style = .compact

    var body: some View {
        HStack(spacing: Spacing.tight) {
            // `Text(verbatim:)`, because `Text("+\(additions)")` interpolates
            // through `LocalizedStringKey` and groups the digits: a file with
            // 2905 additions reads as "+2 905", which is two numbers.
            if additions > 0 {
                Text(verbatim: "+\(additions)").foregroundStyle(Theme.diffAddInk)
            }
            if deletions > 0 {
                // U+2212, not a hyphen: a minus that matches the plus above it.
                Text(verbatim: "−\(deletions)").foregroundStyle(Theme.diffDelInk)
            }
        }
        .modifier(ChangeCountTypeStyle(style: style))
        .accessibilityLabel("\(additions) added, \(deletions) removed")
    }
}

/// File-row counts share the filename's size, while metadata and transcript
/// counts stay compact enough to remain secondary to the action they describe.
private struct ChangeCountTypeStyle: ViewModifier {
    let style: ChangeCount.Style

    func body(content: Content) -> some View {
        switch style {
        case .compact:
            content.typeStyle(.caption2, mono: true, monospacedDigit: true)
        case .rowTitle:
            content.typeSize(18, relativeTo: .body, mono: true)
        }
    }
}

/// The wait before rows: quiet bars at row rhythm rather than a spinner, so
/// the screen that arrives is the shape of the screen that was coming.
struct LoadingRows: View {
    var rows = 7

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { index in
                HStack(spacing: Spacing.row) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Theme.raised)
                        .frame(width: 12, height: 11)
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Theme.raised)
                        .frame(width: 120 + CGFloat((index * 37) % 90), height: 11)
                    Spacer(minLength: 0)
                }
                .screenGutter()
                .padding(.vertical, Spacing.row + 2)
            }
            Spacer(minLength: 0)
        }
        .accessibilityLabel("Loading")
        .accessibilityHidden(false)
    }
}

/// The review surface as a navigation value. A file reference sets `filePath`,
/// while an edit activity sets `diffPath`. The review screen opens the
/// requested view directly, with the list behind its back chevron.
struct ReviewRoute: Hashable {
    let workspaceID: String
    var filePath: String? = nil
    var diffPath: String? = nil
}

/// Where a tap inside the review screen goes.
///
/// Every value here is enough to build the viewer on its own — the scope
/// travels with the request rather than being read back out of a store. The
/// review screen also uses it as the identity of the file it has open.
enum ReviewDetail: Hashable {
    case diff(workspaceID: String, path: String, scope: ReviewScope)
    case file(workspaceID: String, path: String)
}


extension View {
    /// The review surface and the standalone detail destination, registered
    /// on the stack that owns the path.
    ///
    /// Declared here rather than inside `ReviewScreen` so transcript routes
    /// and older detail values resolve from the stack that owns the path.
    /// Factored out of `ChatListView` because the type-checker cannot solve
    /// all of its generic destinations in one expression.
    func reviewDestinations(store: DashboardStore, onPop: @escaping () -> Void) -> some View {
        navigationDestination(for: ReviewRoute.self) { route in
            ReviewRouteScreen(route: route, store: store, onPop: onPop)
        }
        .navigationDestination(for: ReviewDetail.self) { detail in
            ReviewDetailScreen(detail: detail, store: store)
        }
    }
}

/// The review screen, resolved against the dashboard as it is now.
///
/// A workspace that has gone — archived from the Mac while the phone sat on
/// the transcript — is a screen with nothing to review, and says so rather
/// than pushing an empty one.
private struct ReviewRouteScreen: View {
    let route: ReviewRoute
    @ObservedObject var store: DashboardStore
    let onPop: () -> Void

    var body: some View {
        if let workspace = store.snapshot.workspaces.first(where: { $0.id == route.workspaceID }) {
            ReviewScreen(
                workspace: workspace,
                client: store.client,
                initialFilePath: route.filePath,
                initialDiffPath: route.diffPath,
                onBack: onPop
            )
        } else {
            EmptyState(
                mark: .glyph("questionmark.folder"),
                message: "This checkout is no longer on your Mac.",
                action: ("Back", onPop)
            )
        }
    }
}

private struct ReviewDetailScreen: View {
    let detail: ReviewDetail
    @ObservedObject var store: DashboardStore
    private let revisionOverride: String?
    private let chrome: ViewerChrome
    private let contextLines: Binding<Int?>?
    private let onBack: (() -> Void)?

    init(
        detail: ReviewDetail,
        store: DashboardStore,
        revision: String? = nil,
        chrome: ViewerChrome = .pushed,
        contextLines: Binding<Int?>? = nil,
        onBack: (() -> Void)? = nil
    ) {
        self.detail = detail
        _store = ObservedObject(wrappedValue: store)
        revisionOverride = revision
        self.chrome = chrome
        self.contextLines = contextLines
        self.onBack = onBack
    }

    var body: some View {
        switch detail {
        case .diff(let workspaceID, let filePath, let scope):
            DiffScreen(
                workspaceID: workspaceID,
                path: filePath,
                scope: scope,
                client: store.client,
                revision: revision,
                chrome: chrome,
                contextLines: contextLines,
                onBack: onBack
            )
        case .file(let workspaceID, let filePath):
            FileViewerScreen(
                workspaceID: workspaceID,
                path: filePath,
                client: store.client,
                workspacePath: store.snapshot.workspaces
                    .first { $0.id == workspaceID }?.path ?? "",
                revision: revision,
                chrome: chrome,
                onBack: onBack
            )
        }
    }

    private var revision: String {
        if let revisionOverride { return revisionOverride }
        guard let workspace = store.snapshot.workspaces.first(where: { $0.id == workspaceID }) else {
            return "\(store.connection)"
        }
        return "\(workspace.lastActivityAt)|\(workspace.changedFiles)|\(store.connection)"
    }

    private var workspaceID: String {
        switch detail {
        case .diff(let workspaceID, _, _), .file(let workspaceID, _): return workspaceID
        }
    }
}
