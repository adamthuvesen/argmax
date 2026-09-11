import Foundation

// Codable mirrors for the Usage and Activity ledger summaries the desktop
// Usage/Activity pages paint from (`src/shared/bindings.d.ts`, generated from
// Rust by tauri-specta; inputs in `src-tauri/src/ipc/inputs.rs`).
//
// Same tolerance rules as `Models.swift`: unknown keys are ignored, timestamps
// stay `String`, and every collection falls back to `[]` so a host that omits
// a slice never blanks the screen. Wire enums (`window`, `provider`,
// `costSource`, states) stay `String` — the phone groups and labels them but
// never switches on them exhaustively, so a new variant must not throw.

// MARK: - Inputs

/// `UsageSummaryInput`. `provider` narrows server-side, but the phone always
/// sends `null` and filters client-side instead: the provider cards stay
/// global while the chart and breakdown narrow, the desktop's "tiles never
/// narrow" rule (`UsageProviderRows.tsx`), without a second fetch.
struct UsageSummaryInput: Encodable, Sendable {
    var window: String
    var timeZone: String
    var provider: String?

    enum CodingKeys: String, CodingKey {
        case window, timeZone, provider
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(window, forKey: .window)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encodeAlways(provider, forKey: .provider)
    }
}

/// `ActivitySummaryInput`. Same shape as usage: always unfiltered on the wire,
/// filtered client-side so the heatmap and repository shares stay global while
/// the chart narrows (desktop `repositories` + `heatmap` never-narrow rule).
struct ActivitySummaryInput: Encodable, Sendable {
    var window: String
    var projectId: String?
    var timeZone: String

    enum CodingKeys: String, CodingKey {
        case window, projectId, timeZone
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(window, forKey: .window)
        try container.encodeAlways(projectId, forKey: .projectId)
        try container.encode(timeZone, forKey: .timeZone)
    }
}

// MARK: - Usage output

/// `UsageTokenTotals` — input/output/cache split for one scope.
struct UsageTokenTotals: Codable, Hashable, Sendable {
    var inputUncached: Double = 0
    var cacheRead: Double = 0
    var cacheWrite: Double = 0
    var output: Double = 0
    var reasoning: Double = 0

    var processed: Double { inputUncached + cacheRead + cacheWrite + output }
}

/// `UsagePreviousPeriod` — the window before this one, for the delta chip.
struct UsagePreviousPeriod: Codable, Hashable, Sendable {
    var costUsd: Double = 0
    var tokens: UsageTokenTotals = .init()
    var sessions: Int = 0
}

/// `UsageProviderSummary` — one "By provider" card.
struct UsageProviderSummary: Codable, Hashable, Sendable, Identifiable {
    var provider: String = ""
    var available: Bool = true
    var sessions: Int = 0
    var tokens: UsageTokenTotals = .init()
    var costUsd: Double = 0
    var cacheSavingsUsd: Double = 0
    var costSource: String = ""

    var id: String { provider }
}

/// `UsageSeriesValue` — one provider's contribution to a bucket.
struct UsageSeriesValue: Codable, Hashable, Sendable {
    var provider: String = ""
    var costUsd: Double = 0
    var tokens: Double = 0
}

/// `UsageSeriesPoint` — one day (or hour) bucket of the daily-cost chart.
struct UsageSeriesPoint: Codable, Hashable, Sendable {
    var bucketStart: String = ""
    var values: [UsageSeriesValue] = []
}

/// `UsageModelRow` — one row of the model breakdown table.
struct UsageModelRow: Codable, Hashable, Sendable {
    var provider: String = ""
    var modelId: String = ""
    var sessions: Int = 0
    var tokens: UsageTokenTotals = .init()
    var costUsd: Double = 0
    var costSource: String = ""
}

/// `UsageDayRow` — per-day rollup (kept for the peak/average line).
struct UsageDayRow: Codable, Hashable, Sendable {
    var bucketStart: String = ""
    var sessions: Int = 0
    var tokens: UsageTokenTotals = .init()
    var costUsd: Double = 0
    var costSource: String = ""
}

/// `UsageSummary` — the whole Usage page in one payload.
///
/// `Codable` rather than `Decodable`: the phone persists the last answer per
/// window to disk so the page paints instantly — even across launches — while
/// the host re-sweeps behind it. Decode stays total (unknown keys ignored,
// collections default); encode is the straight mirror.
struct UsageSummary: Codable, Hashable, Sendable {
    var window: String = ""
    var provider: String?
    var timeZone: String = ""
    var rangeStart: String = ""
    var rangeEnd: String = ""
    var resolution: String = ""
    var sessions: Int = 0
    var tokens: UsageTokenTotals = .init()
    var costUsd: Double = 0
    var cacheSavingsUsd: Double = 0
    var costSource: String = ""
    var previous: UsagePreviousPeriod?
    var providers: [UsageProviderSummary] = []
    var series: [UsageSeriesPoint] = []
    var models: [UsageModelRow] = []
    var days: [UsageDayRow] = []
    var pricingAsOf: String?
    var scanPhase: String = "idle"

    enum CodingKeys: String, CodingKey {
        case window, provider, timeZone, rangeStart, rangeEnd, resolution
        case sessions, tokens, costUsd, cacheSavingsUsd, costSource
        case previous, providers, series, models, days, pricingAsOf
        case scan
    }

    enum ScanKeys: String, CodingKey {
        case phase
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        window = try container.decodeIfPresent(String.self, forKey: .window) ?? ""
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        timeZone = try container.decodeIfPresent(String.self, forKey: .timeZone) ?? ""
        rangeStart = try container.decodeIfPresent(String.self, forKey: .rangeStart) ?? ""
        rangeEnd = try container.decodeIfPresent(String.self, forKey: .rangeEnd) ?? ""
        resolution = try container.decodeIfPresent(String.self, forKey: .resolution) ?? ""
        sessions = try container.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        tokens = try container.decodeIfPresent(UsageTokenTotals.self, forKey: .tokens) ?? .init()
        costUsd = try container.decodeIfPresent(Double.self, forKey: .costUsd) ?? 0
        cacheSavingsUsd = try container.decodeIfPresent(Double.self, forKey: .cacheSavingsUsd) ?? 0
        costSource = try container.decodeIfPresent(String.self, forKey: .costSource) ?? ""
        previous = try container.decodeIfPresent(UsagePreviousPeriod.self, forKey: .previous)
        providers = try container.decodeIfPresent([UsageProviderSummary].self, forKey: .providers) ?? []
        series = try container.decodeIfPresent([UsageSeriesPoint].self, forKey: .series) ?? []
        models = try container.decodeIfPresent([UsageModelRow].self, forKey: .models) ?? []
        days = try container.decodeIfPresent([UsageDayRow].self, forKey: .days) ?? []
        pricingAsOf = try container.decodeIfPresent(String.self, forKey: .pricingAsOf)
        if let scan = try? container.nestedContainer(keyedBy: ScanKeys.self, forKey: .scan) {
            scanPhase = (try? scan.decodeIfPresent(String.self, forKey: .phase)) ?? "idle"
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(window, forKey: .window)
        try container.encodeIfPresent(provider, forKey: .provider)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encode(rangeStart, forKey: .rangeStart)
        try container.encode(rangeEnd, forKey: .rangeEnd)
        try container.encode(resolution, forKey: .resolution)
        try container.encode(sessions, forKey: .sessions)
        try container.encode(tokens, forKey: .tokens)
        try container.encode(costUsd, forKey: .costUsd)
        try container.encode(cacheSavingsUsd, forKey: .cacheSavingsUsd)
        try container.encode(costSource, forKey: .costSource)
        try container.encodeIfPresent(previous, forKey: .previous)
        try container.encode(providers, forKey: .providers)
        try container.encode(series, forKey: .series)
        try container.encode(models, forKey: .models)
        try container.encode(days, forKey: .days)
        try container.encodeIfPresent(pricingAsOf, forKey: .pricingAsOf)
        var scan = container.nestedContainer(keyedBy: ScanKeys.self, forKey: .scan)
        try scan.encode(scanPhase, forKey: .phase)
    }
}

// MARK: - Activity output

/// `ActivityTotals` — hero numbers plus the previous window for deltas.
struct ActivityTotals: Codable, Hashable, Sendable {
    var commits: Int = 0
    var linesAdded: Int = 0
    var linesRemoved: Int = 0
    var filesChanged: Int = 0
    var activeDays: Int = 0
    var prsOpened: Int = 0
    var prsMerged: Int = 0
    var prsClosed: Int = 0
    var reviewsGiven: Int = 0
    var reviewApprovals: Int = 0
    var reviewChangesRequested: Int = 0
    var reviewComments: Int = 0
}

/// `ActivityRepository` — one row of the repositories leaderboard.
struct ActivityRepository: Codable, Hashable, Sendable, Identifiable {
    var projectId: String = ""
    var name: String = ""
    var path: String = ""
    var githubRepo: String?
    var commits: Int = 0
    var linesAdded: Int = 0
    var linesRemoved: Int = 0
    var prsMerged: Int = 0
    var lastCommitAt: String?
    var share: Double = 0

    var id: String { projectId }
}

/// `ActivitySeriesRepository` — one repo's contribution to a bucket.
struct ActivitySeriesRepository: Codable, Hashable, Sendable {
    var projectId: String = ""
    var commits: Int = 0
    var linesAdded: Int = 0
    var linesRemoved: Int = 0
}

/// `ActivitySeriesPoint` — one bucket of the daily-commits chart.
struct ActivitySeriesPoint: Codable, Hashable, Sendable {
    var bucketStart: String = ""
    var byRepository: [ActivitySeriesRepository] = []
}

/// `ActivityHeatmapDay` — one cell of the contributions grid.
struct ActivityHeatmapDay: Codable, Hashable, Sendable {
    var date: String = ""
    var commits: Int = 0
}

/// `ActivityBusiestDay` — the footnote's busiest day.
struct ActivityBusiestDay: Codable, Hashable, Sendable {
    var date: String = ""
    var commits: Int = 0
}

/// `ActivityStreaks` — running/longest/busiest line under the heatmap.
struct ActivityStreaks: Codable, Hashable, Sendable {
    var currentDays: Int = 0
    var currentStart: String?
    var longestDays: Int = 0
    var longestStart: String?
    var longestEnd: String?
    var busiestDay: ActivityBusiestDay?
}

/// `ActivityCadence` — weekday (Mon-first, 7) and hour-of-day (24) histograms.
struct ActivityCadence: Codable, Hashable, Sendable {
    var byWeekday: [Int] = []
    var byHour: [Int] = []
}

/// `ActivityPullRequest` — one row of the PR ledger.
struct ActivityPullRequest: Codable, Hashable, Sendable {
    var number: Int = 0
    var title: String = ""
    var repository: String = ""
    var projectId: String?
    var url: String = ""
    var state: String = ""
    var isDraft: Bool = false
    var createdAt: String = ""
    var mergedAt: String?
    var closedAt: String?
    var additions: Int = 0
    var deletions: Int = 0
    var cycleSeconds: Int?
}

/// `ActivityReview` — one row of the reviews-given history.
struct ActivityReview: Codable, Hashable, Sendable {
    var number: Int = 0
    var title: String = ""
    var repository: String = ""
    var url: String = ""
    var state: String = ""
    var submittedAt: String = ""
}

/// `ActivityGithubState` — login / freshness for the GitHub notice.
struct ActivityGithubState: Codable, Hashable, Sendable {
    var available: Bool = false
    var login: String?
    var error: String?
    var lastFetchedAt: String?
}

/// `ActivitySummary` — the whole Activity page in one payload. Persisted like
/// `UsageSummary` above: instant paint from disk, refresh behind it.
struct ActivitySummary: Codable, Hashable, Sendable {
    var window: String = ""
    var projectId: String?
    var timeZone: String = ""
    var rangeStart: String = ""
    var rangeEnd: String = ""
    var resolution: String = ""
    var authorEmails: [String] = []
    var totals: ActivityTotals = .init()
    var previous: ActivityTotals?
    var repositories: [ActivityRepository] = []
    var series: [ActivitySeriesPoint] = []
    var heatmap: [ActivityHeatmapDay] = []
    var streaks: ActivityStreaks = .init()
    var cadence: ActivityCadence = .init()
    var pullRequests: [ActivityPullRequest] = []
    var reviews: [ActivityReview] = []
    var medianCycleSeconds: Int?
    var github: ActivityGithubState = .init()
    var scanPhase: String = "idle"

    enum CodingKeys: String, CodingKey {
        case window, projectId, timeZone, rangeStart, rangeEnd, resolution
        case authorEmails, totals, previous, repositories, series, heatmap
        case streaks, cadence, pullRequests, reviews, medianCycleSeconds, github
        case scan
    }

    enum ScanKeys: String, CodingKey {
        case phase
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        window = try container.decodeIfPresent(String.self, forKey: .window) ?? ""
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        timeZone = try container.decodeIfPresent(String.self, forKey: .timeZone) ?? ""
        rangeStart = try container.decodeIfPresent(String.self, forKey: .rangeStart) ?? ""
        rangeEnd = try container.decodeIfPresent(String.self, forKey: .rangeEnd) ?? ""
        resolution = try container.decodeIfPresent(String.self, forKey: .resolution) ?? ""
        authorEmails = try container.decodeIfPresent([String].self, forKey: .authorEmails) ?? []
        totals = try container.decodeIfPresent(ActivityTotals.self, forKey: .totals) ?? .init()
        previous = try container.decodeIfPresent(ActivityTotals.self, forKey: .previous)
        repositories = try container.decodeIfPresent([ActivityRepository].self, forKey: .repositories) ?? []
        series = try container.decodeIfPresent([ActivitySeriesPoint].self, forKey: .series) ?? []
        heatmap = try container.decodeIfPresent([ActivityHeatmapDay].self, forKey: .heatmap) ?? []
        streaks = try container.decodeIfPresent(ActivityStreaks.self, forKey: .streaks) ?? .init()
        cadence = try container.decodeIfPresent(ActivityCadence.self, forKey: .cadence) ?? .init()
        pullRequests = try container.decodeIfPresent([ActivityPullRequest].self, forKey: .pullRequests) ?? []
        reviews = try container.decodeIfPresent([ActivityReview].self, forKey: .reviews) ?? []
        medianCycleSeconds = try container.decodeIfPresent(Int.self, forKey: .medianCycleSeconds)
        github = try container.decodeIfPresent(ActivityGithubState.self, forKey: .github) ?? .init()
        if let scan = try? container.nestedContainer(keyedBy: ScanKeys.self, forKey: .scan) {
            scanPhase = (try? scan.decodeIfPresent(String.self, forKey: .phase)) ?? "idle"
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(window, forKey: .window)
        try container.encodeIfPresent(projectId, forKey: .projectId)
        try container.encode(timeZone, forKey: .timeZone)
        try container.encode(rangeStart, forKey: .rangeStart)
        try container.encode(rangeEnd, forKey: .rangeEnd)
        try container.encode(resolution, forKey: .resolution)
        try container.encode(authorEmails, forKey: .authorEmails)
        try container.encode(totals, forKey: .totals)
        try container.encodeIfPresent(previous, forKey: .previous)
        try container.encode(repositories, forKey: .repositories)
        try container.encode(series, forKey: .series)
        try container.encode(heatmap, forKey: .heatmap)
        try container.encode(streaks, forKey: .streaks)
        try container.encode(cadence, forKey: .cadence)
        try container.encode(pullRequests, forKey: .pullRequests)
        try container.encode(reviews, forKey: .reviews)
        try container.encodeIfPresent(medianCycleSeconds, forKey: .medianCycleSeconds)
        try container.encode(github, forKey: .github)
        var scan = container.nestedContainer(keyedBy: ScanKeys.self, forKey: .scan)
        try scan.encode(scanPhase, forKey: .phase)
    }
}
