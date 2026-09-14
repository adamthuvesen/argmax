import SwiftUI

/// How a viewer draws its own chrome.
///
/// Pushed on its own, a viewer has to say which file it is and offer a way
/// back. Inside the review screen the header already says both, and a second
/// title under it is the same name twice in a row.
enum ViewerChrome {
    case pushed
    case embedded
}

/// Whether the embedded diff still has unchanged lines to reveal. The control
/// rides the review header, the only bar an embedded viewer has.
struct DiffCanExpandKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// Climb to the next context rung. It sits in the review header when the
/// viewer is embedded and in the viewer's own header when the diff was pushed
/// on its own, which is why it takes its target size rather than assuming one.
struct ReviewContextButton: View {
    var size: CGFloat = 44
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.selection()
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
    private var path: String {
        switch self {
        case .diff(_, let path, _), .file(_, let path): return path
        }
    }

    var fileName: String {
        String(path.split(separator: "/").last ?? Substring(path))
    }

    /// The header's second line under `fileName`: where the file lives, and
    /// which comparison this is.
    var pathAndKind: String {
        let directory = path.split(separator: "/").dropLast().joined(separator: "/")
        let kind: String
        switch self {
        case .diff(_, _, let scope): kind = scope.label
        case .file: kind = "File"
        }
        return directory.isEmpty ? kind : "\(directory) · \(kind)"
    }
}
