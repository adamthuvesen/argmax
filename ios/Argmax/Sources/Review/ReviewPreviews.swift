#if DEBUG
import SwiftUI

// Fixtures for the review surface's `#Preview`s, and only for them.
//
// Every state of every screen has to be reachable without a Mac attached —
// the design brief's rule, and the only way a light/dark pass can be made on
// the states that need a running agent to produce.

@MainActor
let previewReviewWorkspace = WorkspaceSummary(
    id: "w-review",
    projectId: "p-argmax",
    taskLabel: "Native review surface",
    branch: "adam/feat-native-review",
    baseRef: "main",
    path: "/Users/you/dev/argmax-worktrees/native-review",
    state: .running,
    kind: .git,
    sharedWorkspace: false,
    dirty: true,
    changedFiles: 6,
    lastActivityAt: "2026-09-11T12:00:00.000Z",
    pinned: false
)

let previewChangedFiles: [ChangedFileSummary] = [
    // Four digits on purpose: `Text("+\(count)")` groups them ("+2 905"),
    // and a preview that only ever shows two-digit counts cannot catch it.
    ChangedFileSummary(
        path: "ios/Argmax/Sources/Review/ReviewScreen.swift",
        status: "A ", additions: 2905, deletions: 1145, staged: false
    ),
    ChangedFileSummary(
        path: "ios/Argmax/Sources/Review/CodeText.swift",
        status: "A ", additions: 176, deletions: 0, staged: false
    ),
    ChangedFileSummary(
        path: "src/renderer/mobile/MobileApp.tsx",
        status: "M ", additions: 21, deletions: 34, staged: false
    ),
    ChangedFileSummary(
        path: "src/renderer/mobile/nativeHost.ts",
        status: "M ", additions: 9, deletions: 7, staged: true
    ),
    ChangedFileSummary(
        path: "ios/Argmax/Sources/Review/FileTreeView.swift",
        status: "R ", additions: 4, deletions: 4, staged: false,
        oldPath: "ios/Argmax/Sources/Review/WorkspaceTree.swift"
    ),
    ChangedFileSummary(
        path: "docs/plan/hybrid-native-phone.md",
        status: " D", additions: 0, deletions: 12, staged: false
    )
]

let previewFileEntries: [WorkspaceFileEntry] = [
    "ios/Argmax/Sources/Review/CodeDocument.swift",
    "ios/Argmax/Sources/Review/CodeText.swift",
    "ios/Argmax/Sources/Review/DiffParser.swift",
    "ios/Argmax/Sources/Review/ReviewScreen.swift",
    "ios/Argmax/Sources/Design/Theme.swift",
    "ios/Argmax/Tests/DiffParserTests.swift",
    "src/renderer/mobile/MobileApp.tsx",
    "src/renderer/mobile/nativeHost.ts",
    "src/shared/bindings.d.ts",
    "docs/remote.md",
    "AGENTS.md",
    "README.md"
].map { WorkspaceFileEntry(path: $0) }

/// A diff with all four block kinds in it: a hunk, a gap, a second hunk, and
/// the tail the host dropped.
let previewDiffBlocks: [ParsedDiffBlock] = DiffParser.parse("""
diff --git a/src/renderer/mobile/nativeHost.ts b/src/renderer/mobile/nativeHost.ts
--- a/src/renderer/mobile/nativeHost.ts
+++ b/src/renderer/mobile/nativeHost.ts
@@ -64,8 +64,12 @@ export type NativeMessage =
   /** The web asked to leave the session — its own back affordance. */
   | { type: "back" }
-  /** The review screen opened or closed, so native can hide its own bar. */
-  | { type: "review"; open: boolean }
+  /**
+   * Open the review surface — the transcript's Changes button, or a file
+   * reference tapped in a message. In embed mode the screen is native.
+   */
+  | { type: "openReview"; sessionId: string; filePath: string | null }
   /**
    * The peek at delegated work opened or closed.
    */
@@ -160,7 +164,6 @@ export function installNativeApi(handlers: NativeApi): () => void {
     },
     closeSession: () => handlers.closeSession(),
-    openReview: () => handlers.openReview(),
     setTheme: (mode: ResolvedTheme) => {
       if (mode !== "light" && mode !== "dark") {
         logger.error("renderer.native-host", "setTheme: not a theme", { mode });
[diff truncated at 1048576 bytes; dropped 8192 bytes]
""")

let previewFileText = """
import SwiftUI

/// One changed file. The glyph column carries git's letter, the path keeps
/// its filename when it has to truncate, and the counts are the diff's own
/// inks — never the accent, which in this app means the running thing.
struct ChangedFileRow: View {
    let file: ChangedFileSummary

    var body: some View {
        HStack(spacing: Spacing.row) {
            Text(ChangedFileStatus.glyph(file.status))
                .typeStyle(.footnote, weight: .semibold, mono: true)
                .foregroundStyle(ChangedFileStatus.tint(file.status))
                .frame(width: Spacing.glyphColumn, alignment: .leading)
            Spacer(minLength: Spacing.snug)
            ChangeCount(additions: file.additions, deletions: file.deletions)
        }
        .screenGutter()
        .padding(.vertical, Spacing.row)
    }
}
"""

@MainActor
func previewReviewStore(
    files: [ChangedFileSummary]? = previewChangedFiles,
    entries: [WorkspaceFileEntry]? = previewFileEntries,
    failure: String? = nil
) -> ReviewStore {
    let store = ReviewStore(
        workspace: previewReviewWorkspace,
        client: previewClient(),
        // Its own defaults, so a preview never writes the phone's scope.
        defaults: UserDefaults(suiteName: "argmax.preview") ?? .standard
    )
    store.seed(files: files, entries: entries, failure: failure)
    return store
}

/// Both appearances, every time. The brief's rule is that light and dark are
/// designed rather than derived, and the only way to hold to it is to look at
/// both on every change.
struct ReviewPreviewFrame<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        NavigationStack {
            content
        }
        .environmentObject(previewStore())
    }
}

#Preview("Changes · dark") {
    ReviewPreviewFrame { ReviewScreen(store: previewReviewStore()) }
        .preferredColorScheme(.dark)
}

#Preview("Changes · light") {
    ReviewPreviewFrame { ReviewScreen(store: previewReviewStore()) }
        .preferredColorScheme(.light)
}

#Preview("Changes · nothing changed") {
    ReviewPreviewFrame { ReviewScreen(store: previewReviewStore(files: [])) }
        .preferredColorScheme(.dark)
}

#Preview("Changes · the Mac said no") {
    ReviewPreviewFrame {
        ReviewScreen(store: previewReviewStore(failure: "Not a git checkout."))
    }
    .preferredColorScheme(.dark)
}

#Preview("Changes · still arriving") {
    ReviewPreviewFrame {
        ReviewScreen(store: previewReviewStore(files: nil, entries: nil))
    }
    .preferredColorScheme(.dark)
}

#Preview("Files · dark") {
    ReviewPreviewFrame { ReviewScreen(store: previewReviewStore(), mode: .files) }
        .preferredColorScheme(.dark)
}

#Preview("Files · light") {
    ReviewPreviewFrame { ReviewScreen(store: previewReviewStore(), mode: .files) }
        .preferredColorScheme(.light)
}

#Preview("Diff · dark") {
    ReviewPreviewFrame {
        DiffScreen(path: "src/renderer/mobile/nativeHost.ts", blocks: previewDiffBlocks)
    }
    .preferredColorScheme(.dark)
}

#Preview("Diff · light") {
    ReviewPreviewFrame {
        DiffScreen(path: "src/renderer/mobile/nativeHost.ts", blocks: previewDiffBlocks)
    }
    .preferredColorScheme(.light)
}

/// What the review screen actually shows once a file is open: the header says
/// which file this is, so the viewer under it is code and nothing else.
#Preview("Diff · under the review header") {
    let detail = ReviewDetail.diff(workspaceID: "preview", path: ".gitattributes", scope: .branch)
    return ReviewPreviewFrame {
        VStack(spacing: 0) {
            ScreenHeader(title: detail.fileName, subtitle: detail.pathAndKind, onBack: {}) {
                ReviewContextButton {}
            }
            DiffScreen(path: ".gitattributes", blocks: previewDiffBlocks, chrome: .embedded)
        }
    }
    .preferredColorScheme(.light)
}

#Preview("Diff · no textual diff") {
    ReviewPreviewFrame { DiffScreen(path: "assets/icon.png", blocks: []) }
        .preferredColorScheme(.dark)
}

#Preview("File · dark") {
    ReviewPreviewFrame {
        FileViewerScreen(
            path: "ios/Argmax/Sources/Review/ReviewScreen.swift",
            preview: .text(content: previewFileText, size: 1_024, mtimeMs: 0)
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("File · light") {
    ReviewPreviewFrame {
        FileViewerScreen(
            path: "ios/Argmax/Sources/Review/ReviewScreen.swift",
            preview: .text(content: previewFileText, size: 1_024, mtimeMs: 0)
        )
    }
    .preferredColorScheme(.light)
}

#Preview("File · too large") {
    ReviewPreviewFrame {
        FileViewerScreen(
            path: "assets/sprites.bin",
            preview: .skipped(reason: .tooLarge, size: 8_400_000)
        )
    }
    .preferredColorScheme(.dark)
}

#Preview("File · binary") {
    ReviewPreviewFrame {
        FileViewerScreen(path: "assets/fox.dat", preview: .skipped(reason: .binary, size: 2_048))
    }
    .preferredColorScheme(.dark)
}
#endif
