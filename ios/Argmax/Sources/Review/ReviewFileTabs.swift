import SwiftUI

/// The open review files and the one currently filling the editor area.
///
/// `active` is nil while the file list is showing. The open tabs stay put so
/// returning to the list does not discard the files the user was comparing.
struct ReviewFileTabsState: Equatable {
    private(set) var open: [ReviewDetail] = []
    private(set) var active: ReviewDetail?

    init(initial: ReviewDetail? = nil) {
        if let initial {
            open = [initial]
            active = initial
        }
    }

    mutating func open(_ detail: ReviewDetail) {
        if !open.contains(detail) { open.append(detail) }
        active = detail
    }

    mutating func select(_ detail: ReviewDetail) {
        guard open.contains(detail) else { return }
        active = detail
    }

    mutating func showList() {
        active = nil
    }

    mutating func close(_ detail: ReviewDetail) {
        guard let index = open.firstIndex(of: detail) else { return }
        open.remove(at: index)
        guard active == detail else { return }
        active = open.isEmpty ? nil : open[min(index, open.count - 1)]
    }
}

/// How a viewer draws its own chrome.
///
/// Pushed on its own, a viewer has to say which file it is and offer a way
/// back. Inside the review screen's tab strip the tab already says both, and
/// a second title under it is the same name twice in a row.
enum ViewerChrome {
    case pushed
    case embedded
}

/// Whether the embedded diff still has unchanged lines to reveal. The control
/// rides the tab strip, which is the only bar an embedded viewer has.
struct DiffCanExpandKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// A phone-sized version of the desktop editor tabs. Each tab says whether it
/// is a checkout file or a diff, since the same path can be open in both forms
/// and in more than one review comparison.
///
/// The strip is also the embedded viewer's toolbar: the trailing slot carries
/// whatever the open file can do, so the viewer under it is code and nothing
/// else.
struct ReviewFileTabs<Trailing: View>: View {
    let details: [ReviewDetail]
    let active: ReviewDetail?
    let onSelect: (ReviewDetail) -> Void
    let onClose: (ReviewDetail) -> Void
    let onShowList: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 0) {
            Button(action: onShowList) {
                Image(systemName: "list.bullet")
                    .typeSymbol(.body, weight: .medium)
                    .foregroundStyle(active == nil ? Theme.ink : Theme.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(PressDim())
            .accessibilityLabel("File list")
            .accessibilityAddTraits(active == nil ? .isSelected : [])
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.snug) {
                        ForEach(details, id: \.self) { detail in
                            tab(detail)
                                .id(detail)
                        }
                    }
                    .padding(.horizontal, Spacing.gutter)
                    // The tabs are 44pt tall on their own, which with a hair
                    // of air is the same 52pt bar every other screen wears.
                    .padding(.vertical, Spacing.tight)
                }
                .onChange(of: active) { _, detail in
                    guard let detail else { return }
                    if reduceMotion {
                        proxy.scrollTo(detail, anchor: .center)
                    } else {
                        withAnimation(.easeOut(duration: 0.16)) {
                            proxy.scrollTo(detail, anchor: .center)
                        }
                    }
                }
            }
            trailing()
        }
        .background(Theme.ground)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Open files")
    }

    private func tab(_ detail: ReviewDetail) -> some View {
        let selected = detail == active
        return HStack(spacing: 0) {
            Button {
                guard !selected else { return }
                Haptics.light()
                onSelect(detail)
            } label: {
                HStack(spacing: Spacing.snug) {
                    Image(systemName: detail.tabSymbol)
                        .typeSymbol(.caption, weight: .medium)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(detail.fileName)
                            .typeStyle(.footnote, weight: selected ? .semibold : .regular)
                        Text(detail.tabKind)
                            .typeStyle(.caption2)
                            .foregroundStyle(Theme.muted)
                    }
                    .lineLimit(1)
                }
                .foregroundStyle(Theme.ink)
                .padding(.leading, Spacing.row)
                .frame(minHeight: 44)
                .contentShape(.rect)
            }
            .buttonStyle(PressDim())
            .accessibilityLabel(detail.accessibilityDescription)
            .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)

            Button {
                Haptics.light()
                onClose(detail)
            } label: {
                Image(systemName: "xmark")
                    .typeSymbol(.caption2, weight: .semibold)
                    .foregroundStyle(Theme.muted)
                    .frame(width: 44, height: 44)
                    .contentShape(.rect)
            }
            .buttonStyle(PressDim())
            .accessibilityLabel("Close \(detail.accessibilityDescription)")
        }
        .fixedSize(horizontal: true, vertical: false)
        .background(selected ? Theme.raised : Theme.ground,
                    in: .rect(cornerRadius: Radius.control, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
                .strokeBorder(Theme.line, lineWidth: 1)
        }
    }
}

/// Climb to the next context rung. It sits in the tab strip when the viewer
/// is embedded and in the header when the diff was pushed on its own, which
/// is why it takes its target size rather than assuming one.
struct ReviewContextButton: View {
    var size: CGFloat = 44
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.light()
            action()
        } label: {
            Image(systemName: "arrow.up.and.down.text.horizontal")
                .typeSymbol(.body, weight: .medium)
                .foregroundStyle(Theme.muted)
                .frame(width: size, height: size)
                .contentShape(.rect)
        }
        .buttonStyle(PressDim())
        .accessibilityLabel("Show more unchanged lines")
    }
}

extension ReviewDetail {
    fileprivate var path: String {
        switch self {
        case .diff(_, let path, _), .file(_, let path): return path
        }
    }

    fileprivate var fileName: String {
        String(path.split(separator: "/").last ?? Substring(path))
    }

    fileprivate var tabKind: String {
        let directory = path.split(separator: "/").dropLast().joined(separator: "/")
        let kind: String
        switch self {
        case .diff(_, _, let scope): kind = scope.label
        case .file: kind = "File"
        }
        return directory.isEmpty ? kind : "\(directory) · \(kind)"
    }

    fileprivate var tabSymbol: String {
        switch self {
        case .diff: return "arrow.left.arrow.right"
        case .file: return "doc"
        }
    }

    var accessibilityDescription: String {
        switch self {
        case .diff(_, let path, let scope): return "Diff \(path), \(scope.label)"
        case .file(_, let path): return "File \(path)"
        }
    }
}
