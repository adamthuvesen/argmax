import SwiftUI
import UIKit

// One text view per file, and never one view per line.
//
// A diff is the largest thing this app draws: a few thousand lines, each with
// a line number, a wash, and code that can be wider than the screen. Drawn as
// SwiftUI rows that is a few thousand layout nodes, each resolving a font and
// measuring itself, and the scroll gives up long before the file does. Drawn
// as one `UITextView` on TextKit 2 it is one layout engine doing viewport-only
// line layout — the work is proportional to what is on screen, not to the
// file — plus selection and copy for free.
//
// The gutter is *inside* the string, as a fixed-width monospace prefix, so it
// aligns without a second column, a second scroll view, or a synchronised
// offset. What cannot go in the string is the full-bleed wash behind a changed
// line: `.backgroundColor` paints behind the glyphs, so a short line would get
// a short stripe. That is what `WashTextView` below paints instead.

extension NSAttributedString.Key {
    /// The wash behind a whole line, drawn to the view's width.
    static let codeWash = NSAttributedString.Key("argmax.codeWash")
    /// The extra wash behind the gutter column only, which stacks on the line
    /// wash the way `--diff-add-gutter-bg` stacks on `--diff-add-bg`.
    static let codeGutterWash = NSAttributedString.Key("argmax.codeGutterWash")
}

/// Metrics shared by every code surface: one monospace font, scaled for
/// Dynamic Type, and the gutter width derived from it.
enum CodeMetrics {
    /// `.footnote`-sized mono. Smaller than body on purpose — code is read in
    /// lines, not in sentences, and a step up costs a fifth of the columns —
    /// but scaled, so accessibility sizes still grow it.
    static func font(for category: UIContentSizeCategory, scale: TypeScale) -> UIFont {
        scale.uiFont(
            size: 12,
            relativeTo: .footnote,
            mono: true,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: category)
        )
    }

    /// One character's advance. Every character is this wide in a monospace
    /// font, which is what lets the gutter be padding rather than a column.
    static func advance(_ font: UIFont) -> CGFloat {
        ("0" as NSString).size(withAttributes: [.font: font]).width
    }

    /// The gutter's pixel width for a given digit count: the digits, one
    /// space of padding on each side, and the leading inset.
    static func gutterWidth(font: UIFont, digits: Int) -> CGFloat {
        advance(font) * CGFloat(digits + 2) + leadingInset
    }

    static let leadingInset: CGFloat = 4
    /// Code stops short of the screen's edge. Without this a long line runs
    /// into the bezel and every wrap looks like a rendering fault.
    static let trailingInset: CGFloat = 14
    static let verticalInset: CGFloat = 10
}

/// A text view that paints a per-line background across its full width.
///
/// Painted here rather than by an `NSTextLayoutFragment` subclass, which is
/// the other obvious place for it: a fragment's drawing is clipped to
/// `renderingSurfaceBounds`, which is the glyphs' own extent, so a fill past
/// the last character of a short line is simply cut off — a diff where the
/// wash stops at the end of the code, which is the one thing a wash is for.
/// The view's own background pass has no such clip, and TextKit draws the
/// glyphs into layers above it.
final class WashTextView: UITextView {
    var gutterWidth: CGFloat = 0

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        guard let layoutManager = textLayoutManager,
              let context = UIGraphicsGetCurrentContext()
        else { return }
        let offset = textContainerInset.top
        // Only the fragments this tile actually covers: enumeration starts at
        // the one under the top of `rect`, so a three-thousand-line file costs
        // what is on screen and not what is behind it.
        let top = max(rect.minY - offset, 0)
        guard let first = layoutManager.textLayoutFragment(for: CGPoint(x: 0, y: top)) else {
            return
        }
        layoutManager.enumerateTextLayoutFragments(
            from: first.rangeInElement.location,
            options: [.ensuresLayout]
        ) { fragment in
            let frame = fragment.layoutFragmentFrame
            if frame.minY + offset > rect.maxY { return false }
            guard let paragraph = fragment.textElement as? NSTextParagraph,
                  paragraph.attributedString.length > 0
            else { return true }
            let attributes = paragraph.attributedString.attributes(at: 0, effectiveRange: nil)
            let band = CGRect(
                x: 0,
                y: frame.minY + offset,
                width: bounds.width,
                height: frame.height
            )
            if let wash = attributes[.codeWash] as? UIColor {
                context.setFillColor(wash.resolvedColor(with: traitCollection).cgColor)
                context.fill(band)
            }
            if let gutter = attributes[.codeGutterWash] as? UIColor {
                context.setFillColor(gutter.resolvedColor(with: traitCollection).cgColor)
                context.fill(CGRect(x: 0, y: band.minY, width: gutterWidth, height: band.height))
            }
            return true
        }
    }
}

/// A read-only code surface: our ground, our insets, no editing affordances,
/// and its own scrolling so TextKit lays out only what is visible. A
/// non-scrolling text view inside a SwiftUI `ScrollView` would have to lay the
/// whole file out just to report its height, which is the cost this exists to
/// avoid.
struct CodeTextView: UIViewRepresentable {
    let document: CodeDocument

    @Environment(\.typeScale) private var typeScale

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WashTextView {
        let textView = WashTextView(usingTextLayoutManager: true)
        textView.isEditable = false
        // Selection stays on: copying a line out of a diff is the one edit
        // this screen supports, and it costs nothing to allow.
        textView.isSelectable = true
        textView.backgroundColor = .clear
        // Opaque would paint black behind the washes; the screen's ground is
        // under this view and has to show through the lines that have none.
        textView.isOpaque = false
        // `draw(_:)` is only called on a view that says it draws.
        textView.contentMode = .redraw
        textView.textContainerInset = UIEdgeInsets(
            top: CodeMetrics.verticalInset,
            left: 0,
            bottom: CodeMetrics.verticalInset * 4,
            right: CodeMetrics.trailingInset
        )
        textView.textContainer.lineFragmentPadding = 0
        textView.alwaysBounceVertical = true
        textView.showsHorizontalScrollIndicator = false
        // Code wraps rather than scrolling sideways. A second scroll axis on a
        // phone steals the vertical pan as often as it serves a long line, and
        // `headIndent` keeps the continuation under the code column so a
        // wrapped line still reads as one line.
        textView.textContainer.lineBreakMode = .byCharWrapping
        return textView
    }

    func updateUIView(_ textView: WashTextView, context: Context) {
        let font = CodeMetrics.font(for: context.environment.legacyContentSizeCategory, scale: typeScale)
        // Identity, not equality: rebuilding a 3000-line attributed string on
        // every SwiftUI update is the one cost that would undo all of this.
        // The key is cheap to compute; the string is not, so the key decides.
        // Both inputs to the font are in it: a new content size moves the
        // point size, a new typeface moves the face's name.
        let key = "\(document.key)|\(font.fontName)|\(font.pointSize)"
        guard context.coordinator.renderKey != key else { return }
        context.coordinator.renderKey = key
        context.coordinator.task?.cancel()
        let coordinator = context.coordinator
        let document = document
        // View installation stays on main. Building an unattached immutable string does not.
        coordinator.task = Task { @MainActor [weak textView, weak coordinator] in
            let built = await Task.detached(priority: .userInitiated) {
                NativePerformance.measure("Review document preparation") { document.build(font: font) }
            }.value
            guard !Task.isCancelled, let textView, coordinator?.renderKey == key else { return }
            textView.gutterWidth = built.gutterWidth
            textView.attributedText = built.string
            textView.setNeedsDisplay()
            textView.setContentOffset(.zero, animated: false)
        }
    }

    static func dismantleUIView(_ uiView: WashTextView, coordinator: Coordinator) {
        coordinator.task?.cancel()
    }

    final class Coordinator {
        var renderKey: String?
        var task: Task<Void, Never>?
        deinit { task?.cancel() }
    }

}

private extension EnvironmentValues {
    /// `dynamicTypeSize` back as the `UIContentSizeCategory` `UIFontMetrics`
    /// takes. SwiftUI's own type is not convertible, and the text view is UIKit.
    var legacyContentSizeCategory: UIContentSizeCategory {
        switch dynamicTypeSize {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}
