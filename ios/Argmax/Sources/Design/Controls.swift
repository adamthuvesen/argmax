import SwiftUI

// The app's controls. There are six, and no screen invents a seventh.

/// The one accent-filled button on a screen, and never two.
struct PrimaryButton: View {
    let title: String
    var systemImage: String?
    var busy = false
    let action: () -> Void

    @Environment(\.accentTint) private var accent
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button {
            Haptics.light()
            action()
        } label: {
            HStack(spacing: Spacing.snug) {
                if busy {
                    // The system spinner, tinted: a hand-drawn one would be
                    // a second waiting shape for no gain.
                    ProgressView()
                        .controlSize(.small)
                        .tint(accent.onAccent)
                } else if let systemImage {
                    Image(systemName: systemImage).font(.subheadline.weight(.semibold))
                }
                Text(title).font(.body.weight(.semibold))
            }
            // Off, it drops the fill entirely rather than fading it: a 35%
            // accent slab is still the loudest thing on the screen, and it
            // reads as a colour choice rather than as "not yet". Working is
            // not off, though — a busy button is disabled so it cannot fire
            // twice, and it keeps the fill so the wait reads as this
            // button's wait.
            .foregroundStyle(filled ? accent.onAccent : Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(
                filled ? AnyShapeStyle(accent.color) : AnyShapeStyle(Theme.raised),
                in: .rect(cornerRadius: Radius.control, style: .continuous)
            )
        }
        .buttonStyle(PressDim())
    }

    private var filled: Bool { isEnabled || busy }
}

/// A secondary action beside the primary one. No fill of its own beyond the
/// 4% raised step, and no border.
struct QuietButton: View {
    let title: String
    var systemImage: String?
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            HStack(spacing: Spacing.tight + 2) {
                if let systemImage {
                    Image(systemName: systemImage).font(.subheadline.weight(.medium))
                }
                Text(title).font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(Theme.ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.control, style: .continuous))
            .opacity(isEnabled ? 1 : 0.35)
        }
        .buttonStyle(PressDim())
    }
}

/// A chosen value you can change: the New chat sheet's project, workspace,
/// model and effort. Label above, value below, and a chevron that says it
/// opens.
///
/// Every cell is the same size, because the choices are one set. The first
/// pass sized each to its content and drew a border round it, which made
/// four related choices read as four differently shaped cards — the width of
/// "Effort · Medium" against "Project · revops-backoffice" was carrying
/// meaning it does not have. The grid that arranges these is in
/// `NewChatSheet`; the cell only promises to fill whatever cell it is given.
struct PickerCell: View {
    let label: String
    let value: String
    var mono = false
    var glyph: AnyView?
    let action: () -> Void

    /// Two lines of type with air around them, and a thumb target well over
    /// the 44pt floor. Every cell in a row shares it, so a one-line value
    /// and a wrapped one still line up.
    static let minHeight: CGFloat = 56

    var body: some View {
        Button {
            Haptics.light()
            action()
        } label: {
            HStack(spacing: Spacing.snug) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    HStack(spacing: Spacing.tight + 2) {
                        if let glyph { glyph }
                        Text(value)
                            .font(mono ? .argmaxMono(.subheadline) : .subheadline)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                            // Tail, not middle: the head of a project or
                            // model name is what tells them apart, and a
                            // cell is narrow enough that middle truncation
                            // ate it.
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: Spacing.tight)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, Spacing.row)
            .padding(.vertical, Spacing.snug)
            .frame(maxWidth: .infinity, minHeight: Self.minHeight, alignment: .leading)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.cell, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(PressDim())
        .accessibilityLabel("\(label): \(value)")
    }
}

/// What a chat says about itself in the trailing column: "Needs you",
/// "Blocked", "Failed", "Done".
///
/// A 16% fill of its own colour with the full colour for the text. A solid
/// capsule at this size clears no contrast bar worth the name, and a column
/// of saturated pills shouts down the titles it is meant to rank.
struct AttentionCapsule: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label)
            .typeChip()
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.16), in: .capsule)
            .accessibilityLabel(label)
    }
}

/// One hairline at device resolution, inset to whatever column its caller
/// keeps its text on.
struct HairlineDivider: View {
    var inset: CGFloat = 0

    var body: some View {
        Theme.line
            .frame(height: 1 / UIScreen.main.scale)
            .padding(.leading, inset)
            .accessibilityHidden(true)
    }
}

/// Nothing here yet, or nothing that worked: one mark, one line, one action.
struct EmptyState: View {
    enum Mark {
        /// The fox, at the size the pairing screen uses it minus half.
        case fox
        case glyph(String)
    }

    var mark: Mark = .fox
    let message: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        VStack(spacing: Spacing.gutter) {
            switch mark {
            case .fox:
                FoxMark(size: 84).opacity(0.9)
            case .glyph(let name):
                Image(systemName: name)
                    .font(.system(size: 30, weight: .medium))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(Theme.muted)
            }
            Text(message)
                .typeContent()
                .multilineTextAlignment(.center)
            if let action {
                QuietButton(title: action.title, action: action.run)
                    .frame(maxWidth: 200)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .screenGutter()
    }
}

/// The socket is down. A 28pt strip under the header, never a banner that
/// pushes the rows: the chats on screen are still the right chats, only
/// stale, and moving them is the one thing that makes that worse.
struct ReconnectingStrip: View {
    var message = "Reconnecting to your Mac…"

    var body: some View {
        HStack(spacing: Spacing.snug) {
            ProgressView()
                .controlSize(.mini)
                .tint(Theme.muted)
            Text(message)
                .font(.caption2)
                .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, minHeight: 28)
        .background(Theme.raised)
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// A field you type into: the raised step, our corners, no border. The
    /// system's `.roundedBorder` draws a grey stroke on a white fill, which
    /// is neither of our surfaces.
    func fieldSurface(cornerRadius: CGFloat = Radius.card) -> some View {
        padding(.horizontal, Spacing.row)
            .padding(.vertical, Spacing.row)
            .background(Theme.raised, in: .rect(cornerRadius: cornerRadius, style: .continuous))
    }

    /// The composer's own card — New chat's, and the transcript's when native
    /// draws it (`TranscriptComposer`). A card's corners, not a field's: the
    /// composer holds more than one control, and `fieldSurface`'s radius reads
    /// as a text field's.
    func composerCardSurface() -> some View {
        padding(Spacing.row + 4)
            .background(RoundedRectangle(cornerRadius: Radius.composer, style: .continuous).fill(Theme.raised))
    }

    /// The chip along the composer's floor: one recessed pill, whatever it
    /// holds. `Theme.ground` inside a `Theme.raised` card is a 4% step — the
    /// same one that separates the card from the screen — so the chip reads
    /// as part of the card rather than as a second card on top of it.
    func composerChipSurface() -> some View {
        padding(.horizontal, Spacing.row)
            .padding(.vertical, 7)
            .background(Capsule(style: .continuous).fill(Theme.ground))
    }

    /// The round chip a single glyph sits in — the plus, the mic. Same fill
    /// as the model chip beside them, so the floor reads as one row of
    /// controls rather than as icons and a pill.
    func composerGlyphSurface() -> some View {
        frame(width: Spacing.composerControl, height: Spacing.composerControl)
            .background(Circle().fill(Theme.ground))
            .contentShape(.circle)
    }
}

/// One decision inside the composer's chip: a label you tap, and nothing
/// else. No fill and no chevron of its own — the chip around it carries the
/// fill for both, and two chevrons in one pill only ask which one is the
/// control. New chat's composer card and the transcript's native one open a
/// `PickerSheet` or `EffortDial` from one of these, not `PickerCell`, which is
/// New chat's own four-choice grid.
struct ComposerChipButton<Content: View>: View {
    let action: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                content()
            }
            .lineLimit(1)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// Pressed is a dim, never a scale. A control that shrinks under the thumb
/// reads as a toy.
struct PressDim: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.72 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
