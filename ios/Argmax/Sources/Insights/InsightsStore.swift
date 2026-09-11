import Foundation
import OSLog

// The data under the Insights pages: one unfiltered `usage:summary` and one
// unfiltered `activity:summary`, each loaded on its own — a screen-opens read
// and a pull-to-refresh per tab, never a poll.
//
// Why per-tab: the two ledgers cost nothing alike. Usage answers from SQLite
// in about a second; activity sweeps every repo's git log and can take twenty
// times that on a cold ledger. Fetching both and painting after the slower
// one made the fast tab wait behind the slow sweep on every open, and every
// window change paid for both summaries again. So each tab owns its fetch,
// its freshness, and its spinner, and opening one tab prefetches the other in
// the background — tab switches land on paint, not on the socket.
//
// The provider picker refetches: `usage:summary` narrows the hero, previous
// period, chart, token flow, and breakdown while its provider rows stay
// global, so the cards keep every provider (the desktop's never-narrow rule)
// and the picker keeps offering them. Deriving that client-side left the hero
// on the global totals. The project picker stays client-side: repository
// shares and the heatmap ignore it, and the series carries every repository.
//
// Fetches run detached: `BridgeClient.request` decodes on its caller, and a
// cold activity payload is big enough JSON that neither the wait nor the
// decode belongs on the main thread.

@MainActor
final class InsightsStore: ObservableObject {
    enum Tab: String, Hashable, Identifiable, CaseIterable {
        case usage, activity
        var id: String { rawValue }
        var label: String { self == .usage ? "Usage" : "Activity" }
    }

    enum UsageMode: String, Hashable, Identifiable, CaseIterable {
        case cost, tokens
        var id: String { rawValue }
        var label: String { self == .cost ? "Cost" : "Tokens" }
    }

    enum ActivityMode: String, Hashable, Identifiable, CaseIterable {
        case commits, lines
        var id: String { rawValue }
        var label: String { self == .commits ? "Commits" : "Lines" }
    }

    @Published private(set) var usage: UsageSummary?
    @Published private(set) var activity: ActivitySummary?
    @Published private(set) var usageLoading = false
    @Published private(set) var activityLoading = false
    @Published private(set) var failure: String?

    @Published var tab: Tab = .usage
    @Published var usageWindow = "30d"
    @Published var activityWindow = "30d"
    @Published var usageMode: UsageMode = .cost
    @Published var activityMode: ActivityMode = .commits
    /// Nil means all providers. Changing it refetches; the cards ignore it.
    @Published var providerFilter: String?
    /// Client-side narrower. Nil means all; the heatmap and shares ignore it.
    @Published var projectFilter: String?

    private let client: BridgeClient
    private var usageReadAt: Date?
    private var activityReadAt: Date?
    private var loadedUsageWindow: String?
    private var loadedUsageProvider: String?
    private var loadedActivityWindow: String?
    private var inFlight: Set<Tab> = []
    private static let freshFor: TimeInterval = 120
    private static let log = Logger(subsystem: "com.argmax.remote", category: "insights")
    static let usageWindows = ["7d", "30d"]
    static let activityWindows = ["7d", "30d", "12m"]

    init(client: BridgeClient) {
        self.client = client
        Task { [weak self, client] in
            async let usage = DeviceCache.shared.read(CachedUsage.self,
                scope: client.cacheNamespace, key: "insights-usage-30d")
            async let activity = DeviceCache.shared.read(CachedActivity.self,
                scope: client.cacheNamespace, key: "insights-activity-30d")
            let cached = await (usage, activity)
            guard let self else { return }
            if self.usage == nil, self.usageWindow == "30d", self.providerFilter == nil,
               let value = cached.0, value.timeZone == self.timeZone {
                self.usage = value.summary
                self.usageReadAt = value.readAt
                self.loadedUsageWindow = "30d"
            }
            if self.activity == nil, self.activityWindow == "30d",
               let value = cached.1, value.timeZone == self.timeZone {
                self.activity = value.summary
                self.activityReadAt = value.readAt
                self.loadedActivityWindow = "30d"
            }
        }
    }

    var timeZone: String { TimeZone.current.identifier }

    func isLoading(_ tab: Tab) -> Bool {
        tab == .usage ? usageLoading : activityLoading
    }

    // MARK: - Entry points

    /// The screen's one call on open and on tab switch: the visible tab loads
    /// in the foreground, the other prefetches behind it. Either one already
    /// fresh for its window returns without touching the socket.
    func ensure(_ tab: Tab) async {
        if tab == .usage {
            if isFresh(.usage) {
                prefetch(.activity)
            } else {
                // The prefetch rides along: usage paints the moment it lands
                // instead of waiting for the slower sweep behind it.
                prefetch(.activity)
                await load(.usage)
            }
        } else {
            if isFresh(.activity) {
                prefetch(.usage)
            } else {
                prefetch(.usage)
                await load(.activity)
            }
        }
    }

    /// Pull-to-refresh and window changes: only the visible tab refetches.
    func reloadCurrent() async {
        await load(tab)
    }

    func reloadUsage() async {
        await load(.usage)
    }

    func reloadActivity() async {
        await load(.activity)
    }

    /// App launch and foreground return: warm both ledgers without awaiting
    /// either, so nothing on screen ever waits for these numbers.
    func prefetch() {
        prefetch(.usage)
        prefetch(.activity)
    }

    // MARK: - Loads

    private func isFresh(_ tab: Tab, now: Date = Date()) -> Bool {
        if tab == .usage {
            guard let readAt = usageReadAt, usage != nil else { return false }
            return loadedUsageWindow == usageWindow
                && loadedUsageProvider == providerFilter
                && now.timeIntervalSince(readAt) < Self.freshFor
        }
        guard let readAt = activityReadAt, activity != nil else { return false }
        return loadedActivityWindow == activityWindow
            && now.timeIntervalSince(readAt) < Self.freshFor
    }

    private func prefetch(_ tab: Tab) {
        guard !inFlight.contains(tab), !isFresh(tab) else { return }
        Task { await load(tab) }
    }

    private func load(_ tab: Tab) async {
        guard !inFlight.contains(tab) else { return }
        inFlight.insert(tab)
        setLoading(tab, true)
        // A picker moved while this answer was in flight: the answer is
        // discarded below, and the reload the picker asked for bounced off
        // the in-flight guard, so this load runs once more for the new
        // pickers rather than leaving the page on bones.
        var pickersMoved = false
        if tab == .usage {
            // Read the pickers now: a change mid-flight must not stamp the
            // answer for the wrong window or provider.
            let window = usageWindow
            let provider = providerFilter
            let zone = timeZone
            let startedAt = Date()
            do {
                let summary = try await fetchUsage(window: window, provider: provider, timeZone: zone)
                let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
                Self.log.debug("usage:summary window=\(window) provider=\(provider ?? "all") in \(ms)ms")
                // A newer load already won; a stale answer never paints.
                if window == usageWindow, provider == providerFilter {
                    usage = summary
                    usageReadAt = Date()
                    loadedUsageWindow = window
                    loadedUsageProvider = provider
                    // Encoding the whole payload is main-thread work the
                    // page would feel as a hitch, so it runs off the actor.
                    // Only the global answer persists: the page opens on
                    // "All providers", so a narrowed one would paint the
                    // wrong numbers under that label.
                    if provider == nil {
                        let scope = client.cacheNamespace
                        Task {
                            await DeviceCache.shared.write(CachedUsage(summary: summary, readAt: Date(), timeZone: zone),
                                scope: scope, key: "insights-usage-\(window)")
                        }
                    }
                    if failure != nil, activity != nil { failure = nil }
                } else {
                    pickersMoved = true
                }
            } catch {
                Self.log.debug("usage:summary window=\(window) failed: \(error.localizedDescription)")
                if usage == nil { failure = hostFailureMessage(error) }
            }
        } else {
            let window = activityWindow
            let zone = timeZone
            let startedAt = Date()
            do {
                let summary = try await fetchActivity(window: window, timeZone: zone)
                let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
                Self.log.debug("activity:summary window=\(window) in \(ms)ms")
                if window == activityWindow {
                    activity = summary
                    activityReadAt = Date()
                    loadedActivityWindow = window
                    // Encoding the whole payload is main-thread work the
                    // page would feel as a hitch, so it runs off the actor.
                    let scope = client.cacheNamespace
                    Task {
                        await DeviceCache.shared.write(CachedActivity(summary: summary, readAt: Date(), timeZone: zone),
                            scope: scope, key: "insights-activity-\(window)")
                    }
                    if failure != nil, usage != nil { failure = nil }
                } else {
                    pickersMoved = true
                }
            } catch {
                Self.log.debug("activity:summary window=\(window) failed: \(error.localizedDescription)")
                if activity == nil { failure = hostFailureMessage(error) }
            }
        }
        setLoading(tab, false)
        inFlight.remove(tab)
        if pickersMoved { await load(tab) }
    }

    private func setLoading(_ tab: Tab, _ value: Bool) {
        if tab == .usage {
            usageLoading = value
        } else {
            activityLoading = value
        }
    }

    /// Off the main actor: the socket wait and the JSON decode both happen
    /// here, and a cold activity payload is large enough to hitch scrolling.
    private func fetchUsage(
        window: String, provider: String?, timeZone: String
    ) async throws -> UsageSummary {
        let client = client
        return try await Task.detached(priority: .userInitiated) {
            try await client.usageSummary(
                UsageSummaryInput(window: window, timeZone: timeZone, provider: provider)
            )
        }.value
    }

    private func fetchActivity(window: String, timeZone: String) async throws -> ActivitySummary {
        let client = client
        return try await Task.detached(priority: .userInitiated) {
            try await client.activitySummary(
                ActivitySummaryInput(window: window, projectId: nil, timeZone: timeZone)
            )
        }.value
    }

    // MARK: - Disk cache

    private struct CachedUsage: Codable, Sendable {
        let summary: UsageSummary
        let readAt: Date
        let timeZone: String
    }

    private struct CachedActivity: Codable, Sendable {
        let summary: ActivitySummary
        let readAt: Date
        let timeZone: String
    }

    // MARK: - Client-side narrowing

    /// Series buckets with only the selected project's commits/lines. The
    /// heatmap and repository shares always read the unfiltered summary.
    func activitySeries() -> [ActivitySeriesPoint] {
        guard let activity else { return [] }
        guard let project = projectFilter else { return activity.series }
        return activity.series.map { point in
            ActivitySeriesPoint(
                bucketStart: point.bucketStart,
                byRepository: point.byRepository.filter { $0.projectId == project }
            )
        }
    }

    /// PR ledger narrowed to the selected project. Reviews carry only a
    /// repository name, so they narrow by the selected repository's name.
    func activityPRs() -> [ActivityPullRequest] {
        guard let activity else { return [] }
        guard let project = projectFilter else { return activity.pullRequests }
        let name = activity.repositories.first { $0.projectId == project }?.name
        return activity.pullRequests.filter {
            $0.projectId == project || ($0.repository == name && name != nil)
        }
    }

    func activityReviews() -> [ActivityReview] {
        guard let activity else { return [] }
        guard let project = projectFilter,
            let repo = activity.repositories.first(where: { $0.projectId == project })
        else { return activity.reviews }
        return activity.reviews.filter {
            $0.repository == repo.name || $0.repository == (repo.githubRepo ?? "")
        }
    }
}
