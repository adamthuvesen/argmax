import SwiftUI

// One picker, used everywhere something is chosen from a list.
//
// The desktop has exactly one dropdown primitive
// (`.project-picker-popover`), and this is its phone form: rows on the
// sheet's own ground, the chosen one marked by a check in a fixed lead cell
// and by weight — never by a fill, because a fill is what pressed looks
// like and the two must not read alike. Group headers where a list needs
// them (the model picker's five CLIs).
//
// A `Picker` with `.navigationLink` would have been free, and it is what the
// first pass used. It draws a grouped-inset `Form` inside a pushed screen
// with a blue check and a system large title — three of the four things the
// brief names as decisions not to design.

struct PickerOption<Value: Hashable>: Identifiable {
    let value: Value
    let label: String
    /// The trailing column: a model's context window, a project's branch.
    var detail: String?
    /// Branch names and model ids are typed by hand somewhere else.
    var mono = false
    /// A context window is a number read against other numbers, so it takes
    /// the figures that line up.
    var detailMono = false
    /// Offerable but not right now — a CLI that is not installed. Dimmed
    /// rather than removed: "Codex, not signed in" is an answer, and a
    /// provider that silently vanished from the list is not.
    var dimmed = false
    var group: String?
    /// The group's own mark and its one-line reason, carried on the option
    /// because a group is a heading over rows and not a value of its own.
    /// Read from the first option in each group.
    var groupGlyph: AnyView?
    var groupDetail: String?
    var glyph: AnyView?

    var id: Value { value }
}

struct PickerSheet<Value: Hashable>: View {
    let title: String
    let options: [PickerOption<Value>]
    @Binding var selection: Value
    /// Shown in place of the list when there is nothing to choose from.
    var emptyMessage = "Nothing to choose from."

    @Environment(\.dismiss) private var dismiss
    @Environment(\.accentTint) private var accent
    /// Dynamic Type moves every row, so the height this sheet asks for has
    /// to move with it.
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(spacing: 0) {
            ScreenHeader(title: title) {
                HeaderGlyphButton(systemName: "xmark", label: "Close", tint: Theme.muted) { dismiss() }
            }
            if options.isEmpty {
                EmptyState(mark: .glyph("tray"), message: emptyMessage)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups, id: \.name) { group in
                            Section {
                                ForEach(group.options) { option in
                                    row(option)
                                }
                            } header: {
                                if group.name != nil {
                                    heading(group)
                                }
                            }
                        }
                    }
                    .padding(.bottom, Spacing.section)
                }
            }
        }
        .background(Theme.ground)
        // As tall as its choices, and never past seven tenths of the screen: a
        // picker is a choice, not a place, and the effort list is four rows.
        .argmaxSheet(detents: [.height(sheetHeight)])
        // A swipe scrolls the list; only the grabber resizes the sheet. Without
        // this the first scroll gesture grows the sheet instead of moving rows.
        .presentationContentInteraction(.scrolls)
    }

    /// A group's heading: its mark, its name, and the reason none of its
    /// rows can be picked when there is one. Smaller and wider-tracked than
    /// the rows under it, so it reads as a label rather than as a first row.
    private func heading(_ group: (name: String?, options: [PickerOption<Value>])) -> some View {
        let lead = group.options.first
        return HStack(spacing: Spacing.snug) {
            Group {
                if let glyph = lead?.groupGlyph { glyph }
            }
            // The rows' own lead cell, so a provider's mark sits on the
            // column their checks do.
            .frame(width: 18, alignment: .center)
            Text(group.name ?? "")
                .font(.caption2.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(Theme.muted)
            if let detail = lead?.groupDetail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, Spacing.row)
        .padding(.bottom, Spacing.tight)
        .screenGutter()
        .frame(maxWidth: .infinity, alignment: .leading)
        // A list that always scrolls has to keep saying which group the row
        // under the thumb belongs to.
        .background(Theme.ground)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }

    private func row(_ option: PickerOption<Value>) -> some View {
        Button {
            Haptics.light()
            selection = option.value
            dismiss()
        } label: {
            HStack(spacing: Spacing.row) {
                // A fixed lead cell, so every label in the sheet sits on one
                // column whether or not its row is the chosen one.
                Group {
                    if let glyph = option.glyph {
                        glyph
                    } else if option.value == selection {
                        Image(systemName: "checkmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(accent.color)
                    }
                }
                .frame(width: 18, alignment: .center)
                Text(option.label)
                    .font(option.mono
                        ? .argmaxMono(.subheadline)
                        : .subheadline.weight(option.value == selection ? .semibold : .regular))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: Spacing.snug)
                if let detail = option.detail {
                    Text(detail)
                        .font(option.detailMono ? .argmaxMono(.caption2) : .caption2)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
            }
            .padding(.vertical, Spacing.row)
            .screenGutter()
            .frame(maxWidth: .infinity, alignment: .leading)
            .opacity(option.dimmed ? 0.45 : 1)
            .contentShape(.rect)
        }
        .buttonStyle(RowPress())
        .accessibilityAddTraits(option.value == selection ? [.isSelected] : [])
    }

    private var groups: [(name: String?, options: [PickerOption<Value>])] {
        var order: [String?] = []
        var byGroup: [String?: [PickerOption<Value>]] = [:]
        for option in options {
            if byGroup[option.group] == nil { order.append(option.group) }
            byGroup[option.group, default: []].append(option)
        }
        return order.map { ($0, byGroup[$0] ?? []) }
    }
}

/// A row lights up under the thumb; it does not scale. 6% ink, the raised
extension PickerSheet {
    var sheetHeight: CGFloat {
        // Read so a Dynamic Type change re-evaluates the detent. The metrics
        // inside read the same trait, but from UIKit, where SwiftUI cannot
        // see the dependency.
        _ = typeSize
        return pickerSheetHeight(
            rows: options.count,
            headings: groups.filter { $0.name != nil }.count,
            screenHeight: UIScreen.main.bounds.height
        )
    }
}

/// How tall the picker opens: the height of the rows it actually has.
///
/// Counted rather than measured. The first pass measured the list with a
/// `GeometryReader` and fed that back into the `.height` detent — a sheet
/// whose height depends on the content it is sizing — and the measurement
/// never made it back into the presented sheet, so every picker opened at
/// the cap and stayed there. A running chat locks the model list to the
/// session's own CLI, which is three or four rows: three rows of choices
/// under two-thirds of a blank screen.
///
/// The rows are one line each by construction (`lineLimit(1)`), so their
/// height is the text style's line plus its padding, and `UIFontMetrics`
/// carries Dynamic Type into the count. The cap stays: a picker is a choice,
/// not a place.
func pickerSheetHeight(
    rows: Int,
    headings: Int,
    screenHeight: CGFloat,
    scaled: (UIFont.TextStyle, CGFloat) -> CGFloat = { style, value in
        UIFontMetrics(forTextStyle: style).scaledValue(for: value)
    }
) -> CGFloat {
    let cap = screenHeight * 0.7
    // The empty state is a mark and a line, and a sheet cropped to its own
    // header would cut them off.
    guard rows > 0 else { return min(240, cap) }
    let row = scaled(.subheadline, 20) + Spacing.row * 2
    // The heading's own line plus its tracking and the space it keeps from
    // the rows: 18 rather than caption2's nominal 13, which is what a
    // rendered heading actually occupies (`ScratchPickerMeasureTests`).
    let heading = scaled(.caption2, 18) + Spacing.row + Spacing.tight
    let content = CGFloat(rows) * row + CGFloat(headings) * heading + Spacing.section
    return min(content + Spacing.headerHeight, cap)
}

/// step plus one.
struct RowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.pressed : Theme.ground)
    }
}

extension View {
    /// Every sheet in this app: our ground rather than `.regularMaterial`,
    /// and the system grabber, which is the one piece of sheet chrome a
    /// person already knows how to read.
    func argmaxSheet(detents: Set<PresentationDetent> = [.large]) -> some View {
        presentationDetents(detents)
            .presentationDragIndicator(.visible)
            .presentationBackground(Theme.ground)
            .presentationCornerRadius(Radius.card + 6)
    }
}
