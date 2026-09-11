import XCTest
@testable import Argmax

/// The tree the Files view draws, ported from `src/renderer/lib/fileTree.ts`
/// and the flattening in `WorkspaceTree.tsx`.
final class FileTreeTests: XCTestCase {
    private func entries(_ paths: [String]) -> [WorkspaceFileEntry] {
        paths.map { WorkspaceFileEntry(path: $0) }
    }

    func testInfersFoldersFromFlatPaths() {
        let root = FileTree.build(entries(["src/app/main.ts", "src/app/util.ts", "README.md"]))
        // Folders sort before files, then by name — the desktop's own order.
        XCTAssertEqual(root.children.map(\.name), ["src", "README.md"])
        XCTAssertEqual(root.children.map(\.isDirectory), [true, false])
        XCTAssertEqual(root.children[0].children[0].path, "src/app")
        XCTAssertEqual(root.children[0].children[0].children.map(\.name), ["main.ts", "util.ts"])
    }

    func testShowsOnlyWhatIsOpen() {
        let root = FileTree.build(entries(["src/app/main.ts", "README.md"]))
        XCTAssertEqual(FileTree.flatten(root, expanded: []).map(\.path), ["src", "README.md"])
        XCTAssertEqual(
            FileTree.flatten(root, expanded: ["src"]).map(\.path),
            ["src", "src/app", "README.md"]
        )
        XCTAssertEqual(
            FileTree.flatten(root, expanded: ["src", "src/app"]).map(\.path),
            ["src", "src/app", "src/app/main.ts", "README.md"]
        )
    }

    func testDepthIsTheIndentTheRowDraws() {
        let root = FileTree.build(entries(["a/b/c.txt"]))
        let rows = FileTree.flatten(root, expanded: ["a", "a/b"])
        XCTAssertEqual(rows.map(\.depth), [0, 1, 2])
    }

    /// What revealing a file from outside the tree has to open first.
    func testAncestorsAreEveryEnclosingFolderOutermostFirst() {
        XCTAssertEqual(FileTree.ancestors(of: "a/b/c.txt"), ["a", "a/b"])
        XCTAssertEqual(FileTree.ancestors(of: "README.md"), [])
    }

    /// A repeated path is one file, not two rows. `workspace:list-files` should
    /// not send one, but a tree that doubles a row on a duplicate is a tree
    /// that doubles every row in a checkout with a symlink loop.
    func testCollapsesRepeatedPaths() {
        let root = FileTree.build(entries(["a/b.txt", "a/b.txt"]))
        XCTAssertEqual(FileTree.flatten(root, expanded: ["a"]).map(\.path), ["a", "a/b.txt"])
    }
}

/// The wire shapes. Hand-written mirrors drift, so these pin them against the
/// payloads in `src/shared/bindings.d.ts`.
final class ReviewWireTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testDecodesAChangedFileIncludingARename() throws {
        let files = try decode(
            """
            [{"path":"src/b.ts","status":"R ","additions":4,"deletions":2,
              "staged":true,"oldPath":"src/a.ts"}]
            """,
            as: [ChangedFileSummary].self
        )
        XCTAssertEqual(files.first?.oldPath, "src/a.ts")
        XCTAssertEqual(files.first?.staged, true)
    }

    /// `oldPath` is absent for everything that is not a rename, and an absent
    /// key must not throw.
    func testDecodesAChangedFileWithoutAnOldPath() throws {
        let files = try decode(
            #"[{"path":"a.ts","status":"M ","additions":1,"deletions":0,"staged":false}]"#,
            as: [ChangedFileSummary].self
        )
        XCTAssertNil(files.first?.oldPath)
    }

    func testDecodesBothFilePreviewVariants() throws {
        let text = try decode(
            #"{"kind":"text","content":"hello","size":5,"mtimeMs":1.5}"#,
            as: WorkspaceFilePreview.self
        )
        XCTAssertEqual(text, .text(content: "hello", size: 5, mtimeMs: 1.5))

        let skipped = try decode(
            #"{"kind":"skipped","reason":"too-large","size":9000000}"#,
            as: WorkspaceFilePreview.self
        )
        XCTAssertEqual(skipped, .skipped(reason: .tooLarge, size: 9_000_000))
    }

    /// A `kind` or a `reason` this app has not heard of has to decode, not
    /// throw: a host that adds one must never take a screen down.
    func testDecodesUnknownPreviewKindsAndReasons() throws {
        XCTAssertEqual(
            try decode(#"{"kind":"streamed"}"#, as: WorkspaceFilePreview.self),
            .unreadable(kind: "streamed")
        )
        XCTAssertEqual(
            try decode(#"{"kind":"skipped","reason":"encrypted"}"#, as: WorkspaceFilePreview.self),
            .skipped(reason: .notAFile, size: nil)
        )
    }

    /// The host's input structs are `deny_unknown_fields`, and its
    /// `context_lines` is an `Option` that the renderer sends as an explicit
    /// `null`. Both halves of that are pinned here.
    func testEncodesTheLoadDiffInputTheHostAccepts() throws {
        let data = try JSONEncoder().encode(LoadDiffInput(
            id: "workspace-1",
            filePath: "src/a.ts",
            comparison: .branch,
            contextLines: nil
        ))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        XCTAssertEqual(Set(object.keys), ["kind", "id", "filePath", "comparison", "contextLines"])
        XCTAssertEqual(object["kind"] as? String, "workspace")
        XCTAssertEqual(object["comparison"] as? String, "branch")
        XCTAssertTrue(object["contextLines"] is NSNull)
    }

    func testEveryScopeMapsToAComparisonTheHostKnows() {
        XCTAssertEqual(ReviewScope.branch.comparison, .branch)
        XCTAssertEqual(ReviewScope.committed.comparison, .committed)
        // The scope is worded for a reader; the comparison is git's word.
        XCTAssertEqual(ReviewScope.uncommitted.comparison, .workingTree)
    }

    /// All four channels are reads, so none of them may carry an operation
    /// record — the host would durably record a diff request as a mutation.
    func testTheReviewChannelsAreReads() {
        for channel in [
            "review:list-changed-files",
            "review:load-diff",
            "workspace:list-files",
            "workspace:read-file"
        ] {
            XCTAssertFalse(RemoteChannels.isMutation(channel), channel)
        }
    }
}

/// Git porcelain `XY`, read the way `statusLabel` reads it.
final class ChangedFileStatusTests: XCTestCase {
    func testReadsThePrimaryColumn() {
        XCTAssertEqual(ChangedFileStatus.label("??"), "Added")
        XCTAssertEqual(ChangedFileStatus.label("A "), "Added")
        XCTAssertEqual(ChangedFileStatus.label("D "), "Deleted")
        XCTAssertEqual(ChangedFileStatus.label("R "), "Renamed")
        XCTAssertEqual(ChangedFileStatus.label("C "), "Copied")
        XCTAssertEqual(ChangedFileStatus.label("M "), "Modified")
    }

    /// `AD` is "added in the index, deleted in the worktree". Matching on any
    /// letter rather than the primary column would call it a deletion.
    func testACombinationCodeIsReadByItsIndexColumn() {
        XCTAssertEqual(ChangedFileStatus.label("AD"), "Added")
        XCTAssertEqual(ChangedFileStatus.label("MD"), "Modified")
    }

    /// An unchanged index leaves the worktree column to decide.
    func testAnUnchangedIndexDefersToTheWorktree() {
        XCTAssertEqual(ChangedFileStatus.label(" D"), "Deleted")
        XCTAssertEqual(ChangedFileStatus.label(" M"), "Modified")
    }

    func testTheGlyphIsTheLabelsFirstLetter() {
        XCTAssertEqual(ChangedFileStatus.glyph("??"), "A")
        XCTAssertEqual(ChangedFileStatus.glyph(" D"), "D")
    }
}

/// The one string in the review surface that quotes a byte count, against the
/// numbers `src/renderer/lib/formatBytes.ts` produces.
final class FormatBytesTests: XCTestCase {
    func testMatchesTheRendererSNumbers() {
        XCTAssertEqual(CodeDocument.formatBytes(0), "0 B")
        XCTAssertEqual(CodeDocument.formatBytes(512), "512 B")
        XCTAssertEqual(CodeDocument.formatBytes(4096), "4.0 KB")
        XCTAssertEqual(CodeDocument.formatBytes(1_048_576), "1.0 MB")
        // Past 100 of a unit the tenth is noise, and the renderer drops it.
        XCTAssertEqual(CodeDocument.formatBytes(200 * 1024 * 1024), "200 MB")
    }
}

/// The four review reads, pinned against real payloads.
///
/// `Tests/Fixtures/review-*.json` and `workspace-file*.json` are trimmed
/// captures of `node scripts/bridge.mjs call <channel>` against this
/// repository — see the README for how to take fresh ones. Hand-written
/// mirrors are exactly the kind of thing that drifts quietly, and a literal
/// written from the same head that wrote the struct only pins what this app
/// already believes.
final class ReviewFixtureTests: XCTestCase {
    private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let bundle = Bundle(for: Self.self)
        let url = try XCTUnwrap(
            bundle.url(forResource: name, withExtension: "json"),
            "\(name).json is not in the test bundle"
        )
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }

    func testDecodesACapturedChangedFileList() throws {
        let files = try fixture("review-changed-files", as: [ChangedFileSummary].self)
        XCTAssertFalse(files.isEmpty)
        XCTAssertTrue(files.contains { $0.path.hasSuffix(".swift") })
        // The host sends a one-column status for a worktree-only change and
        // `??` for an untracked file. Both have to read as words.
        XCTAssertEqual(ChangedFileStatus.label("M"), "Modified")
        XCTAssertTrue(files.contains { ChangedFileStatus.label($0.status) == "Added" })
    }

    /// The real diff, through the real parser. A payload the parser returns
    /// nothing for is the failure this catches: every other test here feeds it
    /// a diff someone wrote by hand.
    func testParsesACapturedDiff() throws {
        let diff = try fixture("review-diff", as: WorkspaceDiff.self)
        XCTAssertFalse(diff.revision.isEmpty)
        let blocks = DiffParser.parse(diff.content)
        XCTAssertFalse(blocks.isEmpty)
        let lines = blocks.flatMap { block -> [ParsedDiffLine] in
            if case .hunk(_, _, let lines) = block { return lines }
            return []
        }
        XCTAssertTrue(lines.contains { $0.kind == .addition })
        // Every line carries the number its gutter will show.
        XCTAssertTrue(lines.allSatisfy { $0.displayLineNumber != nil })
        // And the numbers only ever climb within one side of one hunk.
        for case .hunk(_, _, let hunkLines) in blocks {
            let added = hunkLines.filter { $0.kind != .deletion }.compactMap(\.newLineNumber)
            XCTAssertEqual(added, added.sorted())
        }
    }

    func testBuildsATreeFromACapturedFileList() throws {
        let entries = try fixture("workspace-files", as: [WorkspaceFileEntry].self)
        let root = FileTree.build(entries)
        XCTAssertFalse(root.children.isEmpty)
        // Folders before files, at every level.
        XCTAssertEqual(
            root.children.map(\.isDirectory),
            root.children.map(\.isDirectory).sorted { $0 && !$1 }
        )
        // Every entry is reachable once the tree is fully open.
        let allFolders = Set(entries.flatMap { FileTree.ancestors(of: $0.path) })
        let rows = FileTree.flatten(root, expanded: allFolders)
        XCTAssertEqual(
            Set(rows.filter { !$0.isDirectory }.map(\.path)),
            Set(entries.map(\.path))
        )
    }

    func testDecodesCapturedFileReads() throws {
        let text = try fixture("workspace-file-text", as: WorkspaceFilePreview.self)
        guard case .text(let content, let size, _) = text else {
            return XCTFail("expected text")
        }
        XCTAssertFalse(content.isEmpty)
        XCTAssertGreaterThan(size, 0)

        // An image comes back as a skip, which is why the viewer has to fetch
        // its bytes over HTTP rather than expecting them here.
        let binary = try fixture("workspace-file-binary", as: WorkspaceFilePreview.self)
        guard case .skipped(let reason, let size) = binary else {
            return XCTFail("expected a skip")
        }
        XCTAssertEqual(reason, .binary)
        XCTAssertNotNil(size)
    }
}

/// The image endpoint the file viewer falls back to.
final class WorkspaceImageTests: XCTestCase {
    func testClaimsOnlyTheExtensionsTheHostServes() {
        XCTAssertTrue(WorkspaceImage.isImage("assets/icon.png"))
        XCTAssertTrue(WorkspaceImage.isImage("assets/Fox.WEBP"))
        XCTAssertFalse(WorkspaceImage.isImage("src/main.ts"))
        XCTAssertFalse(WorkspaceImage.isImage("Makefile"))
        // An SVG reads back as text, so it never reaches the image branch —
        // and claiming it here would swap a readable source file for a render.
        XCTAssertFalse(WorkspaceImage.isImage("assets/logo.svg"))
    }

    /// The token rides in the header, and every path segment is encoded on
    /// its own so a space survives the trip.
    func testBuildsAnAuthenticatedRequestForAnAbsolutePath() throws {
        let client = try BridgeClient(
            pairingURL: XCTUnwrap(URL(string: "https://mac.ts.net/mobile.html#token=abc"))
        )
        let request = try XCTUnwrap(client.assetRequest(absolutePath: "/tmp/my repo/a b.png"))
        XCTAssertEqual(
            request.url?.absoluteString,
            "https://mac.ts.net/api/workspace-assets/tmp/my%20repo/a%20b.png"
        )
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
    }
}
