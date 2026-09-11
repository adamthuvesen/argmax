import SwiftUI

/// One file's diff, with the whole screen to itself.
///
/// The context ladder is a single control rather than a button in every gap
/// between hunks. `contextLines` is a property of the request, not of a gap —
/// every one of the desktop's inline buttons re-reads the whole file at the
/// next rung — so one control that says what it does is the honest shape, and
/// the gaps say what they are hiding.
struct DiffScreen: View {
    let workspaceID: String
    let path: String
    let scope: ReviewScope
    let client: BridgeClient

    private var revision = ""
    private var onBack: (() -> Void)?
    @State private var contentRevision = 0

    @Environment(\.dismiss) private var dismiss
    @State private var load: ReviewLoad = .idle
    /// Nil is git's own three lines — the rung an untouched diff arrives at.
    @State private var contextLines: Int?
    @State private var blocks: [ParsedDiffBlock] = []
    @State private var token = 0
    /// A canvas render has no Mac to read from.
    private var canvas = false

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            content
                .safeAreaInset(edge: .top, spacing: 0) { header }
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .task(id: "\(revision)|\(contextLines.map(String.init) ?? "default")") {
            guard !canvas else { return }
            await fetch(contextLines)
        }
    }

    init(workspaceID: String, path: String, scope: ReviewScope, client: BridgeClient, revision: String = "", onBack: (() -> Void)? = nil) {
        self.workspaceID = workspaceID
        self.path = path
        self.scope = scope
        self.client = client
        self.revision = revision
        self.onBack = onBack
    }

    #if DEBUG
    /// The `#Preview` path: a diff that is already parsed, or a state that
    /// never had one.
    init(path: String, blocks: [ParsedDiffBlock], load: ReviewLoad = .ready) {
        workspaceID = "preview"
        self.path = path
        scope = .branch
        client = previewClient()
        _blocks = State(initialValue: blocks)
        _load = State(initialValue: load)
        canvas = true
    }
    #endif

    private var header: some View {
        ScreenHeader(title: fileName, subtitle: directory, onBack: { if let onBack { onBack() } else { dismiss() } }) {
            expandControl
        }
    }

    /// Only while there is a rung left to climb, and never over a diff that
    /// failed or is still arriving.
    @ViewBuilder
    private var expandControl: some View {
        if load == .ready, DiffParser.nextContext(after: contextLines) != nil, hasGaps {
            Button {
                Haptics.light()
                contextLines = DiffParser.nextContext(after: contextLines)
            } label: {
                Image(systemName: "arrow.up.and.down.text.horizontal")
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 32, height: 32)
                    .contentShape(.rect)
            }
            .buttonStyle(PressDim())
            .accessibilityLabel("Show more unchanged lines")
        }
    }

    private var hasGaps: Bool {
        blocks.contains { if case .omitted = $0 { return true } else { return false } }
    }

    @ViewBuilder
    private var content: some View {
        if let message = load.message {
            EmptyState(
                mark: .glyph("exclamationmark.triangle"),
                message: message,
                action: ("Try again", { Task { await fetch(contextLines) } })
            )
        } else if load == .ready, blocks.isEmpty {
            EmptyState(mark: .glyph("equal.circle"), message: "No textual diff for this file.")
        } else if blocks.isEmpty {
            LoadingRows(rows: 12)
        } else {
            CodeTextView(document: CodeDocument(
                content: .diff(blocks),
                // The rung is in the key: climbing it is a different string
                // for the same path, and without it the view would keep the
                // diff the reader just asked to expand.
                key: "\(path)|\(scope.rawValue)|\(contextLines.map(String.init) ?? "default")|\(contentRevision)"
            ))
            .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    private var fileName: String { String(path.split(separator: "/").last ?? Substring(path)) }

    private var directory: String {
        let components = path.split(separator: "/").dropLast()
        return components.isEmpty ? scope.label : components.joined(separator: "/")
    }

    private func fetch(_ context: Int?) async {
        token += 1
        let current = token
        load = .loading
        do {
            let loaded = try await client.loadDiff(
                workspaceID: workspaceID,
                filePath: path,
                comparison: scope.comparison,
                contextLines: context
            )
            guard current == token else { return }
            // Parsing a large diff is real work and it is not the main
            // thread's. The view has a loading state for exactly this.
            let parsed = await Task.detached(priority: .userInitiated) {
                DiffParser.parse(loaded.content)
            }.value
            guard current == token else { return }
            try Task.checkCancellation()
            if blocks != parsed { contentRevision += 1 }
            blocks = parsed
            load = .ready
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            guard current == token else { return }
            blocks = []
            load = .failed(hostFailureMessage(error))
        }
    }
}
