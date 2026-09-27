import SwiftUI

// The Router card: the desktop `RouterCostCard` table, which is eight columns
// wide, redrawn for a phone. The turn split across tiers leads as one bar,
// then each tier is a block — cost on its title row, chats and turns under
// it, the two median times and escalations in a stat strip, and the model
// mix last. Stacked blocks keep each figure in the same place from tier to
// tier, so reading down compares them the way a column did.

struct RouterCostCard: View {
    let summary: RouterCostSummary

    private var turns: Int { summary.tiers.reduce(0) { $0 + $1.turns } }
    private var anyEstimated: Bool { summary.tiers.contains(where: \.isEstimated) }

    var body: some View {
        InsightsCard(title: "Router", trailing: trailing) {
            turnSplit
            VStack(spacing: 0) {
                ForEach(summary.tiers) { tier in
                    RouterTierBlock(tier: tier)
                        .padding(.vertical, Spacing.row)
                    if tier.id != summary.tiers.last?.id {
                        HairlineDivider()
                    }
                }
            }
            Text(footnote)
                .typeMeta()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var trailing: String {
        let cost = summary.tiers.reduce(0) { $0 + $1.costUsd }
        let turnsText = "\(InsightsFormat.compact(Double(turns))) \(turns == 1 ? "turn" : "turns")"
        return "\(InsightsFormat.routerCost(cost, estimated: anyEstimated)) · \(turnsText)"
    }

    private var footnote: String {
        var text = "Medians from sending a message. Turn time leaves out waits on an approval."
        if anyEstimated { text += " ≈ Cursor turns are estimated from the transcript." }
        return text
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

private struct RouterTierBlock: View {
    let tier: RouterTierCost

    private var name: String {
        AutoTier(rawValue: tier.tier)?.shortLabel ?? tier.tier.capitalized
    }

    private var costText: String {
        tier.pricedTurns > 0 ? InsightsFormat.routerCost(tier.costUsd, estimated: tier.isEstimated) : "—"
    }

    private var perTurnText: String? {
        guard tier.pricedTurns > 0 else { return nil }
        return InsightsFormat.routerCost(
            tier.costUsd / Double(tier.pricedTurns), estimated: tier.isEstimated
        )
    }

    private var countsText: String {
        var parts = [
            "\(InsightsFormat.compact(Double(tier.chats))) \(tier.chats == 1 ? "chat" : "chats")",
            "\(InsightsFormat.compact(Double(tier.turns))) \(tier.turns == 1 ? "turn" : "turns")",
        ]
        if let perTurnText { parts.append("\(perTurnText) a turn") }
        return parts.joined(separator: " · ")
    }

    /// `Opus 5.5 ×30 · Sonnet 5 ×12 · 2 unpriced`, the desktop's mix line.
    private var mixText: String {
        var models = tier.models.map { model in
            let label = ProviderCatalog.bundled.model(provider: model.provider, modelId: model.modelId)?
                .label ?? model.modelId
            return "\(label) ×\(InsightsFormat.compact(Double(model.turns)))"
        }
        if tier.unpricedTurns > 0 {
            models.append("\(InsightsFormat.compact(Double(tier.unpricedTurns))) unpriced")
        }
        return models.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            VStack(alignment: .leading, spacing: Spacing.hair) {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                    Circle()
                        .fill(InsightsPalette.tier(tier.tier))
                        .frame(width: 8, height: 8)
                    Text(name)
                        .typeStyle(.callout, weight: .semibold, ink: Theme.ink)
                    Spacer(minLength: Spacing.snug)
                    Text(costText)
                        .typeStyle(.callout, weight: .semibold, monospacedDigit: true, ink: Theme.ink)
                        .lineLimit(1)
                }
                Text(countsText)
                    .typeMeta()
                    .monospacedDigit()
                    .padding(.leading, 16)
            }
            HStack(spacing: 0) {
                stat(InsightsFormat.seconds(tier.medianTurnSeconds), label: "Turn time")
                stat(InsightsFormat.seconds(tier.medianFirstAnswerSeconds), label: "First answer")
                stat(InsightsFormat.compact(Double(tier.escalations)), label: "Escalated")
            }
            .padding(.vertical, Spacing.snug)
            .background(Theme.ground, in: .rect(cornerRadius: Radius.control, style: .continuous))
            if !mixText.isEmpty {
                Text(mixText)
                    .typeMeta()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private func stat(_ value: String, label: String) -> some View {
        VStack(spacing: Spacing.hair) {
            Text(value)
                .typeStyle(.body, weight: .semibold, monospacedDigit: true, ink: Theme.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .typeMeta()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    private var accessibilityText: String {
        [
            "\(name) tier",
            "cost \(costText)",
            countsText,
            "median turn time \(InsightsFormat.seconds(tier.medianTurnSeconds))",
            "median first answer \(InsightsFormat.seconds(tier.medianFirstAnswerSeconds))",
            "\(tier.escalations) escalated",
            mixText,
        ]
        .filter { !$0.isEmpty }
        .joined(separator: ", ")
    }
}
