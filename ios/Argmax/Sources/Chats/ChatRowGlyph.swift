import SwiftUI

// The leading column of a chat row: one glyph, chosen in one order.
//
//   1. Running wins over everything. A turn in flight is the most perishable
//      thing a list of a hundred chats has to say, and the nest is how every
//      surface in Argmax says it. It wears the chat's own icon colour when
//      there is one, so a row keeps its identity while it works.
//   2. Otherwise the chat's own icon, if it picked one on the Mac.
//   3. Otherwise the workspace's pull request, merged or open — the
//      sidebar's own precedence (`statusOverlayFor` in
//      `SidebarSessionRow.tsx`): a custom icon wins, a PR beats the bare
//      provider mark. The desktop also rides a live PR as a small corner dot
//      *on* a custom icon; this build doesn't draw that overlay yet, so a
//      chat with both a picked icon and an open PR shows only the icon.
//   4. Otherwise the provider's mark.
//
// Settings → Appearance's "Provider marks" switch reaches step 4 and nothing
// else: it hides the mark, not the column. An earlier pass dropped the whole
// 36pt column when the switch was off, which moved every title on the screen
// and left a running chat with nowhere to say it was running.
//
// The choice is a value rather than a `ViewBuilder` so the order can be
// tested without a renderer; `ChatRowGlyphView` is the only thing that turns
// it into pixels.
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
    /// Nothing to show: no icon, no PR, and the marks are switched off. The
    /// column stands empty rather than closing, so the titles stay on their
    /// column.
    case empty

    init(row: ChatRow, providerMarks: Bool) {
        if row.working {
            self = .nest(tint: row.workspace.iconColor)
        } else if let icon = row.workspace.icon, SessionIcon.symbol(for: icon) != nil {
            self = .icon(name: icon, tint: row.workspace.iconColor)
        } else if row.workspace.prState == "MERGED" {
            self = .prMerged(number: row.workspace.prNumber)
        } else if row.workspace.prState == "OPEN" {
            self = .prOpen(number: row.workspace.prNumber)
        } else if providerMarks {
            self = .providerMark(provider: row.session.provider)
        } else {
            self = .empty
        }
    }
}

struct ChatRowGlyphView: View {
    let glyph: ChatRowGlyph
    var size: CGFloat = 18

    var body: some View {
        Group {
            switch glyph {
            case .nest(let tint):
                WorkingNest(size: size, tint: SessionIcon.color(for: tint))
            case .icon(let name, let tint):
                Image(systemName: SessionIcon.symbol(for: name) ?? "circle")
                    .font(.system(size: size - 2, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    // An icon with no colour is still a deliberate pick, so
                    // it draws in the ink rather than falling all the way
                    // back to the provider's mark.
                    .foregroundStyle(SessionIcon.color(for: tint) ?? Theme.ink)
                    .accessibilityLabel(sessionIconLabel(name))
            case .prMerged(let number):
                GitPullRequestStatusMark(kind: .merged, size: size - 2)
                    .accessibilityLabel(number.map { "Pull request #\($0) merged" } ?? "Pull request merged")
            case .prOpen(let number):
                GitPullRequestStatusMark(kind: .open, size: size - 2)
                    .accessibilityLabel(number.map { "Pull request #\($0) open" } ?? "Pull request open")
            case .providerMark(let provider):
                ProviderMark(provider: provider, size: size - 2)
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
