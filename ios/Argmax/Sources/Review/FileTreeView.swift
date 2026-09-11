import SwiftUI

/// The checkout's files, as a tree you open a level at a time.
///
/// A `LazyVStack` over a flat row array rather than `List` + `OutlineGroup`:
/// the stock pair brings its own disclosure chevrons in the tint, its own
/// inset separators, and a row height this app does not use, and the flat
/// array is what makes the expansion set a value the view can be tested
/// against.
struct FileTreeView: View {
    let entries: [WorkspaceFileEntry]
    let workspaceID: String
    /// A path to open the tree to, from a file reference tapped in the
    /// transcript. Its folders are expanded and its row is scrolled to.
    var reveal: String?
    var onRefresh: (() async -> Void)?

    @State private var expanded: Set<String> = []
    /// Consumed once: re-running the reveal on every redraw would fight the
    /// reader's own collapsing.
    @State private var revealed = false
    /// Built when the entries change, not on every redraw. A checkout with
    /// `node_modules` in it is tens of thousands of paths, and rebuilding the
    /// tree to answer "which rows are visible" would do that work on each
    /// tap. Flattening it, which walks only what is open, does not.
    @State private var root = FileTreeNode(name: "", path: "", isDirectory: true)

    var body: some View {
        let rows = FileTree.flatten(root, expanded: expanded)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(rows) { row in
                        rowView(row)
                            .id(row.path)
                    }
                }
                .padding(.top, Spacing.snug)
                .padding(.bottom, Spacing.section)
            }
            .refreshable { await onRefresh?() }
            .onChange(of: entries) { root = FileTree.build(entries) }
            .task { root = FileTree.build(entries) }
            .task(id: reveal) {
                guard let reveal, !revealed else { return }
                revealed = true
                expanded.formUnion(FileTree.ancestors(of: reveal))
                // One runloop turn so the rows the expansion created exist
                // before the scroll asks for one of them.
                await Task.yield()
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(reveal, anchor: .center)
                }
            }
        }
        .overlay(alignment: .bottomTrailing) { collapseAll(rows) }
    }

    @ViewBuilder
    private func rowView(_ row: FileTreeRow) -> some View {
        if row.isDirectory {
            Button {
                Haptics.light()
                withAnimation(.easeOut(duration: 0.16)) {
                    if expanded.contains(row.path) {
                        expanded.remove(row.path)
                    } else {
                        expanded.insert(row.path)
                    }
                }
            } label: {
                FileTreeRowLabel(row: row, isOpen: expanded.contains(row.path))
            }
            .buttonStyle(PressDim())
            .accessibilityAddTraits(expanded.contains(row.path) ? .isSelected : [])
        } else {
            NavigationLink(value: ReviewDetail.file(workspaceID: workspaceID, path: row.path)) {
                FileTreeRowLabel(row: row, isOpen: false)
            }
            .buttonStyle(PressDim())
        }
    }

    /// Only once there is something to collapse. A control that is disabled
    /// more often than not is one the eye learns to skip.
    @ViewBuilder
    private func collapseAll(_ rows: [FileTreeRow]) -> some View {
        if !expanded.isEmpty {
            Button {
                Haptics.light()
                withAnimation(.easeOut(duration: 0.16)) { expanded.removeAll() }
            } label: {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                    .frame(width: 40, height: 40)
                    .background(Theme.raised, in: .circle)
                    .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
            }
            .buttonStyle(PressDim())
            .padding(.trailing, Spacing.gutter)
            .padding(.bottom, Spacing.gutter)
            .accessibilityLabel("Collapse all folders")
            .transition(.opacity)
        }
    }
}

/// One row. The indent is drawn, not padded: a hairline per enclosing folder,
/// so a deep path reads as a depth rather than as a paragraph indent.
struct FileTreeRowLabel: View {
    let row: FileTreeRow
    let isOpen: Bool

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<row.depth, id: \.self) { _ in
                Rectangle()
                    .fill(Theme.line)
                    .frame(width: 1)
                    .frame(maxHeight: .infinity)
                    .padding(.leading, indentStep - 1)
            }
            HStack(spacing: Spacing.snug) {
                Image(systemName: glyph)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(row.isDirectory ? Theme.muted : Theme.muted.opacity(0.7))
                    .frame(width: 16)
                    .rotationEffect(.degrees(row.isDirectory && isOpen ? 90 : 0))
                Text(row.name)
                    .typeContent()
                    .foregroundStyle(row.isDirectory ? Theme.ink : Theme.ink.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.leading, Spacing.snug)
        }
        .padding(.leading, Spacing.gutter)
        .padding(.trailing, Spacing.gutter)
        .frame(minHeight: 38)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.isDirectory ? "Folder \(row.name)" : row.name)
    }

    /// A closed folder is a chevron, which says "there is more"; an open one
    /// is the same chevron turned, which says where the rows below came from.
    /// A file is a plain document — the file kind is in its extension, and a
    /// set of per-language icons is a desktop affordance that needs a legend.
    private var glyph: String { row.isDirectory ? "chevron.right" : "doc" }

    private var indentStep: CGFloat { 14 }
}
