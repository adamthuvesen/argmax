import SwiftUI

/// Which appearance the app draws in.
///
/// "Follow system" is the default and what most people leave it on; the two
/// overrides exist because a phone that follows the Mac's schedule at 6pm is
/// not the same phone you read in bed.
enum ThemeChoice: String, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// Nil means "whatever the device is doing", which is what
    /// `.preferredColorScheme` wants.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

/// Theme and accent, persisted and handed to everything that draws.
///
/// The keys are the web client's own (`argmax.theme.mode`,
/// `argmax.accent.tint`) so the two halves of the phone speak one vocabulary
/// — but the values are not synced from the Mac: appearance is per device,
/// which is the rule the desktop's own phone menu already follows.
///
/// The embedded transcript is told about both changes over the native
/// contract, so the page inside the shell never disagrees with the shell.
@MainActor
final class Appearance: ObservableObject {
    static let themeKey = "argmax.theme.mode"
    static let accentKey = "argmax.accent.tint"
    /// No web counterpart: the phone list is the only place in Argmax with a
    /// glyph column to turn off, so the key is namespaced to this app rather
    /// than borrowed from the web client's vocabulary.
    static let providerMarksKey = "argmax.phone.providerMarks"
    /// The web client's own key (`argmax.mascot.visible`), the way theme and
    /// accent borrow theirs: the fox is one setting across both halves of
    /// Argmax even though each device holds its own answer.
    static let mascotKey = "argmax.mascot.visible"
    /// The web client's own key (`argmax.chat.bubbleTint`), for the same
    /// reason theme and accent borrow theirs: one vocabulary across the two
    /// halves of the phone. The value is the page's too — "accent" or
    /// "neutral", not a boolean — so the shell can hand it over unchanged.
    static let bubbleTintKey = "argmax.chat.bubbleTint"

    @Published var theme: ThemeChoice {
        didSet { store.set(theme.rawValue, forKey: Self.themeKey) }
    }

    @Published var tint: AccentTint {
        didSet { store.set(tint.rawValue, forKey: Self.accentKey) }
    }

    /// Whether a chat row falls back to its provider's mark when it has no
    /// icon of its own. On by default — the mark is how a list of a hundred
    /// chats says which CLI is on the other end without spending a word on
    /// it. Off, the column stays: a running chat still shows its nest.
    @Published var providerMarks: Bool {
        didSet { store.set(providerMarks, forKey: Self.providerMarksKey) }
    }

    /// Whether the fox is drawn — the mark in the Chats header, the new-chat
    /// hero, and the fox an empty screen shows. On by default: it is the
    /// app's mark, so it is opted out of rather than into. The pairing screen
    /// keeps its fox either way; that screen runs before Settings can be
    /// reached.
    @Published var mascot: Bool {
        didSet { store.set(mascot, forKey: Self.mascotKey) }
    }

    /// Whether the transcript's own messages fill with the accent or stay a
    /// quiet gray. The bubbles are drawn by the page inside the shell, so
    /// this is a setting the shell holds and the page is told about — the
    /// same path theme and accent take.
    @Published var accentBubbles: Bool {
        didSet { store.set(bubbleTint, forKey: Self.bubbleTintKey) }
    }

    /// The value the page keys its stylesheet off (`data-user-bubble`).
    var bubbleTint: String { accentBubbles ? "accent" : "neutral" }

    private let store: UserDefaults

    init(store: UserDefaults = .standard) {
        self.store = store
        // An unreadable value is not an error state worth surfacing: a build
        // that renamed a tint should land on the default, not on a blank
        // accent.
        theme = ThemeChoice(rawValue: store.string(forKey: Self.themeKey) ?? "") ?? .system
        tint = AccentTint(rawValue: store.string(forKey: Self.accentKey) ?? "") ?? .fallback
        // `bool(forKey:)` is false for a key that was never written, which
        // is the wrong default here — so the absence is read first.
        providerMarks = store.object(forKey: Self.providerMarksKey) as? Bool ?? true
        mascot = store.object(forKey: Self.mascotKey) as? Bool ?? true
        // Accent is the page's own default, so anything unreadable — and the
        // absence of the key — lands there rather than on gray.
        accentBubbles = store.string(forKey: Self.bubbleTintKey) != "neutral"
    }
}

extension View {
    /// Apply the whole appearance in one place: the resolved scheme (which
    /// stamps the trait every dynamic colour resolves against), the accent
    /// the design system reads, and the tint the handful of remaining stock
    /// controls read.
    func appearance(_ appearance: Appearance) -> some View {
        environment(\.accentTint, appearance.tint)
            .environment(\.providerMarks, appearance.providerMarks)
            .environment(\.mascotVisible, appearance.mascot)
            .tint(appearance.tint.color)
            .preferredColorScheme(appearance.theme.colorScheme)
    }
}

/// Handed down the tree the way the accent is, so a row reads it without an
/// `@EnvironmentObject` every `#Preview` would then have to supply.
private struct ProviderMarksKey: EnvironmentKey {
    static let defaultValue = true
}

/// Same reason as the provider marks: the fox is drawn from the header, the
/// new-chat sheet and the empty state, and none of them should need an
/// `@EnvironmentObject` a `#Preview` would have to supply.
private struct MascotVisibleKey: EnvironmentKey {
    static let defaultValue = true
}

extension EnvironmentValues {
    var providerMarks: Bool {
        get { self[ProviderMarksKey.self] }
        set { self[ProviderMarksKey.self] = newValue }
    }

    var mascotVisible: Bool {
        get { self[MascotVisibleKey.self] }
        set { self[MascotVisibleKey.self] = newValue }
    }
}
