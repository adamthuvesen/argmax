import SwiftUI

// Shared shapes for the Insights pages: one card language across Usage and
// Activity so the two pages read as one surface — a raised card, an eyebrow,
// a hero number, and hairline-divided rows. All color from `Theme`, all type
// from `Typography`, all spacing from `Spacing`.

/// One panel on the Insights pages: the desktop card, redrawn for a phone —
/// raised surface, 14pt continuous corners, title row on top.
struct InsightsCard<Content: View>: View {
    let title: String
    var trailing: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .typeRowTitle()
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: Spacing.snug)
                if let trailing {
                    Text(trailing)
                        .typeMeta()
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.trailing)
                }
            }
            content()
        }
        .padding(Spacing.row)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .contain)
    }
}

/// `TOTAL COST` / `COMMITS` — the small caps eyebrow over a hero number.
struct InsightsEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .typeSectionHeading()
            .foregroundStyle(Theme.muted)
            .accessibilityHidden(true)
    }
}

/// The hero number itself: big, tight, tabular so a refresh never reflows it.
struct InsightsHeroNumber: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 44, weight: .bold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(Theme.ink)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
    }
}

/// `↑ 15% vs the previous 30 days` — the desktop delta chip, as an
/// `AttentionCapsule`: sage when down is good is not a thing here, so cost
/// and commit deltas both ride the accent recipe like the selected segment.
struct InsightsDeltaChip: View {
    let text: String
    let up: Bool

    var body: some View {
        AttentionCapsule(label: text, color: up ? Theme.amber : Theme.sage)
            .accessibilityLabel("Change versus previous period: \(text)")
    }
}

/// A 4pt share bar under a card or row: the desktop `ShareMeter`, phone-sized.
struct InsightsShareBar: View {
    var fraction: Double
    var color: Color

    var body: some View {
        GeometryReader { proxy in
            Capsule()
                .fill(Theme.ink.opacity(0.1))
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(color)
                        .frame(width: proxy.size.width * max(0.02, min(1, fraction)))
                }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

/// `● Claude` — the desktop legend dot + name, one row of the custom legend.
struct InsightsLegendDot: View {
    let color: Color
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).typeMeta().foregroundStyle(Theme.muted).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

/// Loading bones: three raised cards shimmering at reduced motion's mercy.
/// Matches the desktop `UsageSkeleton`/`ActivitySkeleton` gating — paint the
/// shape of the page before its numbers arrive.
struct InsightsSkeleton: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        VStack(spacing: Spacing.section) {
            ForEach(0..<3, id: \.self) { _ in
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .fill(Theme.raised)
                    .frame(height: 180)
            }
        }
        .opacity(reduceMotion ? 1 : (pulsing ? 0.55 : 1))
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.9).repeatForever(), value: pulsing)
        .onAppear { pulsing = true }
        .accessibilityLabel("Loading insights")
    }
}
