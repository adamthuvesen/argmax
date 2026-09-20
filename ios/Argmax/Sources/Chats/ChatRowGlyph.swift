import SwiftUI

// The leading glyph follows the desktop sidebar: running nest, custom icon,
// pull request, provider mark, then a quiet hollow circle. Chat icons off
// hides the column except while running. Provider marks off keeps the circle.
enum ChatRowGlyph: Equatable {
    /// A turn is in flight. The payload is the chat's `iconColor` token, or
    /// nil for the accent.
    case nest(tint: String?)
    /// The icon the desktop's picker put on the row, as a Lucide name that
    /// this build could map, plus its palette token.
    case icon(name: String, tint: String?)
    /// The workspace's most recent PR merged, in `--pr-merged` violet.
    case prMerged(number: Int?)
    /// The workspace's most recent PR still open, in `--pr-open` sage.
    case prOpen(number: Int?)
    case providerMark(provider: String)
    case idle
    /// Chat icons are switched off. The row leaves the slot out.
    case empty

    init(row: ChatRow, chatIcons: Bool, providerMarks: Bool) {
        if row.working {
            self = .nest(tint: row.workspace.iconColor)
        } else if !chatIcons {
            self = .empty
        } else if let icon = row.workspace.icon, SessionIcon.symbol(for: icon) != nil {
            self = .icon(name: icon, tint: row.workspace.iconColor)
        } else if row.workspace.prState == "MERGED" {
            self = .prMerged(number: row.workspace.prNumber)
        } else if row.workspace.prState == "OPEN" {
            self = .prOpen(number: row.workspace.prNumber)
        } else if providerMarks {
            self = .providerMark(provider: row.session.provider)
        } else {
            self = .idle
        }
    }
}

struct ChatRowGlyphView: View {
    let glyph: ChatRowGlyph
    var size: CGFloat = 12

    var body: some View {
        Group {
            switch glyph {
            case .nest(let tint):
                WorkingNest(size: size, tint: SessionIcon.color(for: tint))
            case .icon(let name, let tint):
                Image(systemName: SessionIcon.symbol(for: name) ?? "circle")
                    // SF Symbols extend beyond their point size. Keep them
                    // inside the same compact slot as the PR and status marks.
                    .typeSymbol(size: size * 0.8, weight: .medium)
                    .symbolRenderingMode(.hierarchical)
                    // An icon with no colour is still a deliberate pick, so
                    // it draws in the ink rather than falling all the way
                    // back to the provider's mark.
                    .foregroundStyle(SessionIcon.color(for: tint) ?? Theme.ink)
                    .accessibilityLabel(sessionIconLabel(name))
            case .prMerged(let number):
                GitPullRequestStatusMark(kind: .merged, size: size)
                    .accessibilityLabel(number.map { "Pull request #\($0) merged" } ?? "Pull request merged")
            case .prOpen(let number):
                GitPullRequestStatusMark(kind: .open, size: size)
                    .accessibilityLabel(number.map { "Pull request #\($0) open" } ?? "Pull request open")
            case .providerMark(let provider):
                ProviderMark(provider: provider, size: size)
            case .idle:
                Circle()
                    .strokeBorder(Theme.muted.opacity(0.5), lineWidth: 1)
                    .frame(width: size * 0.65, height: size * 0.65)
                    .accessibilityHidden(true)
            case .empty:
                Color.clear
            }
        }
        .frame(width: size, height: size)
    }
}

/// "GitBranch" spoken as "Git Branch", the same split the desktop picker's
/// accessible name uses (`sessionIconLabel` in `sessionIcons.ts`).
func sessionIconLabel(_ name: String) -> String {
    var spaced = ""
    for character in name {
        if character.isUppercase, !spaced.isEmpty, spaced.last?.isLowercase == true { spaced.append(" ") }
        spaced.append(character)
    }
    return spaced
}
