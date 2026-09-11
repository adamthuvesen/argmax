import Charts
import SwiftUI

// The Usage page: hero totals, provider cards, daily cost chart, token flow,
// and model breakdown — the desktop `UsagePanel` sections, stacked for a
// phone. All narrowing is client-side in `InsightsStore`; the cards always
// read the global summary.

// MARK: - Hero

struct UsageHero: View {
    let summary: UsageSummary
    let mode: InsightsStore.UsageMode
    let windowLabel: String

    private var useTokens: Bool { mode == .tokens }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            InsightsEyebrow(text: useTokens ? "Total tokens" : "Total cost")
            InsightsHeroNumber(
                text: useTokens
                    ? InsightsFormat.compact(summary.tokens.processed)
                    : InsightsFormat.usdFull(summary.costUsd)
            )
            .accessibilityLabel(
                useTokens
                    ? "\(InsightsFormat.compact(summary.tokens.processed)) tokens"
                    : "\(InsightsFormat.usdFull(summary.costUsd)) total cost"
            )
            HStack(spacing: Spacing.snug) {
                if let delta = InsightsFormat.delta(
                    current: useTokens
                        ? summary.tokens.processed : summary.costUsd,
                    previous: useTokens
                        ? summary.previous?.tokens.processed : summary.previous?.costUsd,
                    windowLabel: windowLabel
                ) {
                    InsightsDeltaChip(text: delta, up: delta.hasPrefix("↑"))
                }
                Text("\(InsightsFormat.compact(Double(summary.sessions))) sessions")
                    .typeMeta().foregroundStyle(Theme.muted)
            }
            let stats = dailyStats
            Text(stats)
                .typeMeta().foregroundStyle(Theme.muted)
            if summary.costSource == "mixed" || summary.costSource == "list_price" {
                Text("Part reported, part list price\(pricingSuffix)")
                    .typeMeta().foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
    }

    private var pricingSuffix: String {
        summary.pricingAsOf.map { " · prices as of \($0)" } ?? ""
    }

    private var dailyStats: String {
        guard !summary.days.isEmpty else { return "" }
        let values = summary.days.map { useTokens ? $0.tokens.processed : $0.costUsd }
        let average = values.reduce(0, +) / Double(values.count)
        let peak = summary.days.max {
            (useTokens ? $0.tokens.processed : $0.costUsd)
                < (useTokens ? $1.tokens.processed : $1.costUsd)
        }
        let averageText = useTokens
            ? InsightsFormat.compact(average) : InsightsFormat.usdCompact(average)
        guard let peak, let date = InsightsFormat.parse(peak.bucketStart) else {
            return "\(averageText) a day"
        }
        let day = DateFormatter.cachedDay.string(from: date)
        let peakValue = useTokens
            ? InsightsFormat.compact(peak.tokens.processed)
            : InsightsFormat.usdCompact(peak.costUsd)
        return "\(averageText) a day · busiest \(day), \(peakValue)"
    }
}

// MARK: - Provider cards

struct UsageProviderCards: View {
    @ObservedObject var store: InsightsStore

    private var total: Double {
        guard let summary = store.usage else { return 0 }
        return store.usageMode == .tokens
            ? summary.tokens.processed : summary.costUsd
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            Text("By provider")
                .typeSectionHeading().foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.snug) {
                    ForEach(store.usage?.providers ?? []) { provider in
                        card(provider)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
        }
    }

    private func card(_ provider: UsageProviderSummary) -> some View {
        let chosen = store.providerFilter == provider.provider
        let value = store.usageMode == .tokens
            ? provider.tokens.processed : provider.costUsd
        let share = total > 0 ? value / total : 0
        return Button {
            Haptics.light()
            withAnimation(.easeOut(duration: 0.2)) {
                store.providerFilter = chosen ? nil : provider.provider
            }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Circle()
                        .fill(InsightsPalette.provider(provider.provider))
                        .frame(width: 8, height: 8)
                    Text(ProviderMark.displayName(provider.provider))
                        .typeContent().foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(InsightsFormat.percent(share))
                        .typeMeta().foregroundStyle(Theme.muted).monospacedDigit()
                }
                Text(
                    store.usageMode == .tokens
                        ? InsightsFormat.compact(value) : InsightsFormat.usdFull(value)
                )
                .font(.title3.weight(.bold)).monospacedDigit()
                .foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.7)
                if provider.available {
                    Text(
                        "\(InsightsFormat.compact(Double(provider.sessions))) sessions · \(InsightsFormat.compact(provider.tokens.processed)) tokens"
                    )
                    .typeMeta().foregroundStyle(Theme.muted).lineLimit(1)
                } else {
                    Text("No local usage data").typeMeta().foregroundStyle(Theme.muted)
                }
                InsightsShareBar(
                    fraction: share, color: InsightsPalette.provider(provider.provider)
                )
            }
            .padding(Spacing.row)
            .frame(width: 220, alignment: .leading)
            .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
                    .stroke(chosen ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color.clear), lineWidth: 2)
            }
        }
        .buttonStyle(PressDim())
        .accessibilityLabel(
            "\(ProviderMark.displayName(provider.provider)), \(InsightsFormat.percent(share)) of spend"
        )
        .accessibilityAddTraits(chosen ? [.isSelected] : [])
    }
}

// MARK: - Daily chart

struct UsageDailyChart: View {
    @ObservedObject var store: InsightsStore

    private struct Bucket: Identifiable {
        let id: String
        let date: Date
        let provider: String
        let value: Double
    }

    /// Dense: every provider has a value on every day. A stacked area with
    /// days missing interpolates across the gap and draws stray curves.
    private var buckets: [Bucket] {
        let points = store.usageSeries()
        let useTokens = store.usageMode == .tokens
        let providers = Array(Set(points.flatMap { $0.values.map(\.provider) })).sorted()
        return points.flatMap { point -> [Bucket] in
            guard let date = InsightsFormat.parse(point.bucketStart) else { return [] }
            let byProvider = Dictionary(
                point.values.map { ($0.provider, useTokens ? $0.tokens : $0.costUsd) },
                uniquingKeysWith: +
            )
            return providers.map { provider in
                Bucket(
                    id: "\(point.bucketStart)-\(provider)",
                    date: date,
                    provider: provider,
                    value: byProvider[provider] ?? 0
                )
            }
        }
    }

    var body: some View {
        // Derived once per render rather than once per read below.
        let buckets = buckets
        let providers = Array(Set(buckets.map(\.provider))).sorted()
        InsightsCard(
            title: store.usageMode == .tokens ? "Daily tokens" : "Daily cost",
            trailing: legendTrailing
        ) {
            if buckets.isEmpty {
                EmptyState(message: "No usage in this window yet.")
            } else {
                Chart(buckets) { bucket in
                    AreaMark(
                        x: .value("Day", bucket.date, unit: .day),
                        y: .value("Value", bucket.value),
                        series: .value("Provider", bucket.provider)
                    )
                    .foregroundStyle(InsightsPalette.provider(bucket.provider).opacity(0.28))
                    .interpolationMethod(.monotone)
                    LineMark(
                        x: .value("Day", bucket.date, unit: .day),
                        y: .value("Value", bucket.value),
                        series: .value("Provider", bucket.provider)
                    )
                    .foregroundStyle(InsightsPalette.provider(bucket.provider))
                    .lineStyle(.init(lineWidth: 1.5))
                    .interpolationMethod(.monotone)
                }
                .chartLegend(.hidden)
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, count: max(1, daySpan / 4))) { value in
                        if let date = value.as(Date.self) {
                            AxisValueLabel {
                                Text(DateFormatter.cachedAxis.string(from: date))
                                    .font(.caption2).foregroundStyle(Theme.muted)
                            }
                        }
                        AxisGridLine(stroke: .init(lineWidth: 0.5))
                            .foregroundStyle(Theme.line.opacity(0.5))
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading) { value in
                        if let number = value.as(Double.self) {
                            AxisValueLabel {
                                Text(
                                    store.usageMode == .tokens
                                        ? InsightsFormat.compact(number)
                                        : InsightsFormat.usdCompact(number)
                                )
                                .font(.caption2).foregroundStyle(Theme.muted)
                            }
                        }
                        AxisGridLine(stroke: .init(lineWidth: 0.5))
                            .foregroundStyle(Theme.line.opacity(0.5))
                    }
                }
                .frame(height: 190)
                .accessibilityLabel(dailyAccessibility)
                legend(providers: providers)
            }
        }
    }

    private var daySpan: Int {
        max(1, store.usageSeries().count)
    }

    private var legendTrailing: String? {
        guard let summary = store.usage else { return nil }
        return "\(InsightsFormat.compact(Double(summary.sessions))) sessions"
    }

    private func legend(providers: [String]) -> some View {
        let shown = providers.prefix(3)
        let rest = max(0, providers.count - shown.count)
        return HStack(spacing: Spacing.snug) {
            ForEach(Array(shown), id: \.self) { provider in
                InsightsLegendDot(
                    color: InsightsPalette.provider(provider),
                    label: ProviderMark.displayName(provider)
                )
            }
            if rest > 0 {
                InsightsLegendDot(color: Theme.muted, label: "\(rest) others")
            }
            Spacer(minLength: 0)
        }
    }

    private var dailyAccessibility: String {
        guard let summary = store.usage else { return "Daily usage chart" }
        let total = store.usageMode == .tokens
            ? "\(InsightsFormat.compact(summary.tokens.processed)) tokens"
            : InsightsFormat.usdFull(summary.costUsd)
        return "Daily \(store.usageMode == .tokens ? "tokens" : "cost"), \(total) total."
    }
}

// MARK: - Token flow

struct UsageTokenFlow: View {
    let summary: UsageSummary

    private var segments: [(label: String, detail: String?, value: Double, color: Color)] {
        let tokens = summary.tokens
        return [
            ("Cache read", nil, tokens.cacheRead, Theme.sage.opacity(0.45)),
            ("Cache written", nil, tokens.cacheWrite, Theme.sage.opacity(0.7)),
            ("Uncached input", "at the full input rate", tokens.inputUncached, Theme.sage),
            (
                "Output",
                summary.tokens.reasoning > 0
                    ? "\(InsightsFormat.compact(summary.tokens.reasoning)) of it reasoning" : nil,
                tokens.output, Color.accentColor
            ),
        ]
    }

    var body: some View {
        InsightsCard(
            title: "Where the tokens went",
            trailing: "\(InsightsFormat.compact(summary.tokens.processed)) processed"
        ) {
            let total = max(1, summary.tokens.processed)
            GeometryReader { proxy in
                HStack(spacing: 2) {
                    ForEach(segments, id: \.label) { segment in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(segment.color)
                            .frame(width: max(3, proxy.size.width * segment.value / total))
                    }
                }
            }
            .frame(height: 10)
            .accessibilityHidden(true)
            VStack(spacing: 0) {
                ForEach(segments, id: \.label) { segment in
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                        Circle().fill(segment.color).frame(width: 8, height: 8)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(segment.label).typeContent().foregroundStyle(Theme.ink)
                            if let detail = segment.detail {
                                Text(detail).typeMeta().foregroundStyle(Theme.muted)
                            }
                        }
                        Spacer()
                        Text(InsightsFormat.compact(segment.value))
                            .typeContent().monospacedDigit().foregroundStyle(Theme.ink)
                        Text(InsightsFormat.percent(segment.value / total))
                            .typeMeta().monospacedDigit().foregroundStyle(Theme.muted)
                            .frame(minWidth: 52, alignment: .trailing)
                    }
                    .padding(.vertical, Spacing.snug)
                    Divider().background(Theme.line).padding(.leading, 20)
                }
            }
            if summary.cacheSavingsUsd > 0 {
                HStack(alignment: .firstTextBaseline) {
                    Text("Cache savings").typeMeta().foregroundStyle(Theme.muted)
                    Spacer()
                    Text(InsightsFormat.usdFull(summary.cacheSavingsUsd))
                        .font(.title3.weight(.bold)).monospacedDigit()
                        .foregroundStyle(Theme.sage)
                }
                .padding(.top, Spacing.snug)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(
                    "Cache savings \(InsightsFormat.usdFull(summary.cacheSavingsUsd))"
                )
            }
        }
    }
}

// MARK: - Breakdown

struct UsageBreakdown: View {
    @ObservedObject var store: InsightsStore
    @State private var scope: Scope = .model

    enum Scope: String, Hashable, Identifiable, CaseIterable {
        case model, day
        var id: String { rawValue }
        var label: String { self == .model ? "Model" : "Day" }
    }

    var body: some View {
        InsightsCard(title: "Breakdown", trailing: breakdownTrailing) {
            Segmented(options: Scope.allCases, selection: $scope, label: \.label)
                .background(Theme.ground, in: .rect(cornerRadius: Radius.control, style: .continuous))
            if scope == .model {
                modelRows
            } else {
                dayRows
            }
        }
    }

    private var breakdownTrailing: String? {
        guard let summary = store.usage else { return nil }
        return "Top \(min(12, summary.models.count)) of \(summary.models.count) models"
    }

    private var modelRows: some View {
        let rows = Array(store.usageModels().prefix(12))
        let peak = rows.map(\.costUsd).max() ?? 1
        return VStack(spacing: 0) {
            ForEach(rows, id: \.modelId) { row in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                        Circle()
                            .fill(InsightsPalette.provider(row.provider))
                            .frame(width: 7, height: 7)
                        Text(row.modelId)
                            .font(.argmaxMono(.callout)).foregroundStyle(Theme.ink)
                            .lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        Text(
                            store.usageMode == .tokens
                                ? InsightsFormat.compact(row.tokens.processed)
                                : InsightsFormat.usdFull(row.costUsd)
                        )
                        .typeContent().monospacedDigit().foregroundStyle(Theme.ink)
                    }
                    HStack(spacing: Spacing.snug) {
                        Text(
                            "\(ProviderMark.displayName(row.provider)) · \(InsightsFormat.compact(Double(row.sessions))) sessions"
                        )
                        .typeMeta().foregroundStyle(Theme.muted).lineLimit(1)
                        Spacer(minLength: 4)
                        InsightsShareBar(
                            fraction: row.costUsd / max(peak, 0.01),
                            color: InsightsPalette.provider(row.provider)
                        )
                        .frame(width: 72)
                    }
                }
                .padding(.vertical, Spacing.snug)
                if row.modelId != rows.last?.modelId {
                    HairlineDivider()
                }
            }
        }
    }

    private var dayRows: some View {
        let days = store.usage?.days.suffix(14).reversed() ?? []
        return VStack(spacing: 0) {
            ForEach(Array(days), id: \.bucketStart) { day in
                HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                    Text(InsightsFormat.shortDay(day.bucketStart))
                        .typeContent().foregroundStyle(Theme.ink)
                        .frame(minWidth: 56, alignment: .leading)
                    Text("\(InsightsFormat.compact(Double(day.sessions))) sessions")
                        .typeMeta().foregroundStyle(Theme.muted)
                    Spacer()
                    Text(
                        store.usageMode == .tokens
                            ? InsightsFormat.compact(day.tokens.processed)
                            : InsightsFormat.usdFull(day.costUsd)
                    )
                    .typeContent().monospacedDigit().foregroundStyle(Theme.ink)
                }
                .padding(.vertical, Spacing.snug)
                if day.bucketStart != days.last?.bucketStart {
                    HairlineDivider()
                }
            }
        }
    }
}

// MARK: - Date helpers

extension DateFormatter {
    static let cachedDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()

    static let cachedAxis: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter
    }()
}
