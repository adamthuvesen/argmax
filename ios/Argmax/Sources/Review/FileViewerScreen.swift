import SwiftUI

/// One file from the checkout, read-only.
///
/// Read-only on purpose, the same call the page's own review screen makes: a
/// phone has no Cmd+S and no room for a save affordance, a stray tap in an
/// editor would strand an unsaved buffer in a pocket, and the mtime-checked
/// write behind the desktop's editor exists to lose nothing in a shared
/// checkout — which is a promise this screen would rather not make than make
/// badly.
///
/// Markdown is shown as its source rather than rendered. The rendered toggle
/// on the desktop rides a full Markdown pipeline; a half-built one here would
/// only be able to disagree with it.
struct FileViewerScreen: View {
    let workspaceID: String
    let path: String
    let client: BridgeClient
    /// The checkout's absolute path, which is what the image endpoint takes.
    let workspacePath: String

    private var revision = ""
    private var onBack: (() -> Void)?
    private var chrome: ViewerChrome = .pushed
    @State private var contentRevision = 0
    @State private var token = 0

    @Environment(\.dismiss) private var dismiss
    @State private var preview: WorkspaceFilePreview?
    @State private var load: ReviewLoad = .idle
    /// A canvas render has no Mac to read from.
    private var canvas = false

    var body: some View {
        ZStack {
            Theme.ground.ignoresSafeArea()
            switch chrome {
            case .pushed:
                content.safeAreaInset(edge: .top, spacing: 0) { header }
            case .embedded:
                content
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .task(id: revision) {
            guard !canvas else { return }
            await fetch()
        }
    }

    init(
        workspaceID: String,
        path: String,
        client: BridgeClient,
        workspacePath: String,
        revision: String = "",
        chrome: ViewerChrome = .pushed,
        onBack: (() -> Void)? = nil
    ) {
        self.workspaceID = workspaceID
        self.path = path
        self.client = client
        self.workspacePath = workspacePath
        self.revision = revision
        self.chrome = chrome
        self.onBack = onBack
    }

    #if DEBUG
    /// The `#Preview` path: a file that has already been read, or one of the
    /// three ways it had no text to give.
    init(path: String, preview loaded: WorkspaceFilePreview?, load: ReviewLoad = .ready) {
        workspaceID = "preview"
        self.path = path
        client = previewClient()
        workspacePath = "/tmp/preview"
        _preview = State(initialValue: loaded)
        _load = State(initialValue: load)
        canvas = true
    }
    #endif

    private var header: some View {
        ScreenHeader(title: fileName, subtitle: subtitle, onBack: { if let onBack { onBack() } else { dismiss() } })
    }

    @ViewBuilder
    private var content: some View {
        if isOutsideCheckout {
            EmptyState(mark: .glyph("doc.questionmark"), message: "This file is outside the chat's checkout.")
        } else if let message = load.message {
            EmptyState(
                mark: .glyph("exclamationmark.triangle"),
                message: message,
                action: ("Try again", { Task { await fetch() } })
            )
        } else {
            switch preview {
            case .text(let text, _, _):
                CodeTextView(document: CodeDocument(content: .file(text), key: "\(path)|\(contentRevision)"))
                    .ignoresSafeArea(.container, edges: .bottom)
            case .skipped(let reason, let size):
                skipped(reason, size)
            case .unreadable:
                EmptyState(mark: .glyph("doc.questionmark"), message: "Can't show this file.")
            case nil:
                LoadingRows(rows: 14)
            }
        }
    }

    /// The three ways a file has no text. An image is the one of them worth a
    /// screen rather than a sentence: `workspace:read-file` reports every PNG
    /// as binary, so the bytes come over the same authenticated endpoint the
    /// transcript's screenshots use.
    @ViewBuilder
    private func skipped(_ reason: SkippedReason, _ size: Int?) -> some View {
        if reason == .binary, WorkspaceImage.isImage(path) {
            WorkspaceImageView(
                absolutePath: workspacePath + "/" + path,
                client: client,
                revision: revision
            )
        } else {
            EmptyState(
                mark: .glyph(reason == .binary ? "doc.zipper" : "doc"),
                message: message(for: reason, size: size)
            )
        }
    }

    private func message(for reason: SkippedReason, size: Int?) -> String {
        switch reason {
        case .binary: return "This is a binary file."
        case .tooLarge:
            guard let size else { return "This file is too large to show." }
            return "This file is \(CodeDocument.formatBytes(size)) — too large to show."
        case .notAFile: return "There is nothing at this path."
        }
    }

    /// A path the review route could not make relative: an agent linked a
    /// file in another checkout, which `workspace:read-file` cannot reach.
    private var isOutsideCheckout: Bool { path.hasPrefix("/") }

    private var fileName: String { String(path.split(separator: "/").last ?? Substring(path)) }

    private var subtitle: String {
        let directory = path.split(separator: "/").dropLast().joined(separator: "/")
        guard case .text(_, let size, _) = preview else { return directory }
        return directory.isEmpty
            ? CodeDocument.formatBytes(size)
            : "\(directory) · \(CodeDocument.formatBytes(size))"
    }

    private func fetch() async {
        guard !isOutsideCheckout else { return }
        token += 1
        let current = token
        load = .loading
        do {
            let loaded = try await client.readWorkspaceFile(workspaceID: workspaceID, filePath: path)
            guard current == token else { return }
            try Task.checkCancellation()
            if preview != loaded { contentRevision += 1 }
            preview = loaded
            load = .ready
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, current == token else { return }
            preview = nil
            load = .failed(hostFailureMessage(error))
        }
    }
}
