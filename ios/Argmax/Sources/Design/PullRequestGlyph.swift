import SwiftUI

// The two pull-request glyphs a chat row can wear, redrawn from Lucide's own
// vectors rather than approximated with an SF Symbol.
//
// `GitMerge` and `GitPullRequest` (`lucide-react`, ISC licensed) are what the
// desktop sidebar draws for these two states (`SidebarSessionRow.tsx`), and
// neither has a faithful SF Symbol match — `arrow.triangle.merge` reads as a
// road interchange, not as two branches. The path data below is Lucide's
// verbatim, on its own 24×24 grid:
//
//   GitMerge:        circle(18,18,3) circle(6,6,3) "M6 21V9a9 9 0 0 0 9 9"
//   GitPullRequest:  circle(18,18,3) circle(6,6,3) "M13 6h3a2 2 0 0 1 2 2v7"
//                    line(6,9 → 6,21)
//
// Both quarter-circle arcs are turned into a single cubic Bézier with the
// standard κ≈0.5523 constant, which is exact enough at glyph size that no
// renderer needs an `addArc` clockwise flag to get right.

private let bezierKappa: CGFloat = 0.5522847498

/// `--pr-merged`: a smooth quarter-turn from the top-left circle's stem down
/// into the bottom-right circle, arcing around (6, 18).
struct GitMergeGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 24
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale)
        }
        var path = Path()
        path.addEllipse(in: CGRect(x: rect.minX + 15 * scale, y: rect.minY + 15 * scale, width: 6 * scale, height: 6 * scale))
        path.addEllipse(in: CGRect(x: rect.minX + 3 * scale, y: rect.minY + 3 * scale, width: 6 * scale, height: 6 * scale))
        path.move(to: pt(6, 21))
        path.addLine(to: pt(6, 9))
        let r: CGFloat = 9 * scale
        path.addCurve(
            to: pt(15, 18),
            control1: pt(6, 9).applying(.init(translationX: bezierKappa * r, y: 0)),
            control2: pt(15, 18).applying(.init(translationX: 0, y: -bezierKappa * r))
        )
        return path
    }
}

/// `--pr-open`: the same two circles, a right-angled hook from the top-right
/// circle's stem, and the left stem drawn as its own separate stroke — this
/// mirrors Lucide's own `<path>` + `<line>` split, not a shortcut.
struct GitPullRequestGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = rect.width / 24
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale)
        }
        var path = Path()
        path.addEllipse(in: CGRect(x: rect.minX + 15 * scale, y: rect.minY + 15 * scale, width: 6 * scale, height: 6 * scale))
        path.addEllipse(in: CGRect(x: rect.minX + 3 * scale, y: rect.minY + 3 * scale, width: 6 * scale, height: 6 * scale))
        path.move(to: pt(13, 6))
        path.addLine(to: pt(16, 6))
        let r: CGFloat = 2 * scale
        path.addCurve(
            to: pt(18, 8),
            control1: pt(16, 6).applying(.init(translationX: bezierKappa * r, y: 0)),
            control2: pt(18, 8).applying(.init(translationX: 0, y: -bezierKappa * r))
        )
        path.addLine(to: pt(18, 15))
        path.move(to: pt(6, 9))
        path.addLine(to: pt(6, 21))
        return path
    }
}

/// A workspace's PR state as the row's leading glyph — the phone's form of
/// `StatusMarker`'s `data-pr` colours (`shell-sessions.css`).
struct GitPullRequestStatusMark: View {
    enum Kind {
        case merged
        case open
    }

    let kind: Kind
    var size: CGFloat = 18

    var body: some View {
        Group {
            switch kind {
            case .merged:
                GitMergeGlyph().stroke(Theme.violet, style: strokeStyle)
            case .open:
                GitPullRequestGlyph().stroke(Theme.sage, style: strokeStyle)
            }
        }
        .frame(width: size, height: size)
    }

    /// Lucide draws at `stroke-width: 2` on a 24-unit grid — 1/12 of the
    /// glyph's own size, not a fixed point value, so the line stays in
    /// proportion at every size this app draws it.
    private var strokeStyle: StrokeStyle {
        StrokeStyle(lineWidth: size / 12, lineCap: .round, lineJoin: .round)
    }
}

#if DEBUG
#Preview("Pull request glyphs") {
    HStack(spacing: 24) {
        GitPullRequestStatusMark(kind: .merged, size: 18)
        GitPullRequestStatusMark(kind: .open, size: 18)
        GitPullRequestStatusMark(kind: .merged, size: 40)
        GitPullRequestStatusMark(kind: .open, size: 40)
    }
    .padding(30)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.ground)
}
#endif
