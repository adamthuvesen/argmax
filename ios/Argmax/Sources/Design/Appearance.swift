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

/// Whether transcript activity icons carry their semantic colours or recede
/// into the same muted ink as the rest of the activity ledger.
enum ActivityIconColorMode: String, CaseIterable, Identifiable, Sendable {
    case color
    case monochrome

    var id: String { rawValue }

    var label: String {
        switch self {
        case .color: return "Color"
        case .monochrome: return "Monochrome"
        }
    }
}

/// Theme, accent, and activity icon treatment, persisted and handed to
/// everything that draws.
///
/// Theme and accent use the web client's keys so both clients speak one
/// vocabulary. Values are not synced from the Mac: appearance is per device,
/// and the phone keeps its activity icon choice under a phone-specific key.
///
/// SwiftUI propagates appearance changes to the transcript and rich viewers
/// through the same environment as the rest of the app.
@MainActor
final class Appearance: ObservableObject {
    static let themeKey = "argmax.theme.mode"
    static let accentKey = "argmax.accent.tint"
    /// No web counterpart: the phone list is the only place in Argmax with a
    /// glyph column to turn off, so the key is namespaced to this app rather
    /// than borrowed from the web client's vocabulary.
    static let chatIconsKey = "argmax.phone.chatIcons"
    /// Same reason, and the narrower of the two: it reaches only the bare
    /// provider mark, under the switch that reaches the whole column.
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
    static let chatDetailKey = "argmax.phone.chatDetail"
    /// The web client's own key (`argmax.font.family`), so the typeface is
    /// one setting across both halves of Argmax. The phone reads only the
    /// ids it ships a face for and lands anything else — a desktop-only
    /// choice like `fira-code` — on its own default.
    static let typefaceKey = "argmax.font.family"
    /// The phone's own five-step type scale. It stays device-local because
    /// the desktop has a different range and separate app/chat scales.
    static let fontScaleKey = "argmax.phone.font.scale"
    /// Transcript activity is native-only, so its icon treatment is a local
    /// phone preference rather than a web appearance key.
    static let activityIconColorModeKey = "argmax.phone.activityIconColorMode"

    @Published var theme: ThemeChoice {
        didSet { store.set(theme.rawValue, forKey: Self.themeKey) }
    }

    @Published var tint: AccentTint {
        didSet { store.set(tint.rawValue, forKey: Self.accentKey) }
    }

    /// Whether a chat row draws anything in its leading column — the icon
    /// picked on the Mac, the workspace's pull request, the provider's mark.
    /// On by default: the column is how a list of a hundred chats says which
    /// CLI is on the other end without spending a word on it. Off, only a
    /// running chat's nest is left, and the column stays reserved so a turn
    /// starting doesn't shove every title sideways.
    @Published var chatIcons: Bool {
        didSet { store.set(chatIcons, forKey: Self.chatIconsKey) }
    }

    /// Whether a chat row falls back to its provider's mark when it has no
    /// icon and no pull request of its own. On by default — the mark is how
    /// a list of a hundred chats says which CLI is on the other end without
    /// spending a word on it. It only matters while `chatIcons` is on, which
    /// is why Settings greys it out underneath.
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

    /// How much supporting activity the transcript shows on this phone.
    @Published var chatDetail: MobileChatDetail {
        didSet { store.set(chatDetail.rawValue, forKey: Self.chatDetailKey) }
    }

    /// The face the whole app is set in. SF Pro is the iOS-native default and
    /// is the closest match to the ChatGPT-style transcript reference.
    @Published var typeface: AppTypeface {
        didSet { store.set(typeface.rawValue, forKey: Self.typefaceKey) }
    }

    /// The whole phone's text size. Dynamic Type still applies on top of this
    /// deliberate app-level adjustment.
    @Published var fontScale: AppFontScale {
        didSet { store.set(fontScale.rawValue, forKey: Self.fontScaleKey) }
    }

    @Published var activityIconColorMode: ActivityIconColorMode {
        didSet { store.set(activityIconColorMode.rawValue, forKey: Self.activityIconColorModeKey) }
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
        chatIcons = store.object(forKey: Self.chatIconsKey) as? Bool ?? true
        providerMarks = store.object(forKey: Self.providerMarksKey) as? Bool ?? true
        mascot = store.object(forKey: Self.mascotKey) as? Bool ?? true
        // Accent is the page's own default, so anything unreadable — and the
        // absence of the key — lands there rather than on gray.
        accentBubbles = store.string(forKey: Self.bubbleTintKey) != "neutral"
        chatDetail = MobileChatDetail(rawValue: store.integer(forKey: Self.chatDetailKey)) ?? .compact
        typeface = AppTypeface(rawValue: store.string(forKey: Self.typefaceKey) ?? "") ?? .system
        fontScale = AppFontScale(rawValue: store.integer(forKey: Self.fontScaleKey)) ?? .standard
        activityIconColorMode = ActivityIconColorMode(
            rawValue: store.string(forKey: Self.activityIconColorModeKey) ?? ""
        ) ?? .color
    }
}

extension View {
    /// Apply the whole appearance in one place: the resolved scheme (which
    /// stamps the trait every dynamic colour resolves against), the accent
    /// the design system reads, and the tint the handful of remaining stock
    /// controls read.
    func appearance(_ appearance: Appearance) -> some View {
        typeScale(appearance.typeface, fontScale: appearance.fontScale)
            .environment(\.accentTint, appearance.tint)
            .environment(\.chatIcons, appearance.chatIcons)
            .environment(\.providerMarks, appearance.providerMarks)
            .environment(\.mascotVisible, appearance.mascot)
            .environment(\.mobileChatDetail, appearance.chatDetail)
            .environment(\.activityIconColorMode, appearance.activityIconColorMode)
            .tint(appearance.tint.color)
            .preferredColorScheme(appearance.theme.colorScheme)
    }
}

/// Handed down the tree the way the accent is, so a row reads it without an
/// `@EnvironmentObject` every `#Preview` would then have to supply.
private struct ChatIconsKey: EnvironmentKey {
    static let defaultValue = true
}

/// The narrower switch under it, handed down the same way.
private struct ProviderMarksKey: EnvironmentKey {
    static let defaultValue = true
}

/// Same reason as the chat icons: the fox is drawn from the header, the
/// new-chat sheet and the empty state, and none of them should need an
/// `@EnvironmentObject` a `#Preview` would have to supply.
private struct MascotVisibleKey: EnvironmentKey {
    static let defaultValue = true
}

private struct ActivityIconColorModeKey: EnvironmentKey {
    static let defaultValue = ActivityIconColorMode.color
}

extension EnvironmentValues {
    var chatIcons: Bool {
        get { self[ChatIconsKey.self] }
        set { self[ChatIconsKey.self] = newValue }
    }

    var providerMarks: Bool {
        get { self[ProviderMarksKey.self] }
        set { self[ProviderMarksKey.self] = newValue }
    }

    var mascotVisible: Bool {
        get { self[MascotVisibleKey.self] }
        set { self[MascotVisibleKey.self] = newValue }
    }

    var activityIconColorMode: ActivityIconColorMode {
        get { self[ActivityIconColorModeKey.self] }
        set { self[ActivityIconColorModeKey.self] = newValue }
    }
}
