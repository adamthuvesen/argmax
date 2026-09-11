import Charts
import SwiftUI

// The Activity page: hero totals, contribution heatmap, daily commits,
// repositories, pull requests, reviews, and cadence — the desktop
// `ActivityPanel` sections, stacked for a phone. The heatmap and repository
// shares always read the global summary; the chart, PRs, and reviews narrow
// to the selected project.

// MARK: - Hero

struct ActivityHero: View {
    let summary: ActivitySummary
    let mode: InsightsStore.ActivityMode
    let windowLabel: String

    private var useLines: Bool { mode == .lines }
    private var totals: ActivityTotals { summary.totals }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.snug) {
            InsightsEyebrow(text: useLines ? "Lines changed" : "Commits")
            InsightsHeroNumber(
                text: useLines
                    ? InsightsFormat.compact(
                        Double(totals.linesAdded + totals.linesRemoved)
                    )
                    : InsightsFormat.compact(Double(totals.commits))
            )
            .accessibilityLabel(
                useLines
                    ? "\(totals.linesAdded + totals.linesRemoved) lines changed"
                    : "\(totals.commits) commits"
            )
            Text("across \(InsightsFormat.compact(Double(totals.filesChanged))) file changes")
                .typeContent().foregroundStyle(Theme.muted)
            HStack(spacing: Spacing.snug) {
                if let delta = InsightsFormat.delta(
                    current: useLines
                        ? Double(totals.linesAdded + totals.linesRemoved)
                        : Double(totals.commits),
                    previous: summary.previous.map {
                        useLines
                            ? Double($0.linesAdded + $0.linesRemoved) : Double($0.commits)
                    },
                    windowLabel: windowLabel
                ) {
                    InsightsDeltaChip(text: delta, up: delta.hasPrefix("↑"))
                }
            }
            statRow("PRs merged", "\(totals.prsMerged)")
            statRow("Reviews given", "\(totals.reviewsGiven)")
            statRow("Active days", "\(totals.activeDays)")
            if let median = summary.medianCycleSeconds {
                statRow("Median cycle", InsightsFormat.cycle(median))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
    }

    private func statRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).typeMeta().foregroundStyle(Theme.muted)
            Spacer()
            Text(value).typeContent().monospacedDigit().foregroundStyle(Theme.ink)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Heatmap

struct ActivityHeatmap: View {
    let summary: ActivitySummary

    private struct Cell: Hashable {
        let date: Date?
        let commits: Int
    }

    /// Mon-first week columns covering the whole heatmap window, and the
    /// month label each column opens with (empty when the previous column
    /// already named that month). Both are derived once per summary here:
    /// as computed properties they were rebuilt — 365 date parses each —
    /// three times for every one of the ~53 columns, and that pass was the
    /// freeze on entering the Activity tab.
    private let weeks: [[Cell]]
    private let monthLabels: [String]

    init(summary: ActivitySummary) {
        self.summary = summary
        let days = summary.heatmap.compactMap { day -> (Date, Int)? in
            guard let date = InsightsFormat.parse(day.date) else { return nil }
            return (date, day.commits)
        }.sorted { $0.0 < $1.0 }
        guard let first = days.first?.0 else {
            weeks = []
            monthLabels = []
            return
        }
        let calendar = Calendar.current
        // Monday-first offset for the leading pad.
        let weekday = calendar.component(.weekday, from: first) // 1 = Sunday
        let leading = (weekday + 5) % 7
        var cells: [Cell] = Array(repeating: Cell(date: nil, commits: -1), count: leading)
        cells += days.map { Cell(date: $0.0, commits: $0.1) }
        while cells.count % 7 != 0 { cells.append(Cell(date: nil, commits: -1)) }
        let columns = stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<$0 + 7]) }
        weeks = columns
        var previousMonth: Int?
        monthLabels = columns.map { week in
            guard let date = week.compactMap(\.date).first else { return "" }
            let month = calendar.component(.month, from: date)
            defer { previousMonth = month }
            if month == previousMonth { return "" }
            return DateFormatter.cachedMonth.string(from: date)
        }
    }

    var body: some View {
        InsightsCard(
            title: "Contributions",
            trailing: "the last 365 days, every repository"
        ) {
            if weeks.isEmpty {
                EmptyState(message: "No commits in this window yet.")
            } else {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 10) {
                            weekdayGutter
                            ForEach(Array(weeks.enumerated()), id: \.offset) { index, week in
                                VStack(spacing: 3) {
                                    monthLabel(for: index)
                                    ForEach(Array(week.enumerated()), id: \.offset) { _, cell in
                                        if cell.commits < 0 {
                                            Color.clear.frame(width: 11, height: 11)
                                        } else {
                                            RoundedRectangle(cornerRadius: 3)
                                                .fill(InsightsPalette.heat(cell.commits))
                                                .frame(width: 11, height: 11)
                                        }
                                    }
                                }
                                .id(index)
                            }
                        }
                    }
                    .onAppear {
                        // Land on the present: the story is the trailing edge.
                        proxy.scrollTo(weeks.count - 1, anchor: .trailing)
                    }
                }
                HStack {
                    Spacer(minLength: 0)
                    Text("Less").typeMeta().foregroundStyle(Theme.muted)
                    ForEach(0..<5) { level in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(InsightsPalette.heat([0, 1, 4, 8, 20][level]))
                            .frame(width: 10, height: 10)
                    }
                    Text("More").typeMeta().foregroundStyle(Theme.muted)
                }
                streakLine
            }
        }
    }

    private var weekdayGutter: some View {
        VStack(spacing: 3) {
            Text("").font(.caption2).frame(height: 14)
            ForEach(Array(["Mon", "", "Wed", "", "Fri", "", ""].enumerated()), id: \.offset) { _, day in
                Text(day).font(.caption2).foregroundStyle(Theme.muted)
                    .frame(width: 26, height: 11, alignment: .leading)
            }
        }
    }

    private func monthLabel(for index: Int) -> some View {
        Text(monthLabels[index]).font(.caption2).foregroundStyle(Theme.muted)
            .frame(height: 14, alignment: .leading)
    }

    private var streakLine: some View {
        let streaks = summary.streaks
        var parts: [String] = []
        if streaks.currentDays > 0 { parts.append("\(streaks.currentDays) days running") }
        if streaks.longestDays > 0 { parts.append("longest \(streaks.longestDays)") }
        if let busiest = streaks.busiestDay {
            parts.append(
                "busiest \(InsightsFormat.shortDay(busiest.date)), \(busiest.commits) commits"
            )
        }
        return Text(parts.joined(separator: " · "))
            .typeMeta().foregroundStyle(Theme.muted)
            .accessibilityLabel(parts.joined(separator: ", "))
    }
}

// MARK: - Daily commits chart

struct ActivityDailyChart: View {
    @ObservedObject var store: InsightsStore

    /// Named repositories get their own band; the rest pool into one tail,
    /// as on the desktop (`ACTIVITY_SERIES_SLOTS`): thirty stacked bands in
    /// five colours say nothing about which is which.
    private static let namedSlots = 5
    private static let tailKey = "__others__"

    private struct Bucket: Identifiable {
        let id: String
        let date: Date
        let repo: String
        let value: Double
    }

    private struct Series {
        /// Band order, top of the leaderboard first; the tail is last.
        let repos: [String]
        /// Leaderboard position per band, the same rank the Repositories
        /// card colours its rows by.
        let ranks: [String: Int]
        let othersCount: Int
        /// Dense: every band has a value on every day. A stacked area with
        /// days missing interpolates across the gap, and that was the
        /// tangle of stray curves on the phone.
        let buckets: [Bucket]
    }

    private var series: Series {
        let points = store.activitySeries()
        let useLines = store.activityMode == .lines
        let ranked = (store.activity?.repositories ?? []).filter {
            store.projectFilter == nil || $0.projectId == store.projectFilter
        }
        let named = Array(ranked.prefix(Self.namedSlots))
        let names = Dictionary(uniqueKeysWithValues: named.map { ($0.projectId, $0.name) })
        var totals: [String: Double] = [:]
        var tailProjects: Set<String> = []
        var buckets: [Bucket] = []
        for point in points {
            guard let date = InsightsFormat.parse(point.bucketStart) else { continue }
            var byRepo: [String: Double] = [:]
            for slice in point.byRepository {
                let value = useLines
                    ? Double(slice.linesAdded + slice.linesRemoved) : Double(slice.commits)
                guard value > 0 else { continue }
                if let name = names[slice.projectId] {
                    byRepo[name, default: 0] += value
                } else {
                    byRepo[Self.tailKey, default: 0] += value
                    tailProjects.insert(slice.projectId)
                }
            }
            for name in named.map(\.name) + [Self.tailKey] {
                let value = byRepo[name] ?? 0
                totals[name, default: 0] += value
                buckets.append(Bucket(
                    id: "\(point.bucketStart)-\(name)", date: date, repo: name, value: value
                ))
            }
        }
        // Bands that never moved in this window are dropped rather than drawn
        // as a flat zero line.
        var repos = named.map(\.name).filter { totals[$0, default: 0] > 0 }
        if tailProjects.isEmpty {
            buckets.removeAll { $0.repo == Self.tailKey }
        } else {
            repos.append(Self.tailKey)
        }
        let live = Set(repos)
        return Series(
            repos: repos,
            ranks: Dictionary(uniqueKeysWithValues: named.enumerated().map { ($1.name, $0) }),
            othersCount: tailProjects.count,
            buckets: buckets.filter { live.contains($0.repo) }
        )
    }

    var body: some View {
        // Derived once per render: reading it from inside the mark builder
        // would rebuild every bucket for every mark.
        let series = series
        InsightsCard(
            title: store.activityMode == .lines ? "Daily lines" : "Daily commits",
            trailing: nil
        ) {
            if series.buckets.isEmpty {
                EmptyState(message: "No commits in this window yet.")
            } else {
                Chart(series.buckets) { bucket in
                    AreaMark(
                        x: .value("Day", bucket.date, unit: .day),
                        y: .value("Value", bucket.value),
                        series: .value("Repository", bucket.repo),
                        stacking: .standard
                    )
                    .foregroundStyle(color(bucket.repo, in: series).opacity(0.7))
                    .interpolationMethod(.monotone)
                }
                .chartLegend(.hidden)
                .chartXAxis {
                    AxisMarks(values: .stride(by: .day, count: max(1, daySpan / 3))) { value in
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
                                Text(InsightsFormat.compact(number))
                                    .font(.caption2).foregroundStyle(Theme.muted)
                            }
                        }
                        AxisGridLine(stroke: .init(lineWidth: 0.5))
                            .foregroundStyle(Theme.line.opacity(0.5))
                    }
                }
                .frame(height: 190)
                .accessibilityLabel(
                    "Daily \(store.activityMode == .lines ? "lines changed" : "commits") by repository."
                )
                legend(series)
            }
        }
    }

    private var daySpan: Int { max(1, store.activitySeries().count) }

    /// Rank colour by band order, so the legend and the chart agree; the
    /// pooled tail is always muted.
    private func color(_ repo: String, in series: Series) -> Color {
        guard repo != Self.tailKey, let rank = series.ranks[repo] else {
            return Theme.muted
        }
        return InsightsPalette.repo(rank: rank)
    }

    private func legend(_ series: Series) -> some View {
        HStack(spacing: Spacing.snug) {
            ForEach(series.repos, id: \.self) { repo in
                if repo == Self.tailKey {
                    InsightsLegendDot(
                        color: Theme.muted,
                        label: "\(series.othersCount) other\(series.othersCount == 1 ? "" : "s")"
                    )
                } else {
                    InsightsLegendDot(color: color(repo, in: series), label: repo)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Repositories

struct ActivityRepositories: View {
    @ObservedObject var store: InsightsStore

    private var useLines: Bool { store.activityMode == .lines }

    var body: some View {
        let repos = store.activity?.repositories ?? []
        let top = Array(repos.prefix(8))
        let maxValue = max(
            1,
            top.map { useLines ? $0.linesAdded + $0.linesRemoved : $0.commits }.max() ?? 1
        )
        return InsightsCard(
            title: "Repositories",
            trailing: repos.isEmpty
                ? nil : "\(repos.count) with commits · top \(top.count) shown"
        ) {
            if repos.isEmpty {
                EmptyState(message: "No repositories with commits in this window.")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(top.enumerated()), id: \.element.id) { rank, repo in
                        row(repo, rank: rank, max: maxValue)
                        if rank < top.count - 1 { HairlineDivider() }
                    }
                }
            }
        }
    }

    private func row(_ repo: ActivityRepository, rank: Int, max: Int) -> some View {
        let color = InsightsPalette.repo(rank: rank)
        let total = useLines ? repo.linesAdded + repo.linesRemoved : repo.commits
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Spacing.snug) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(repo.name).typeContent().foregroundStyle(Theme.ink)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Text(InsightsFormat.compact(Double(total)))
                    .typeContent().monospacedDigit().foregroundStyle(Theme.ink)
            }
            HStack(spacing: Spacing.snug) {
                InsightsShareBar(
                    fraction: Double(useLines ? total : repo.commits) / Double(max),
                    color: color
                )
                sparkline(repo.projectId, color: color)
                    .frame(width: 64, height: 22)
            }
            HStack(spacing: Spacing.snug) {
                Text("+\(InsightsFormat.compact(Double(repo.linesAdded)))")
                    .foregroundStyle(Theme.sage)
                Text("−\(InsightsFormat.compact(Double(repo.linesRemoved)))")
                    .foregroundStyle(Theme.rose)
                Spacer(minLength: 4)
                Text(InsightsFormat.relative(repo.lastCommitAt))
                    .foregroundStyle(Theme.muted)
            }
            .font(.caption).monospacedDigit()
        }
        .padding(.vertical, Spacing.snug)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(repo.name), \(total) \(useLines ? "lines" : "commits")"
        )
    }

    private func sparkline(_ projectId: String, color: Color) -> some View {
        let useLines = useLines
        let points: [IndexedValue] = (store.activity?.series ?? []).compactMap { point in
            point.byRepository.first { $0.projectId == projectId }.map {
                useLines ? Double($0.linesAdded + $0.linesRemoved) : Double($0.commits)
            }
        }.enumerated().map { IndexedValue(index: $0.offset, value: $0.element) }
        return Chart(points) { point in
            AreaMark(
                x: .value("Bucket", point.index),
                y: .value("Value", point.value)
            )
            .foregroundStyle(color.opacity(0.25))
            .interpolationMethod(.monotone)
            LineMark(
                x: .value("Bucket", point.index),
                y: .value("Value", point.value)
            )
            .foregroundStyle(color)
            .lineStyle(.init(lineWidth: 1))
            .interpolationMethod(.monotone)
        }
        .chartLegend(.hidden)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .accessibilityHidden(true)
    }
}

// MARK: - Small chart helper

/// One indexed sample for the sparklines and cadence bars below. A named
/// point rather than an enumerated tuple: `Chart`'s content builder reads
/// one element at a time, and a tuple never says which half is which.
struct IndexedValue: Identifiable {
    let index: Int
    let value: Double
    var id: Int { index }
}

// MARK: - Pull requests + reviews

struct ActivityPullRequests: View {
    @ObservedObject var store: InsightsStore

    var body: some View {
        let totals = store.activity?.totals
        let prs = Array(store.activityPRs().prefix(10))
        InsightsCard(
            title: "Pull requests",
            trailing: totals.map {
                "\($0.prsMerged) merged · \($0.prsOpened - $0.prsMerged - $0.prsClosed) open · \($0.prsClosed) closed"
            }
        ) {
            if prs.isEmpty {
                EmptyState(message: "No pull requests in this window.")
            } else {
                VStack(spacing: 0) {
                    ForEach(prs, id: \.url) { pr in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: Spacing.tight) {
                                Circle().fill(prColor(pr.state)).frame(width: 7, height: 7)
                                Text(pr.title).typeContent().foregroundStyle(Theme.ink)
                                    .lineLimit(1).truncationMode(.tail)
                            }
                            HStack(spacing: Spacing.snug) {
                                Text(pr.repository).typeMeta().foregroundStyle(Theme.muted)
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Text(dateRange(pr)).typeMeta().foregroundStyle(Theme.muted)
                                Text(InsightsFormat.cycle(pr.cycleSeconds))
                                    .typeMeta().monospacedDigit()
                                    .foregroundStyle(Theme.ink)
                                Text("+\(InsightsFormat.compact(Double(pr.additions)))")
                                    .typeMeta().monospacedDigit()
                                    .foregroundStyle(Theme.sage)
                                Text("−\(InsightsFormat.compact(Double(pr.deletions)))")
                                    .typeMeta().monospacedDigit()
                                    .foregroundStyle(Theme.rose)
                            }
                        }
                        .padding(.vertical, Spacing.snug)
                        if pr.url != prs.last?.url { HairlineDivider() }
                    }
                }
                Text("Cycle time is opened → merged, over pull requests you authored.")
                    .typeMeta().foregroundStyle(Theme.muted)
                    .padding(.top, Spacing.snug)
            }
        }
    }

    private func prColor(_ state: String) -> Color {
        switch state {
        case "merged": Theme.violet
        case "open": Theme.sage
        default: Theme.muted
        }
    }

    private func dateRange(_ pr: ActivityPullRequest) -> String {
        "\(InsightsFormat.shortDay(pr.createdAt)) → \(InsightsFormat.shortDay(pr.mergedAt ?? pr.closedAt ?? pr.createdAt))"
    }
}

struct ActivityReviews: View {
    @ObservedObject var store: InsightsStore

    var body: some View {
        let totals = store.activity?.totals ?? ActivityTotals()
        let reviews = Array(store.activityReviews().prefix(6))
        let total = max(1, totals.reviewsGiven)
        InsightsCard(title: "Reviews given", trailing: nil) {
            HStack(alignment: .firstTextBaseline, spacing: Spacing.snug) {
                Text("\(totals.reviewsGiven)")
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .monospacedDigit().foregroundStyle(Theme.ink)
                Text("reviews on \(uniquePRs) pull requests")
                    .typeMeta().foregroundStyle(Theme.muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                "\(totals.reviewsGiven) reviews on \(uniquePRs) pull requests"
            )
            GeometryReader { proxy in
                HStack(spacing: 2) {
                    Capsule().fill(Theme.sage)
                        .frame(width: proxy.size.width * CGFloat(totals.reviewApprovals) / CGFloat(total))
                    Capsule().fill(Theme.amber)
                        .frame(width: max(
                            totals.reviewChangesRequested > 0 ? 3 : 0,
                            proxy.size.width * CGFloat(totals.reviewChangesRequested) / CGFloat(total)
                        ))
                    Capsule().fill(Theme.ink.opacity(0.25))
                        .frame(width: proxy.size.width * CGFloat(totals.reviewComments) / CGFloat(total))
                }
            }
            .frame(height: 8)
            .accessibilityHidden(true)
            HStack(spacing: Spacing.row) {
                reviewSplit(Theme.sage, "\(totals.reviewApprovals) approved")
                reviewSplit(Theme.amber, "\(totals.reviewChangesRequested) changes requested")
                reviewSplit(Theme.muted, "\(totals.reviewComments) commented")
            }
            if !reviews.isEmpty {
                HairlineDivider().padding(.vertical, Spacing.tight)
                VStack(spacing: 0) {
                    ForEach(reviews, id: \.url) { review in
                        HStack(spacing: Spacing.snug) {
                            Circle()
                                .fill(review.state == "commented" ? Theme.muted : Theme.sage)
                                .frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(review.title).typeContent().foregroundStyle(Theme.ink)
                                    .lineLimit(1).truncationMode(.tail)
                                Text("\(review.repository) #\(review.number)")
                                    .typeMeta().foregroundStyle(Theme.muted).lineLimit(1)
                            }
                            Spacer(minLength: 4)
                            Text(InsightsFormat.shortDay(review.submittedAt))
                                .typeMeta().foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, Spacing.tight)
                    }
                }
            }
        }
    }

    private var uniquePRs: Int {
        Set(store.activityReviews().map(\.url)).count
    }

    private func reviewSplit(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).typeMeta().foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

// MARK: - Cadence

struct ActivityCadenceCard: View {
    let summary: ActivitySummary

    private var weekday: [Int] {
        padded(summary.cadence.byWeekday, to: 7)
    }

    private var hours: [Int] {
        padded(summary.cadence.byHour, to: 24)
    }

    var body: some View {
        InsightsCard(
            title: "Cadence",
            trailing: "when the \(InsightsFormat.compact(Double(summary.totals.commits))) commits landed · local time"
        ) {
            Text("By weekday").typeContent().foregroundStyle(Theme.ink)
            weekdayChart
            Text("By hour of day").typeContent().foregroundStyle(Theme.ink)
                .padding(.top, Spacing.snug)
            hourChart
            if let line = summaryLine {
                Text(line).typeContent().foregroundStyle(Theme.muted)
                    .padding(.top, Spacing.snug)
            }
        }
    }

    private var weekdayChart: some View {
        let points = weekday.enumerated().map {
            IndexedValue(index: $0.offset, value: Double($0.element))
        }
        let peak = points.max { $0.value < $1.value }
        return Chart(points) { point in
            BarMark(
                x: .value("Day", InsightsFormat.weekdayName(point.index)),
                y: .value("Commits", point.value)
            )
            .foregroundStyle(
                point.index == peak?.index ? Theme.sage : Theme.ink.opacity(0.35)
            )
            .cornerRadius(4)
            .annotation(position: .top, alignment: .center) {
                Text("\(Int(point.value))").font(.caption2).foregroundStyle(Theme.muted)
            }
        }
        .chartLegend(.hidden)
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks { value in
                AxisValueLabel {
                    if let day = value.as(String.self) {
                        Text(day).font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .frame(height: 150)
        .accessibilityLabel(
            "Commits by weekday. Peak \(peak.map { InsightsFormat.weekdayName($0.index) } ?? "—")."
        )
    }

    private var hourChart: some View {
        let points = hours.enumerated().map {
            IndexedValue(index: $0.offset, value: Double($0.element))
        }
        return Chart(points) { point in
            BarMark(
                x: .value("Hour", point.index),
                y: .value("Commits", point.value)
            )
            .foregroundStyle(
                point.index == peakHour ? Theme.sage : Theme.ink.opacity(0.35)
            )
            .cornerRadius(2)
        }
        .chartLegend(.hidden)
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks(values: [0, 6, 12, 18, 23]) { value in
                AxisValueLabel {
                    if let hour = value.as(Int.self) {
                        Text("\(hour)").font(.caption2).foregroundStyle(Theme.muted)
                    }
                }
            }
        }
        .frame(height: 120)
        .accessibilityLabel("Commits by hour of day. Peak \(peakHour):00.")
    }

    private var peakHour: Int {
        hours.enumerated().max { $0.element < $1.element }?.offset ?? 0
    }

    private var summaryLine: String? {
        let total = max(1, weekday.reduce(0, +))
        let weekend = weekday[5] + weekday[6]
        let share = Int((Double(weekend) / Double(total) * 100).rounded())
        guard total > 0 else { return nil }
        return "Weekends carry \(share)% of it."
    }

    private func padded(_ values: [Int], to count: Int) -> [Int] {
        guard values.count >= count else {
            return values + Array(repeating: 0, count: count - values.count)
        }
        return Array(values.prefix(count))
    }
}

// MARK: - GitHub notice

struct ActivityGithubNotice: View {
    let state: ActivityGithubState

    var body: some View {
        Group {
            if !state.available {
                notice(
                    "GitHub is not connected",
                    state.error ?? "Install gh and sign in on your Mac to see pull requests and reviews."
                )
            } else if let error = state.error {
                notice("GitHub is stale", error)
            }
        }
    }

    private func notice(_ title: String, _ detail: String) -> some View {
        HStack(spacing: Spacing.snug) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(Theme.amber)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).typeContent().foregroundStyle(Theme.ink)
                Text(detail).typeMeta().foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(Spacing.row)
        .background(Theme.raised, in: .rect(cornerRadius: Radius.card, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Month helper

extension DateFormatter {
    static let cachedMonth: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM"
        return formatter
    }()
}
