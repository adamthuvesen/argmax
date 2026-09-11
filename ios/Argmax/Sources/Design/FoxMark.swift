import SwiftUI

/// The fox, from `assets/fox-mascot.txt` by way of `scripts/build-icons.mjs`.
///
/// The same sprite the app icon and the desktop mascot are drawn from, so an
/// edit to the grid moves all three. It is a 56×40 pixel grid rasterised at
/// 3, 6 and 9 pixels per cell, which is why the sizes below are multiples of
/// 56pt and why the image is drawn without interpolation: this is pixel art,
/// and a bilinear filter turns a crisp sprite into a smudge.
///
/// It appears in three places and no others: the app icon, the pairing
/// screen, and the empty chat list. As decoration it would stop meaning
/// anything.
struct FoxMark: View {
    /// The mark's width. Height follows the sprite's 56:40.
    var size: CGFloat = 168

    var body: some View {
        Image("FoxMark")
            .resizable()
            .interpolation(.none)
            .antialiased(false)
            .aspectRatio(56.0 / 40.0, contentMode: .fit)
            .frame(width: size)
            .accessibilityHidden(true)
    }
}
