import Foundation

// The review surface's wire vocabulary.
//
// Every type here mirrors a generated binding in `src/shared/bindings.d.ts`
// field for field — `ChangedFileSummary`, `WorkspaceDiff`,
// `WorkspaceFileEntry`, `WorkspaceFilePreview` — and the four inputs mirror
// the `deny_unknown_fields` structs in `src-tauri/src/ipc/inputs.rs`. The
// renderer's own call site is the specification for what a request carries:
// `src/renderer/lib/reviewIpc.ts`.
//
// All four channels are reads (`src/shared/remoteReadChannels.json`), so none
// of them carries an operation record.

/// Which slice of the work the Changes view compares.
///
/// `ReviewComparison` in the bindings. The host defaults it, but the phone
/// always sends one: a request whose meaning depends on a default is a
/// request you cannot read in a log.
enum ReviewComparison: String, Codable, Hashable, Sendable {
    case workingTree
    case branch
    case committed
}

/// `ChangedFileSummary`. One row of the Changes list.
struct ChangedFileSummary: Codable, Hashable, Sendable, Identifiable {
    var path: String
    /// Git's own porcelain letter, lowercased by the host: `modified`,
    /// `added`, `deleted`, `renamed`, `untracked`. Kept as a string because
    /// a status this app has not heard of must still draw a row.
    var status: String
    var additions: Int
    var deletions: Int
    /// True when the index differs from HEAD for this path. The phone never
    /// stages, so this is read-only here — it is carried so the row can say
    /// what the desktop's row says.
    var staged: Bool
    var oldPath: String?

    var id: String { path }
}

/// `WorkspaceDiff`. One file's unified diff, or the whole workspace's when
/// `filePath` is nil.
struct WorkspaceDiff: Codable, Hashable, Sendable {
    var workspaceId: String
    var filePath: String?
    var content: String
    /// The host's identity for the exact diff shown. Mutations must present
    /// it; the phone does not mutate, so it is carried and unused — dropping
    /// it would make this a different type from the one on the wire.
    var revision: String
}

/// `WorkspaceFileEntry`. The tree arrives flat: one repo-relative path per
/// file, no directories of their own.
struct WorkspaceFileEntry: Codable, Hashable, Sendable {
    var path: String
}

/// `SkippedReason`. Why a file has no text to show.
enum SkippedReason: String, Codable, Hashable, Sendable {
    case notAFile = "not-a-file"
    case tooLarge = "too-large"
    case binary
}

/// `WorkspaceFilePreview`. Internally tagged by `kind`, so it needs its own
/// decoder — and an unknown tag has to decode rather than throw, the same
/// rule every other wire enum in this app follows.
enum WorkspaceFilePreview: Codable, Hashable, Sendable {
    case text(content: String, size: Int, mtimeMs: Double)
    case skipped(reason: SkippedReason, size: Int?)
    /// A `kind` this app has not heard of. Drawn as "can't show this file",
    /// which is true, rather than taking the screen down.
    case unreadable(kind: String)

    private enum CodingKeys: String, CodingKey {
        case kind, content, size, mtimeMs, reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "text":
            self = .text(
                content: try container.decode(String.self, forKey: .content),
                size: try container.decode(Int.self, forKey: .size),
                mtimeMs: try container.decode(Double.self, forKey: .mtimeMs)
            )
        case "skipped":
            // An unknown reason is still a skip: the file has no text either
            // way, and the screen's copy is the only thing that narrows.
            let raw = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
            self = .skipped(
                reason: SkippedReason(rawValue: raw) ?? .notAFile,
                size: try container.decodeIfPresent(Int.self, forKey: .size)
            )
        default:
            self = .unreadable(kind: kind)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let content, let size, let mtimeMs):
            try container.encode("text", forKey: .kind)
            try container.encode(content, forKey: .content)
            try container.encode(size, forKey: .size)
            try container.encode(mtimeMs, forKey: .mtimeMs)
        case .skipped(let reason, let size):
            try container.encode("skipped", forKey: .kind)
            try container.encode(reason, forKey: .reason)
            try container.encodeIfPresent(size, forKey: .size)
        case .unreadable(let kind):
            try container.encode(kind, forKey: .kind)
        }
    }
}

// MARK: - Inputs

/// `ReviewListChangedFilesInput`.
struct ListChangedFilesInput: Encodable, Sendable {
    var kind: String = "workspace"
    var id: String
    var comparison: ReviewComparison
}

/// `ReviewLoadDiffInput`. `contextLines` is honoured only for a single-file
/// request, which is the only kind the phone makes.
struct LoadDiffInput: Encodable, Sendable {
    var kind: String = "workspace"
    var id: String
    var filePath: String?
    var comparison: ReviewComparison
    var contextLines: Int?

    enum CodingKeys: String, CodingKey {
        case kind, id, filePath, comparison, contextLines
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(id, forKey: .id)
        try container.encodeAlways(filePath, forKey: .filePath)
        try container.encode(comparison, forKey: .comparison)
        try container.encodeAlways(contextLines, forKey: .contextLines)
    }
}

/// `WorkspaceListFilesInput`.
struct ListWorkspaceFilesInput: Encodable, Sendable {
    var kind: String = "workspace"
    var id: String
}

/// `WorkspaceReadFileInput`.
struct ReadWorkspaceFileInput: Encodable, Sendable {
    var kind: String = "workspace"
    var id: String
    var filePath: String
}
