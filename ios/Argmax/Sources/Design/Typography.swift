import SwiftUI

// The type scale, as one modifier per role.
//
// Every one is built from a *text style*, so Dynamic Type moves the whole app
// and nothing is pinned to a point size. Semibold for screen titles; row titles and everything else
// regular — and SF Mono wherever the text is an identifier a person might
// have to type back: branch names, model ids, the pairing link.
//
// Reaching for `.font(.body)` directly is fine; reaching for
// `.font(.system(size: 15))` is what this exists to prevent.

extension View {
    /// Screen titles. We draw our own header, so this is the largest type in
    /// the app — there is no system large title anywhere.
    func typeScreenTitle() -> some View {
        font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
    }

    /// A pushed screen's title: inline-sized, the way the platform drops from a
    /// large root title to a compact one once you are a level in.
    func typePushedTitle() -> some View {
        font(.headline).foregroundStyle(Theme.ink)
    }

    /// A row's own name, and the one line that must never truncate away.
    func typeRowTitle() -> some View {
        modifier(RowTitle())
    }

    /// Body copy inside a screen: help text, a sheet's prompt editor, a
    /// settings row's value.
    func typeContent() -> some View {
        font(.subheadline).foregroundStyle(Theme.ink)
    }

    /// The second line of a row, a section heading, a field's help.
    func typeMeta() -> some View {
        font(.footnote).foregroundStyle(Theme.muted)
    }

    /// A section heading over a group of rows: the meta size, carrying the
    /// weight that makes it a heading rather than a caption.
    func typeSectionHeading() -> some View {
        font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
    }

    /// Chips, attention capsules, the trailing time column.
    func typeChip() -> some View {
        font(.caption2.weight(.semibold))
    }

    /// Under a title in the header: project · state.
    func typeSubtitle() -> some View {
        font(.caption2).foregroundStyle(Theme.muted)
    }
}

extension Font {
    /// Identifiers a person could have to type back: branch names, ids,
    /// model ids, the pairing link.
    static func argmaxMono(_ style: Font.TextStyle) -> Font {
        .system(style, design: .monospaced)
    }
}

/// 18pt to match the transcript's prose at its phone step (13px + 5), so a
/// title in the list and the first line of the chat are one size — scaled
/// with Dynamic Type relative to `.body`, as a text style would be.
private struct RowTitle: ViewModifier {
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 18

    func body(content: Content) -> some View {
        content.font(.system(size: size)).foregroundStyle(Theme.ink)
    }
}
