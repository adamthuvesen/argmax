import SwiftUI

/// First run, and the way back after a token changes.
///
/// The only screen with no header and no chrome: one fox, one field, one
/// primary action. Nothing else has been earned yet — there is no list to
/// title and nothing to navigate to.
struct PairingScreen: View {
    let onPaired: (URL) -> Void

    @State private var link = ""
    @State private var rejected = false
    @FocusState private var editing: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                FoxMark(size: 168)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 56)
                    .padding(.bottom, 40)

                Text("Pair with your Mac")
                    .typeScreenTitle()
                Text("Copy the pairing link from Argmax on your Mac: Settings → Integrations → Remote access.")
                    .typeMeta()
                    .padding(.top, Spacing.snug)

                field
                    .padding(.top, Spacing.gutter)

                if rejected {
                    // Plain http is the trap: App Transport Security refuses
                    // it before WebKit ever connects, so refuse it here with
                    // a reason instead of letting the load fail silently
                    // later. Under the field in attention red, not an alert.
                    Text("That is not a pairing link. It has to be https:// and carry the #token= fragment.")
                        .font(.footnote)
                        .foregroundStyle(Theme.rose)
                        .padding(.top, Spacing.snug)
                        .transition(.opacity)
                }

                actions
                    .padding(.top, Spacing.gutter)
            }
            .screenGutter()
            .padding(.bottom, Spacing.section)
        }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.ground.ignoresSafeArea())
        .animation(.easeOut(duration: 0.15), value: rejected)
    }

    private var field: some View {
        TextField("", text: $link, axis: .vertical)
            .font(.argmaxMono(.footnote))
            .foregroundStyle(Theme.ink)
            .tint(Theme.ink)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.URL)
            .lineLimit(1...4)
            .focused($editing)
            .onChange(of: link) { rejected = false }
            .overlay(alignment: .topLeading) {
                // A `TextField` prompt is drawn in the system's placeholder
                // grey and in the field's own font; this one has to be our
                // muted ink at mono, and has to survive the vertical axis.
                if link.isEmpty {
                    Text(verbatim: "https://your-mac.ts.net/mobile.html#token=…")
                        .font(.argmaxMono(.footnote))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .allowsHitTesting(false)
                }
            }
            .fieldSurface()
            .accessibilityLabel("Pairing link")
    }

    @ViewBuilder
    private var actions: some View {
        let paste = QuietButton(title: "Paste link", systemImage: "doc.on.clipboard") {
            link = UIPasteboard.general.string ?? link
            rejected = false
        }
        let connect = PrimaryButton(title: "Connect", action: connect)
            .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        // Side by side until the type is large enough that two labels in one
        // row would each truncate to nothing.
        if typeSize.isAccessibilitySize {
            VStack(spacing: Spacing.row) {
                connect
                paste
            }
        } else {
            HStack(spacing: Spacing.row) {
                paste.frame(width: 148)
                connect
            }
        }
    }

    private func connect() {
        guard let url = PairingLink.validate(link) else {
            rejected = true
            Haptics.warning()
            return
        }
        editing = false
        HostCredential.save(url)
        onPaired(url)
    }
}

#if DEBUG
#Preview("Pairing") {
    PairingScreen { _ in }
}

#Preview("Rejected") {
    PairingScreen { _ in }
        .environment(\.colorScheme, .dark)
}
#endif
