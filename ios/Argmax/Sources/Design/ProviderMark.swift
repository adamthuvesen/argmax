import SwiftUI
import UIKit

// Which CLI is on the other end of a chat, as its own brand mark.
//
// The five marks are the companies' — Anthropic's Claude sunburst, OpenAI's
// blossom, Cursor's cube, opencode's frame, xAI's Grok glyph — downloaded
// from their own brand pages and kept as vector imagesets in
// `Assets.xcassets/Providers`, with the sources and dates recorded in the
// README beside them.
//
// The first pass drew five of the repo's own subagent emblems here instead
// (`src/renderer/lib/agentEmblems.ts`, ported as `Path`). They were the
// right family for a subagent, which has no brand, and the wrong one for a
// provider, which has: a trefoil is a shape you learn, and Anthropic's
// sunburst is one you already know.
//
// Each in the colour its owner ships it in. Anthropic's is the one real
// brand colour among them — the sunburst is always #D97757, on light and on
// dark. OpenAI, Cursor and xAI publish their marks in black and white, so those
// are near-black on the light ground and near-white on the dark one, at the
// values their own sites use; opencode publishes no palette and takes the ink.
// No mark ever borrows the accent.

/// A provider's mark at the size the brief asks for: 16pt.
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 16

    /// Light then dark, per the brand pages (see Providers/README.md).
    private static let tints: [String: Color] = [
        "claude": Color(Theme.dynamic(light: 0xD9_77_57, dark: 0xD9_77_57)),
        "codex": Color(Theme.dynamic(light: 0x00_00_00, dark: 0xFF_FF_FF)),
        "cursor": Color(Theme.dynamic(light: 0x14_12_0B, dark: 0xF7_F7_F4)),
        "grok": Color(Theme.dynamic(light: 0x00_00_00, dark: 0xFF_FF_FF)),
        "opencode": Theme.ink
    ]

    static func tint(_ provider: String) -> Color {
        tints[provider] ?? Theme.muted
    }

    /// What to call the CLI in running text, and its own id for one this
    /// build has never heard of.
    static func displayName(_ provider: String) -> String {
        names[provider] ?? provider.capitalized
    }

    private static let names = [
        "claude": "Claude",
        "codex": "Codex",
        "cursor": "Cursor",
        "opencode": "OpenCode",
        "grok": "Grok Build"
    ]

    /// The imageset for a provider, or nil for a CLI this build has never
    /// heard of. Namespaced by the catalogue folder, so "cursor" here can
    /// never collide with something else called that.
    ///
    /// `UIImage(named:)` rather than `Image(_:)`: SwiftUI's initialiser
    /// cannot say whether the asset exists, and the fallback below has to
    /// know.
    static func assetName(_ provider: String) -> String? {
        let name = "Providers/\(provider)"
        return UIImage(named: name) == nil ? nil : name
    }

    var body: some View {
        Group {
            if let asset = Self.assetName(provider) {
                Image(asset)
                    .renderingMode(.template)
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Self.tint(provider))
            } else {
                // A CLI added to the host before it was added here still
                // gets a mark, and one that reads as "unnamed" rather than
                // borrowing another provider's.
                Circle()
                    .strokeBorder(Theme.muted, lineWidth: size / 8)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.displayName(provider))
    }
}

#if DEBUG
#Preview("Provider marks") {
    HStack(spacing: 20) {
        ForEach(["claude", "codex", "cursor", "opencode", "grok", "future"], id: \.self) { provider in
            VStack(spacing: 8) {
                ProviderMark(provider: provider, size: 16)
                ProviderMark(provider: provider, size: 40)
            }
        }
    }
    .padding(30)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.ground)
}
#endif
