import Foundation

// The workspace tree, ported from `src/renderer/lib/fileTree.ts` and the
// flattening in `WorkspaceTree.tsx`.
//
// `workspace:list-files` answers a flat list of repo-relative paths and no
// directories of their own, so the folders are inferred here — the same on
// both clients, or the phone and the Mac disagree about what a checkout
// contains.

/// One node of the inferred tree. A directory exists because something under
/// it does; there is no empty folder on the wire.
struct FileTreeNode: Sendable {
    let name: String
    let path: String
    let isDirectory: Bool
    let children: [FileTreeNode]

    init(name: String, path: String, isDirectory: Bool, children: [FileTreeNode] = []) {
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.children = children
    }

}

/// A node at the depth it is drawn. The tree is rendered as a flat list of
/// these — one array, recomputed when the expansion set changes — because a
/// recursive view hierarchy costs a layout pass per level and buys nothing a
/// depth integer does not.
struct FileTreeRow: Identifiable, Hashable {
    let path: String
    let name: String
    let isDirectory: Bool
    let depth: Int

    var id: String { path }
}

enum FileTree {
    private final class BuildingNode {
        let name: String
        let path: String
        let isDirectory: Bool
        var children: [BuildingNode] = []
        init(name: String, path: String, isDirectory: Bool) {
            self.name = name; self.path = path; self.isDirectory = isDirectory
        }
        func freeze() -> FileTreeNode {
            let sorted = children.sorted {
                if $0.isDirectory != $1.isDirectory { return $0.isDirectory }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
            return FileTreeNode(name: name, path: path, isDirectory: isDirectory,
                children: sorted.map { $0.freeze() })
        }
    }
    /// Build the directory tree from the flat entries.
    ///
    /// A dictionary per cursor keeps the inner lookup O(1); scanning
    /// `children` instead is O(n²) on a wide directory, which `node_modules`
    /// makes a real number rather than a theoretical one.
    static func build(_ entries: [WorkspaceFileEntry]) -> FileTreeNode {
        let root = BuildingNode(name: "", path: "", isDirectory: true)
        var indexes: [ObjectIdentifier: [String: BuildingNode]] = [:]
        indexes[ObjectIdentifier(root)] = [:]
        for entry in entries {
            let segments = entry.path.split(separator: "/").filter { !$0.isEmpty }
            var cursor = root
            for (offset, segment) in segments.enumerated() {
                let isLast = offset == segments.count - 1
                let name = String(segment)
                let childPath = cursor.path.isEmpty ? name : "\(cursor.path)/\(name)"
                let cursorKey = ObjectIdentifier(cursor)
                if let existing = indexes[cursorKey]?[name] {
                    cursor = existing
                    continue
                }
                let next = BuildingNode(name: name, path: childPath, isDirectory: !isLast)
                cursor.children.append(next)
                indexes[cursorKey, default: [:]][name] = next
                indexes[ObjectIdentifier(next)] = [:]
                cursor = next
            }
        }
        return root.freeze()
    }

    /// The rows a given expansion set makes visible, in draw order.
    static func flatten(_ root: FileTreeNode, expanded: Set<String>) -> [FileTreeRow] {
        var rows: [FileTreeRow] = []
        func walk(_ node: FileTreeNode, _ depth: Int) {
            for child in node.children {
                rows.append(FileTreeRow(
                    path: child.path,
                    name: child.name,
                    isDirectory: child.isDirectory,
                    depth: depth
                ))
                if child.isDirectory, expanded.contains(child.path) {
                    walk(child, depth + 1)
                }
            }
        }
        walk(root, 0)
        return rows
    }

    /// Every folder enclosing `path`, outermost first. What revealing a file
    /// from outside the tree — a diff row, a file reference tapped in the
    /// transcript — has to open before the row exists.
    static func ancestors(of path: String) -> [String] {
        let segments = path.split(separator: "/")
        guard segments.count > 1 else { return [] }
        return (1..<segments.count).map { segments.prefix($0).joined(separator: "/") }
    }
}
