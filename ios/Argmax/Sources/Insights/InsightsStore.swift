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
// Filtering stays client-side: provider/project pickers narrow the charts and
// breakdowns, while the provider cards, repository shares, and heatmap stay
// global — the desktop's never-narrow rule, without a second fetch.
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
    /// Client-side narrowers. Nil means all; the cards/heatmap ignore them.
    @Published var providerFilter: String?
    @Published var projectFilter: String?

    private let client: BridgeClient
    private var usageReadAt: Date?
    private var activityReadAt: Date?
    private var loadedUsageWindow: String?
    private var loadedActivityWindow: String?
    private var inFlight: Set<Tab> = []
    private static let freshFor: TimeInterval = 120
    private static let log = Logger(subsystem: "com.argmax.remote", category: "insights")
    static let usageWindows = ["7d", "30d"]
    static let activityWindows = ["7d", "30d", "12m"]

    init(client: BridgeClient) {
        self.client = client
        // Paint from disk before the socket even exists: the last answer per
        // default window persists across launches, so the page opens on
        // numbers — however old — while the host re-sweeps behind them. A
        // cold ledger's first sweep is seconds the user should never stare
        // at. Only the visible windows load here; switching windows fetches.
        if let cached: UsageSummary = Self.readCache(kind: "usage", window: usageWindow) {
            usage = cached
            usageReadAt = Self.cacheDate(kind: "usage", window: usageWindow)
            loadedUsageWindow = usageWindow
        }
        if let cached: ActivitySummary = Self.readCache(kind: "activity", window: activityWindow) {
            activity = cached
            activityReadAt = Self.cacheDate(kind: "activity", window: activityWindow)
            loadedActivityWindow = activityWindow
        }
        let usageHit = usage != nil
        let activityHit = activity != nil
        Self.log.debug("cache init usage=\(usageHit ? "hit" : "miss") activity=\(activityHit ? "hit" : "miss")")
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
        if tab == .usage {
            // Read the window now: a change mid-flight must not stamp the
            // answer for the wrong window.
            let window = usageWindow
            let zone = timeZone
            let startedAt = Date()
            do {
                let summary = try await fetchUsage(window: window, timeZone: zone)
                let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
                Self.log.debug("usage:summary window=\(window) in \(ms)ms")
                // A newer load already won; a stale answer never paints.
                if window == usageWindow {
                    usage = summary
                    usageReadAt = Date()
                    loadedUsageWindow = window
                    // Encoding the whole payload is main-thread work the
                    // page would feel as a hitch, so it runs off the actor.
                    Task.detached(priority: .utility) {
                        Self.writeCache(summary, kind: "usage", window: window)
                    }
                    if failure != nil, activity != nil { failure = nil }
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
                    Task.detached(priority: .utility) {
                        Self.writeCache(summary, kind: "activity", window: window)
                    }
                    if failure != nil, usage != nil { failure = nil }
                }
            } catch {
                Self.log.debug("activity:summary window=\(window) failed: \(error.localizedDescription)")
                if activity == nil { failure = hostFailureMessage(error) }
            }
        }
        setLoading(tab, false)
        inFlight.remove(tab)
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
    private func fetchUsage(window: String, timeZone: String) async throws -> UsageSummary {
        let client = client
        return try await Task.detached(priority: .userInitiated) {
            try await client.usageSummary(
                UsageSummaryInput(window: window, timeZone: timeZone, provider: nil)
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

    /// One file per kind + window in Caches: small enough (<200KB) to read
    /// synchronously at init, never backed up, and simply absent on first
    /// launch. The mtime is the freshness clock.
    nonisolated private static func cacheURL(kind: String, window: String) -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("insights-\(kind)-\(window).json")
    }

    nonisolated private static func readCache<T: Decodable>(kind: String, window: String) -> T? {
        guard let url = cacheURL(kind: kind, window: window),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    nonisolated private static func cacheDate(kind: String, window: String) -> Date? {
        guard let url = cacheURL(kind: kind, window: window),
            let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        else { return nil }
        return values.contentModificationDate
    }

    nonisolated private static func writeCache<T: Encodable>(_ value: T, kind: String, window: String) {
        guard let url = cacheURL(kind: kind, window: window),
            let data = try? JSONEncoder().encode(value)
        else { return }
        try? data.write(to: url, options: .atomic)
    }

    // MARK: - Client-side narrowing

    /// Series buckets with only the selected provider's values. Empty filter
    /// means every provider.
    func usageSeries() -> [UsageSeriesPoint] {
        guard let usage else { return [] }
        guard let provider = providerFilter else { return usage.series }
        return usage.series.map { point in
            UsageSeriesPoint(
                bucketStart: point.bucketStart,
                values: point.values.filter { $0.provider == provider }
            )
        }
    }

    /// Model rows for the breakdown, narrowed to the selected provider and
    /// sorted by cost.
    func usageModels() -> [UsageModelRow] {
        guard let usage else { return [] }
        let rows = usage.models.filter {
            providerFilter == nil || $0.provider == providerFilter
        }
        return rows.sorted { $0.costUsd > $1.costUsd }
    }

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
