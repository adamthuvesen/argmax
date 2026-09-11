import SwiftUI

/// What is left on each provider plan: the desktop Usage page's "Remaining
/// on your plans", as one settings card.
///
/// One block per login, in the order the Mac sends them, each a heading line
/// and its windows. A meter is a label, a percentage, when it comes back,
/// and a 3pt bar under them — the desktop's shape, because the numbers are
/// the same numbers and a phone-only arrangement of them would be a second
/// thing to learn.
struct PlanLimitsSection: View {
    @ObservedObject var store: PlanLimitsStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let limits = store.limits {
                ForEach(Array(limits.providers.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { HairlineDivider(inset: Spacing.row) }
                    ProviderLimitsRow(row: row)
                }
                if let failure = store.failure {
                    HairlineDivider(inset: Spacing.row)
                    RetryRow(message: failure, store: store)
                }
            } else if let failure = store.failure {
                RetryRow(message: failure, store: store)
            } else {
                // The Mac is calling five provider endpoints; a second or
                // two of this is the normal case, not a stall.
                Text("Reading what each provider says is left.")
                    .typeMeta()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Spacing.row)
            }
        }
        // Warm from the pairing's store, so this is usually a silent
        // top-up under rows that are already on screen.
        .task { await store.refreshIfStale() }
    }
}

/// One login: its mark, its name, its plan, and either meters or the one
/// sentence that says why there are none.
private struct ProviderLimitsRow: View {
    let row: ProviderLimits

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            HStack(spacing: Spacing.snug) {
                ProviderMark(provider: row.provider)
                Text(ProviderMark.displayName(row.provider)).typeContent()
                Spacer(minLength: Spacing.snug)
                if let plan = row.kindLabel {
                    Text(plan).typeMeta()
                }
            }
            if row.showsWindows {
                ForEach(row.windows) { window in
                    WindowMeter(window: window, tint: ProviderMark.tint(row.provider))
                }
                if let message = row.message {
                    LimitMessage(message: message, url: row.messageUrl)
                }
            } else {
                LimitMessage(
                    message: row.message ?? "No remaining usage to show.",
                    url: row.messageUrl
                )
            }
        }
        .padding(Spacing.row)
    }
}

/// A window and how much of it is left.
private struct WindowMeter: View {
    let window: LimitWindow
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.tight) {
            HStack(spacing: Spacing.snug) {
                Text(window.label).typeMeta()
                Spacer(minLength: Spacing.tight)
                Text(LimitCopy.left(window.remainingPercent))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                if let reset = LimitCopy.reset(window.resetsAt) {
                    Text(reset).typeMeta()
                }
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.line)
                    Capsule()
                        .fill(tint)
                        .frame(width: fill(of: geometry.size.width))
                }
            }
            .frame(height: 3)
        }
        .accessibilityElement(children: .combine)
    }

    /// A sliver rather than nothing at the bottom of a window: a bar that
    /// vanishes reads as a missing meter, not as a spent one.
    private func fill(of width: CGFloat) -> CGFloat {
        guard window.remainingPercent.isFinite, window.remainingPercent > 0 else { return 0 }
        let share = min(1, window.remainingPercent / 100)
        return max(3, width * share)
    }
}

/// The line a login without meters carries. Cursor's names a dashboard, and
/// the name is the tap target.
private struct LimitMessage: View {
    let message: String
    let url: String?

    private static let linkText = "Spending dashboard"

    var body: some View {
        Text(.init(linked)).typeMeta()
    }

    /// The message with its dashboard turned into a link, and the plain
    /// message when it names none. Markdown rather than concatenated `Text`,
    /// because a link inside a sentence has to wrap with the sentence.
    private var linked: String {
        guard let url, let range = message.range(of: Self.linkText) else { return message }
        return message.replacingCharacters(in: range, with: "[\(Self.linkText)](\(url))")
    }
}

/// A failed read: the Mac's own words, and the one thing to do about them.
private struct RetryRow: View {
    let message: String
    @ObservedObject var store: PlanLimitsStore

    var body: some View {
        SettingRow(
            label: store.loading ? "Reading…" : "Try again",
            detail: message,
            enabled: !store.loading,
            action: { Task { await store.reload() } }
        )
    }
}

#if DEBUG
#Preview("Plan limits") {
    ScrollView {
        VStack(alignment: .leading, spacing: Spacing.section) {
            SettingGroup("Plan limits") {
                PlanLimitsSection(store: .preview(previewPlanLimits))
            }
            SettingGroup("Reading") {
                PlanLimitsSection(store: .preview(nil, loading: true))
            }
            SettingGroup("Unreachable") {
                PlanLimitsSection(store: .preview(nil, failure: "Can't reach your Mac."))
            }
        }
        .screenGutter()
        .padding(.vertical, Spacing.section)
    }
    .background(Theme.ground.ignoresSafeArea())
}

private let previewPlanLimits = PlanLimits(
    fetchedAt: "2026-09-11T10:01:40Z",
    providers: [
        ProviderLimits(
            provider: "claude",
            kind: .subscription,
            planLabel: "Max 20x",
            windows: [
                LimitWindow(id: "five_hour", label: "5-hour", remainingPercent: 72, resetsAt: nil),
                LimitWindow(id: "seven_day_fable", label: "Weekly Fable", remainingPercent: 47, resetsAt: nil),
                LimitWindow(id: "seven_day", label: "Weekly", remainingPercent: 36, resetsAt: nil)
            ],
            message: nil,
            messageUrl: nil
        ),
        ProviderLimits(
            provider: "cursor",
            kind: .enterprise,
            planLabel: "Teams",
            windows: [],
            message: "Cursor remaining lives on the Spending dashboard.",
            messageUrl: "https://cursor.com/dashboard/spending"
        )
    ]
)
#endif
