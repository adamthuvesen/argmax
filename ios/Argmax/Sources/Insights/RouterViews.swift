import SwiftUI

// The Router card: the desktop `RouterCostCard` table, nine columns wide,
// redrawn for a phone. The turn split across tiers leads as one bar, then each
// tier is a block: its name, its top models one per line, and the desktop's
// four figure families as a two-by-two grid of tiles. Each family keeps the
// Mac's hue, and a tile's tint deepens with its share of the largest figure in
// that slot across the tiers, so reading down the blocks compares them the
// way a column did.

struct RouterCostCard: View {
    let summary: RouterCostSummary

    private var turns: Int { summary.tiers.reduce(0) { $0 + $1.turns } }
    private var anyEstimated: Bool { summary.tiers.contains(where: \.isEstimated) }

    var body: some View {
        let heat = RouterFigure.heat(summary.tiers)
        InsightsCard(title: "Router", trailing: trailing) {
            turnSplit
            VStack(spacing: 0) {
                ForEach(Array(summary.tiers.enumerated()), id: \.element.id) { index, tier in
                    RouterTierBlock(tier: tier, heat: heat[index])
                        .padding(.vertical, Spacing.row)
                    if tier.id != summary.tiers.last?.id {
                        HairlineDivider()
                    }
                }
            }
        }
    }

    private var trailing: String {
        let cost = summary.tiers.reduce(0) { $0 + $1.costUsd }
        let turnsText = "\(InsightsFormat.compact(Double(turns))) \(turns == 1 ? "turn" : "turns")"
        return "\(InsightsFormat.routerCost(cost, estimated: anyEstimated)) · \(turnsText)"
    }

    /// Where the turns went: one segment per tier, the token-flow bar's shape.
    private var turnSplit: some View {
        let total = max(1, Double(turns))
        let gaps = CGFloat(max(0, summary.tiers.count - 1)) * 2
        return GeometryReader { proxy in
            HStack(spacing: 2) {
                ForEach(summary.tiers) { tier in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(InsightsPalette.tier(tier.tier))
                        .frame(width: max(3, (proxy.size.width - gaps) * Double(tier.turns) / total))
                }
            }
        }
        .frame(height: 10)
        .accessibilityHidden(true)
    }
}

/// The desktop's figure families, in its column order.
enum RouterFamily: String, CaseIterable {
    case volume = "Volume"
    case spend = "Spend"
    case tokens = "Tokens"
    case pace = "Pace"

    /// The Mac's family hues (`usage-router.css`), light and dark.
    var hue: Color {
        switch self {
        case .volume: return Color(Theme.dynamic(light: 0x7A_7F_87, dark: 0x9A_A0_A8))
        case .spend: return Color(Theme.dynamic(light: 0xB0_80_39, dark: 0xD9_A5_66))
        case .tokens: return Color(Theme.dynamic(light: 0x4F_7C_C4, dark: 0x7E_A6_E0))
        case .pace: return Color(Theme.dynamic(light: 0x3F_8F_6E, dark: 0x6C_BF_98))
        }
    }
}

/// One figure slot: its family, its label, the number behind it (nil when
/// unknown), and its text.
struct RouterFigure {
    let family: RouterFamily
    let label: String
    let value: (RouterTierCost) -> Double?
    let format: (Double, RouterTierCost) -> String

    static let all: [RouterFigure] = [
        RouterFigure(family: .volume, label: "Chats", value: { Double($0.chats) }) { value, _ in
            InsightsFormat.compact(value)
        },
        RouterFigure(family: .volume, label: "Turns", value: { Double($0.turns) }) { value, _ in
            InsightsFormat.compact(value)
        },
        // Compact, so a tier's total fits a quarter of the phone's width; the
        // tile is a comparison, and the card's title carries the exact sum.
        RouterFigure(family: .spend, label: "Cost", value: { $0.pricedTurns > 0 ? $0.costUsd : nil }) {
            ($1.isEstimated ? "≈" : "") + InsightsFormat.usdCompact($0)
        },
        RouterFigure(
            family: .spend,
            label: "Per turn",
            value: { $0.pricedTurns > 0 ? $0.costUsd / Double($0.pricedTurns) : nil }
        ) {
            InsightsFormat.routerCost($0, estimated: $1.isEstimated)
        },
        RouterFigure(family: .tokens, label: "Out / turn", value: { $0.medianTurnOutputTokens }) { value, tier in
            (tier.isEstimated ? "≈" : "") + InsightsFormat.compact(value)
        },
        RouterFigure(family: .tokens, label: "$ / 1M out", value: { $0.costPerMillionOutputTokens }) {
            ($1.isEstimated ? "≈" : "") + InsightsFormat.usdRate($0)
        },
        RouterFigure(family: .pace, label: "Turn time", value: { $0.medianTurnSeconds }) { value, _ in
            InsightsFormat.seconds(value)
        },
        RouterFigure(family: .pace, label: "Tok / s", value: { $0.outputTokensPerSecond }) { value, tier in
            value.isFinite ? (tier.isEstimated ? "≈" : "") + String(Int(value.rounded())) : "—"
        },
        RouterFigure(family: .pace, label: "Escalated", value: { Double($0.escalations) }) { value, _ in
            InsightsFormat.compact(value)
        },
    ]

    /// Each tier's figure as a share of the largest in its slot (0–1), the
    /// Mac's rule. A lone figure has nothing to be compared with and stays at
    /// 0; an unknown one is nil.
    static func heat(_ tiers: [RouterTierCost]) -> [[Double?]] {
        let columns = all.map { figure in tiers.map(figure.value) }
        return tiers.indices.map { row in
            columns.map { values in
                guard let value = values[row] else { return nil }
                let known = values.compactMap { $0 }
                guard known.count > 1, let high = known.max(), high > 0 else { return 0 }
                return value / high
            }
        }
    }
}

private struct RouterTierBlock: View {
    let tier: RouterTierCost
    /// One entry per `RouterFigure.all` slot.
    let heat: [Double?]

    /// Past this many models the list folds into "+N more", as on the Mac.
    private static let shownModels = 3

    private var name: String {
        AutoTier(rawValue: tier.tier)?.shortLabel ?? tier.tier.capitalized
    }

    private func modelLabel(_ model: RouterModelCost) -> String {
        ProviderCatalog.bundled.model(provider: model.provider, modelId: model.modelId)?.label ?? model.modelId
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.row) {
            VStack(alignment: .leading, spacing: Spacing.snug) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                    Circle()
                        .fill(InsightsPalette.tier(tier.tier))
                        .frame(width: 8, height: 8)
                    Text(name)
                        .typeStyle(.callout, weight: .semibold, ink: Theme.ink)
                    if tier.unpricedTurns > 0 {
                        Text("\(InsightsFormat.compact(Double(tier.unpricedTurns))) unpriced")
                            .typeMeta()
                    }
                }
                if !tier.models.isEmpty {
                    modelList.padding(.leading, 16)
                }
            }
            familyGrid
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    /// One model per line, shares in their own column.
    private var modelList: some View {
        let shown = tier.models.prefix(Self.shownModels)
        let folded = tier.models.count - shown.count
        return Grid(alignment: .leading, horizontalSpacing: Spacing.snug, verticalSpacing: 3) {
            ForEach(Array(shown), id: \.self) { model in
                GridRow {
                    Circle()
                        .fill(InsightsPalette.provider(model.provider))
                        .frame(width: 6, height: 6)
                    Text(modelLabel(model))
                        .typeChrome()
                        .foregroundStyle(Theme.ink.opacity(0.85))
                        .lineLimit(1)
                    Text(InsightsFormat.percent(tier.turns > 0 ? Double(model.turns) / Double(tier.turns) : nil))
                        .typeMeta()
                        .monospacedDigit()
                        .gridColumnAlignment(.trailing)
                }
            }
            if folded > 0 {
                GridRow {
                    Color.clear.frame(width: 6, height: 6)
                    Text("+\(folded) more").typeMeta()
                }
            }
        }
    }

    /// Volume and Spend over Tokens and Pace: the Mac's four families, two
    /// to a row so each tile has room for its figure.
    private var familyGrid: some View {
        Grid(alignment: .topLeading, horizontalSpacing: Spacing.row, verticalSpacing: Spacing.row) {
            GridRow {
                family(.volume)
                family(.spend)
            }
            GridRow {
                family(.tokens)
                family(.pace)
            }
        }
    }

    private func family(_ family: RouterFamily) -> some View {
        let slots = RouterFigure.all.indices.filter { RouterFigure.all[$0].family == family }
        return VStack(alignment: .leading, spacing: Spacing.tight) {
            Text(family.rawValue.uppercased())
                .typeStyle(.caption2, weight: .semibold, ink: family.hue)
                .tracking(0.6)
            HStack(spacing: Spacing.tight) {
                ForEach(slots, id: \.self) { slot in
                    RouterFigureTile(
                        figure: RouterFigure.all[slot],
                        tier: tier,
                        heat: heat.indices.contains(slot) ? heat[slot] : nil
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var accessibilityText: String {
        var parts = ["\(name) tier"]
        if tier.unpricedTurns > 0 { parts.append("\(tier.unpricedTurns) unpriced") }
        for figure in RouterFigure.all {
            let text = figure.value(tier).map { figure.format($0, tier) } ?? "unknown"
            parts.append("\(figure.family.rawValue) \(figure.label) \(text)")
        }
        parts.append(
            tier.models.map { "\(modelLabel($0)) ×\(InsightsFormat.compact(Double($0.turns)))" }
                .joined(separator: " · ")
        )
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// One figure on a tile of its family's hue. The tint deepens with `heat`;
/// the numbers keep the page's ink, and a zero drops to muted.
private struct RouterFigureTile: View {
    let figure: RouterFigure
    let tier: RouterTierCost
    let heat: Double?

    @Environment(\.colorScheme) private var colorScheme

    private var tint: Double {
        guard let heat else { return 0 }
        let (base, span) = colorScheme == .dark ? (0.12, 0.26) : (0.08, 0.22)
        return base + heat * span
    }

    var body: some View {
        let value = figure.value(tier)
        VStack(alignment: .leading, spacing: 1) {
            Text(value.map { figure.format($0, tier) } ?? "—")
                .typeStyle(
                    .subheadline,
                    weight: .semibold,
                    monospacedDigit: true,
                    ink: value == nil || value == 0 ? Theme.muted : Theme.ink
                )
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(figure.label)
                .typeStyle(.caption2, ink: Theme.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 7)
        .padding(.horizontal, Spacing.snug)
        .background(
            figure.family.hue.opacity(tint),
            in: .rect(cornerRadius: 8, style: .continuous)
        )
    }
}
