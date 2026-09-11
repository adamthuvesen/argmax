import SwiftUI

// The 4pt grid, named.
//
// Two constants and a corner radius are not much of a system, but they are
// the two numbers every screen in this app has to agree on, and "20" typed
// in nine files is how a gutter drifts.

enum Spacing {
    static let hair: CGFloat = 2
    static let tight: CGFloat = 4
    static let snug: CGFloat = 8
    static let row: CGFloat = 12
    static let gutter: CGFloat = 20
    static let section: CGFloat = 28

    /// The leading column a row's glyph sits in, and what its separator and
    /// its second line line up against.
    static let glyphColumn: CGFloat = 36
    /// Our header, below the safe area.
    static let headerHeight: CGFloat = 52
    /// The round controls along the composer's floor — plus, mic, queue,
    /// send/stop. One size, so the row reads as one family rather than as a
    /// primary button with smaller things standing next to it.
    static let composerControl: CGFloat = 34
}

enum Radius {
    /// Chips, fields and buttons.
    static let control: CGFloat = 10
    /// A picker cell in the New chat grid. Between the two, because the
    /// cells are larger than a chip and read as one control family rather
    /// than as four cards — a card's 14 made them look like four of them.
    static let cell: CGFloat = 12
    /// Sheets and cards.
    static let card: CGFloat = 14
    /// The composer card alone. Rounder than every other card on purpose: it
    /// is the one surface the thumb rests against, and its corners read
    /// against the keyboard rather than against a list of other cards.
    static let composer: CGFloat = 22
}

extension View {
    /// The screen gutter. Everything that is not full-bleed takes this.
    func screenGutter() -> some View {
        padding(.horizontal, Spacing.gutter)
    }
}
