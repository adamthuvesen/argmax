import OSLog
import SwiftUI

// What the review screen knows: one workspace's changed files and one
// workspace's file list.
//
// Deliberately not a cache of diffs or file contents. Each file's diff and
// each file's text are read by the screen that shows them, which owns one
// request and one token guard — the desktop hook keys a shared cache by
// `path@contextLines` precisely because its panel can show two files at
// once, and a drill-down that can show one has nothing to key.
//
// Nothing polls. The Changes list re-reads when the workspace's own row moves
// under it (an agent writing mid-turn changes `changedFiles` and
// `lastActivityAt` on the dashboard delta the socket is already delivering),
// and on pull to refresh.

/// What the phone offers as "which changes". Three, not the desktop's four:
/// "Last turn" is not a git query — it reads the session's timeline — and the
/// page's own review screen has never offered it here either
/// (`MobileReviewScreen` passes no `lastTurnPaths`).
enum ReviewScope: String, CaseIterable, Identifiable, Sendable {
    case branch
    case committed
    case uncommitted

    var id: String { rawValue }

    /// `REVIEW_SCOPE_LABELS` in `useReviewState.ts`, word for word.
    var label: String {
        switch self {
        case .branch: return "All on branch"
        case .committed: return "Committed"
        case .uncommitted: return "Uncommitted"
        }
    }

    var detail: String {
        switch self {
        case .branch: return "Committed, uncommitted and untracked"
        case .committed: return "Only what has landed as commits"
        case .uncommitted: return "Only the working tree"
        }
    }

    /// What "no rows" means for this slice, which is a different sentence
    /// each time.
    var emptyMessage: String {
        switch self {
        case .branch: return "Nothing changed on this branch."
        case .committed: return "Nothing committed on this branch yet."
        case .uncommitted: return "Nothing uncommitted — the worktree is clean."
        }
    }

    var comparison: ReviewComparison {
        switch self {
        case .branch: return .branch
        case .committed: return .committed
        case .uncommitted: return .workingTree
        }
    }
}

/// A read that can be waiting, done, or broken. Rows already on screen stay
/// through a reload: a list that blanks every time an agent writes a file is
/// unreadable while a turn runs.
enum ReviewLoad: Equatable {
    case idle
    case loading
    case ready
    case failed(String)

    var isLoading: Bool { self == .loading }

    var message: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

@MainActor
final class ReviewStore: ObservableObject {
    @Published private(set) var files: [ChangedFileSummary] = []
    @Published private(set) var filesLoad: ReviewLoad = .idle
    @Published private(set) var entries: [WorkspaceFileEntry] = []
    @Published private(set) var entriesLoad: ReviewLoad = .idle

    /// Persisted across chats and launches, like the desktop's
    /// `argmax.reviewPanel.changesScope`. One preference for the phone: which
    /// slice you read is a habit, not a property of a chat.
    @Published var scope: ReviewScope {
        didSet {
            guard scope != oldValue else { return }
            defaults.set(scope.rawValue, forKey: Self.scopeKey)
            Task { await loadChangedFiles() }
        }
    }

    let workspace: WorkspaceSummary
    private let client: BridgeClient
    private let defaults: UserDefaults
    private static let scopeKey = "argmax.review.scope"
    private let log = Logger(subsystem: "com.argmax.remote", category: "review")

    /// Guards against a slow answer for an old scope landing on a new one.
    private var filesToken = 0
    private var entriesToken = 0
    /// What the last successful file list was read against. A re-read is only
    /// worth blanking the tree for when the workspace itself changed.
    private var lastEntriesSignature: String?

    init(workspace: WorkspaceSummary, client: BridgeClient, defaults: UserDefaults = .standard) {
        self.workspace = workspace
        self.client = client
        self.defaults = defaults
        scope = ReviewScope(rawValue: defaults.string(forKey: Self.scopeKey) ?? "") ?? .branch
    }

    #if DEBUG
    /// Fill the store without a socket, so every state of the screen is
    /// reachable in a `#Preview`. Debug-only: the canvas has no Mac.
    func seed(files: [ChangedFileSummary]? = nil, entries: [WorkspaceFileEntry]? = nil, failure: String? = nil) {
        if let failure {
            filesLoad = .failed(failure)
            entriesLoad = .failed(failure)
            return
        }
        if let files {
            self.files = files
            filesLoad = .ready
        }
        if let entries {
            self.entries = entries
            entriesLoad = .ready
            lastEntriesSignature = workspace.id
        }
    }
    #endif

    var totalAdditions: Int { files.reduce(0) { $0 + $1.additions } }
    var totalDeletions: Int { files.reduce(0) { $0 + $1.deletions } }

    func loadChangedFiles() async {
        filesToken += 1
        let token = filesToken
        // Rows already drawn stay: only the first read of a workspace has
        // nothing to show under a spinner.
        filesLoad = .loading
        do {
            let loaded = try await client.listChangedFiles(
                workspaceID: workspace.id,
                comparison: scope.comparison
            )
            guard token == filesToken else { return }
            files = loaded
            filesLoad = .ready
        } catch {
            guard token == filesToken else { return }
            log.error("changed files failed: \(String(describing: error), privacy: .public)")
            files = []
            filesLoad = .failed(hostFailureMessage(error))
        }
    }

    /// The whole worktree, not a comparison-scoped set — `workspace:list-files`
    /// has no comparison to take.
    func loadFileList(force: Bool = false) async {
        // The signature is the workspace, not the changed files: re-listing
        // on every write would fight the tree's own scroll for no new paths
        // in the common case. Pull to refresh is the way to pick up a file
        // git never saw.
        let signature = workspace.id
        if !force, lastEntriesSignature == signature, entriesLoad == .ready { return }
        entriesToken += 1
        let token = entriesToken
        if lastEntriesSignature != signature { entries = [] }
        entriesLoad = .loading
        do {
            let loaded = try await client.listWorkspaceFiles(workspaceID: workspace.id)
            guard token == entriesToken else { return }
            entries = loaded
            lastEntriesSignature = signature
            entriesLoad = .ready
        } catch {
            guard token == entriesToken else { return }
            log.error("file list failed: \(String(describing: error), privacy: .public)")
            entries = []
            entriesLoad = .failed(hostFailureMessage(error))
        }
    }

    func loadDiff(path: String, contextLines: Int?) async throws -> WorkspaceDiff {
        try await client.loadDiff(
            workspaceID: workspace.id,
            filePath: path,
            comparison: scope.comparison,
            contextLines: contextLines
        )
    }

    func readFile(path: String) async throws -> WorkspaceFilePreview {
        try await client.readWorkspaceFile(workspaceID: workspace.id, filePath: path)
    }
}

// MARK: - Status vocabulary

/// Git's porcelain code for a row, read the way the desktop reads it
/// (`statusLabel` in `src/renderer/lib/changedFiles.ts`).
///
/// The status is porcelain v1's two-column `XY` — index change, then worktree
/// change — so the primary column decides. Matching on whole letters instead
/// lets a combo code like `AD` ("added in the index, deleted in the worktree")
/// be claimed by every alternative that shares a letter.
enum ChangedFileStatus {
    static func label(_ status: String) -> String {
        if status == "??" { return "Added" }
        let characters = Array(status)
        switch characters.first {
        case "A": return "Added"
        case "D": return "Deleted"
        case "R": return "Renamed"
        case "C": return "Copied"
        case " ":
            // Index unchanged; the worktree column decides.
            return characters.count > 1 && characters[1] == "D" ? "Deleted" : "Modified"
        default: return "Modified"
        }
    }

    /// The single letter the row's glyph column carries.
    static func glyph(_ status: String) -> String {
        String(label(status).prefix(1))
    }

    /// Added and deleted are the two a reader scans for, so they carry the
    /// diff's own inks. Everything else is a modification and stays quiet:
    /// a list where every row is coloured ranks nothing.
    static func tint(_ status: String) -> Color {
        switch label(status) {
        case "Added": return Theme.diffAddInk
        case "Deleted": return Theme.diffDelInk
        default: return Theme.muted
        }
    }
}
