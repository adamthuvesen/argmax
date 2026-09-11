import SwiftUI
import UIKit

/// Settings: whether the Mac can reach you, what the app looks like, and
/// which Mac it is. Groups of one row shape repeated, exactly as the
/// desktop's settings page is built.
///
/// In that order, which is how often a person comes here for each: the
/// pairing is read once and changed almost never — so it sits at the
/// bottom, beside the destructive thing it carries. What is left on the
/// plans lives on the Usage page, beside the spend it belongs to.
struct SettingsScreen: View {
    /// The paired host, as the pairing link names it.
    let host: String
    let onPairAgain: () -> Void
    let onBack: () -> Void

    @EnvironmentObject private var appearance: Appearance
    @EnvironmentObject private var push: PushRegistration
    @State private var confirmingRepair = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.section) {
                SettingGroup("Notifications") {
                    NotificationsSetting(push: push)
                }

                SettingGroup("Appearance") {
                    VStack(alignment: .leading, spacing: Spacing.row) {
                        Text("Theme").typeContent()
                        Segmented(
                            options: ThemeChoice.allCases,
                            selection: $appearance.theme,
                            label: \.label
                        )
                    }
                    .padding(Spacing.row)
                    HairlineDivider(inset: Spacing.row)
                    VStack(alignment: .leading, spacing: Spacing.row) {
                        Text("Accent").typeContent()
                        AccentChips(selection: $appearance.tint)
                    }
                    .padding(Spacing.row)
                    HairlineDivider(inset: Spacing.row)
                    SettingToggle(
                        label: "Accent bubbles",
                        detail: "Your own messages fill with the accent instead of a quiet gray.",
                        isOn: $appearance.accentBubbles
                    )
                    HairlineDivider(inset: Spacing.row)
                    SettingToggle(
                        label: "Provider marks",
                        detail: "The CLI's mark on chats with no icon of their own.",
                        isOn: $appearance.providerMarks
                    )
                    HairlineDivider(inset: Spacing.row)
                    SettingToggle(
                        label: "Fox mascot",
                        detail: "The fox in the Chats header, on a new chat, and on an empty screen.",
                        isOn: $appearance.mascot
                    )
                }

                SettingGroup("Your Mac") {
                    SettingRow(label: "Paired with", detail: host, mono: true)
                    HairlineDivider(inset: Spacing.row)
                    SettingRow(
                        label: "Re-pair",
                        detail: "Point this phone at another Mac, or at a new link.",
                        action: { confirmingRepair = true }
                    )
                }
            }
            .screenGutter()
            .padding(.top, Spacing.snug)
            .padding(.bottom, Spacing.section)
        }
        .background(Theme.ground.ignoresSafeArea())
        .safeAreaInset(edge: .top, spacing: 0) {
            ScreenHeader(title: "Settings", onBack: onBack)
        }
        .toolbar(.hidden, for: .navigationBar)
        .interactivePop()
        .confirmationDialog(
            "Pair with another Mac?",
            isPresented: $confirmingRepair,
            titleVisibility: .visible
        ) {
            // The system dialog, deliberately: it is the one control iOS
            // draws over everything including the keyboard, and a
            // destructive choice is exactly what people expect it for.
            Button("Re-pair", role: .destructive, action: onPairAgain)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This chat list and its pairing are forgotten. Nothing on the Mac changes.")
        }
    }
}

// MARK: - Row shapes

/// A group of settings: a heading, then one raised card. Adding a setting
/// means adding a row, never inventing a layout — the same rule the
/// desktop's settings page holds to.
struct SettingGroup<Content: View>: View {
    let title: String
    @ViewBuilder var content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            Text(title).typeSectionHeading()
            VStack(alignment: .leading, spacing: 0) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        }
    }
}

/// Label, an optional line under it, and either a value on the right or a
/// chevron when the row does something.
struct SettingRow: View {
    let label: String
    var detail: String?
    var mono = false
    var enabled = true
    var action: (() -> Void)?

    var body: some View {
        if let action, enabled {
            Button(action: action) { content }
                .buttonStyle(PressDim())
        } else {
            content
        }
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.row) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .typeContent()
                    .foregroundStyle(enabled ? Theme.ink : Theme.muted)
                if let detail, !mono {
                    Text(detail).typeMeta()
                }
            }
            Spacer(minLength: Spacing.snug)
            if let detail, mono {
                Text(detail)
                    .font(.argmaxMono(.footnote))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .truncationMode(.head)
            } else if action != nil {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
        }
        .padding(Spacing.row)
        .contentShape(.rect)
    }
}

/// A setting that is on or off. Our row, and the system's switch tinted to
/// the accent.
///
/// `Toggle` rather than a drawn one: the switch is a control people operate
/// by feel — the thumb travel, the flick-to-toggle, the haptic at the end of
/// it — and none of that is pixels. Only its label and its track colour are
/// ours, and `.appearance()` has already set the tint on the tree.
struct SettingToggle: View {
    let label: String
    var detail: String?
    @Binding var isOn: Bool

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).typeContent()
                if let detail {
                    Text(detail).typeMeta()
                }
            }
        }
        .padding(Spacing.row)
        .onChange(of: isOn) { _, _ in Haptics.light() }
    }
}

// MARK: - Appearance controls

/// Three or four choices where a picker sheet would be two taps for one
/// decision. The selected segment carries the accent at 16% with the full
/// colour for its label — the attention capsule's recipe, because it is the
/// same job: mark one of a set without shouting.
struct Segmented<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let label: (Option) -> String

    @Environment(\.accentTint) private var accent

    var body: some View {
        HStack(spacing: Spacing.tight) {
            ForEach(options) { option in
                let chosen = option == selection
                Button {
                    Haptics.light()
                    selection = option
                } label: {
                    Text(label(option))
                        .font(.footnote.weight(.semibold))
                        .lineLimit(1)
                        // Six efforts across a phone: "Extra High" gives a
                        // little rather than breaking the row's height.
                        .minimumScaleFactor(0.75)
                        .foregroundStyle(chosen ? accent.color : Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background(
                            chosen ? accent.color.opacity(0.16) : Color.clear,
                            in: .rect(cornerRadius: Radius.control - 2, style: .continuous)
                        )
                        .contentShape(.rect)
                }
                .buttonStyle(PressDim())
                .accessibilityAddTraits(chosen ? [.isSelected] : [])
            }
        }
        .padding(3)
        // A step *down* from the card it sits in, so the track reads as a
        // groove rather than a second card.
        .background(Theme.ground, in: .rect(cornerRadius: Radius.control, style: .continuous))
    }
}

/// The desktop's seven tints as swatches. A colour is the only honest label
/// for a colour, so the chips carry no text — the name goes to VoiceOver.
struct AccentChips: View {
    @Binding var selection: AccentTint

    var body: some View {
        HStack(spacing: Spacing.snug) {
            ForEach(AccentTint.allCases) { tint in
                let chosen = tint == selection
                Button {
                    Haptics.light()
                    selection = tint
                } label: {
                    ZStack {
                        Circle()
                            .strokeBorder(chosen ? tint.color : .clear, lineWidth: 2)
                            .frame(width: 30, height: 30)
                        Circle()
                            .fill(tint.color)
                            .frame(width: 20, height: 20)
                    }
                    .frame(width: 34, height: 34)
                    .contentShape(.circle)
                }
                .buttonStyle(PressDim())
                .accessibilityLabel(tint.label)
                .accessibilityAddTraits(chosen ? [.isSelected] : [])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Notifications

/// What the Mac can do, what iOS has allowed, and the one action that closes
/// whichever gap is open.
///
/// Never two actions: each state has exactly one thing to do next. A Mac
/// with no APNs key is a line at the top rather than a dead end — the fix
/// for it is on the Mac, but the fix for the iOS half is right here and
/// registering works without a key.
struct NotificationsSetting: View {
    @ObservedObject var push: PushRegistration

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let leadLine {
                // Amber, the needs-you colour: a gap someone has to close,
                // and not one on this device.
                Text(leadLine)
                    .font(.footnote)
                    .foregroundStyle(Theme.amber)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.row)
                HairlineDivider(inset: Spacing.row)
            }
            statusRow
            action
            if let note {
                Text(note.text)
                    .typeMeta()
                    .foregroundStyle(note.failed ? Theme.rose : Theme.muted)
                    .padding(.horizontal, Spacing.row)
                    .padding(.bottom, Spacing.row)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: push.note)
    }

    /// The Mac's own gap, above everything iOS has to say about this phone.
    /// Registering does not need the key, so this is a line rather than a
    /// dead end.
    private var leadLine: String? {
        push.hostConfigured == false ? PushRegistration.noKeyOnMac : nil
    }

    /// What the last action answered — unless the section already leads with
    /// the same sentence. "Send test" against a Mac with no key answers with
    /// exactly the line above it, and printing it twice reads as two
    /// problems.
    private var note: PushRegistration.Note? {
        guard let note = push.note, note.text != leadLine else { return nil }
        return note
    }

    @ViewBuilder
    private var statusRow: some View {
        switch push.status {
        case .checking:
            // A second at most on a live pairing, and a sentence that
            // flashes is worse than a quiet one.
            SettingRow(label: "Push notifications", detail: "Checking…", enabled: false)
        case .notDetermined:
            SettingRow(label: "Push notifications", detail: "Off")
        case .denied:
            SettingRow(label: "Push notifications", detail: "Off — iOS is blocking them.")
        case .enabled(let deviceName):
            SettingRow(label: "Push notifications", detail: "On · \(deviceName)")
        }
    }

    @ViewBuilder
    private var action: some View {
        switch push.status {
        case .notDetermined:
            HairlineDivider(inset: Spacing.row)
            // The screen's one accent-filled button, and the only place in
            // Settings that gets one: this is the whole point of the
            // section.
            PrimaryButton(title: "Enable") {
                Task { await push.requestAndRegister() }
            }
            .padding(Spacing.row)
        case .denied:
            HairlineDivider(inset: Spacing.row)
            SettingRow(
                label: "Open iOS Settings",
                detail: "Notifications for Argmax are off there.",
                action: openSystemSettings
            )
        case .enabled:
            HairlineDivider(inset: Spacing.row)
            QuietButton(title: push.testing ? "Sending…" : "Send test") {
                Task { await push.sendTest() }
            }
            .disabled(push.testing)
            .padding(Spacing.row)
        case .checking:
            EmptyView()
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

#if DEBUG
#Preview("Settings") {
    NavigationStack {
        SettingsScreen(host: "spark.tail1234.ts.net", onPairAgain: {}, onBack: {})
            .environmentObject(Appearance())
            .environmentObject(PushRegistration.preview(.enabled(deviceName: "Adam\u{2019}s iPhone")))
    }
}

/// Every state of the one section that has more than one.
#Preview("Notifications") {
    ScrollView {
        VStack(alignment: .leading, spacing: Spacing.section) {
            SettingGroup("No key on the Mac") {
                NotificationsSetting(push: .preview(.notDetermined, hostConfigured: false))
            }
            SettingGroup("Not asked yet") {
                NotificationsSetting(push: .preview(.notDetermined))
            }
            SettingGroup("Refused") {
                NotificationsSetting(push: .preview(.denied))
            }
            SettingGroup("On") {
                NotificationsSetting(
                    push: .preview(
                        .enabled(deviceName: "Adam\u{2019}s iPhone"),
                        note: .init(text: "Sent. It should arrive in a moment.", failed: false)
                    )
                )
            }
        }
        .screenGutter()
        .padding(.vertical, Spacing.section)
    }
    .background(Theme.ground.ignoresSafeArea())
}
#endif
