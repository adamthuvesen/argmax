import Foundation
import OSLog

// "Remaining on your plans", as the phone reads it.
//
// `usage:remaining` is the desktop Usage page's second, live read: what each
// provider login says is left of its included usage, including use outside
// Argmax (docs/usage.md). The Mac does the parsing and the naming — a
// window arrives already labelled "5-hour", "Weekly", "Weekly Fable" — so
// this file decodes, formats, and nothing else. A label invented here would
// be a second vocabulary for the same numbers.
//
// Only the limits half of the Usage page is on the phone. The ledger above
// it on the desktop — spend per provider, the chart, the breakdown — is a
// page, not a settings group, and reads no better on a phone for being
// squeezed into one.

/// `UsageLimitWindow` in `src/shared/bindings.d.ts`.
struct LimitWindow: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var label: String
    /// 0–100, how much of the window is still left.
    var remainingPercent: Double
    /// RFC 3339 UTC; nil when the provider sent no reset.
    var resetsAt: String?
}

/// `UsagePlanKind`. Open, like the wire enums in `Models.swift`: a plan kind
/// added on the Mac must not blank the whole card.
enum PlanKind: OpenWireEnum {
    case subscription
    case enterprise
    case apiKey
    case unavailable
    case error
    case unknown(String)

    init(rawWire: String) {
        switch rawWire {
        case "subscription": self = .subscription
        case "enterprise": self = .enterprise
        case "api_key": self = .apiKey
        case "unavailable": self = .unavailable
        case "error": self = .error
        default: self = .unknown(rawWire)
        }
    }

    var rawWire: String {
        switch self {
        case .subscription: return "subscription"
        case .enterprise: return "enterprise"
        case .apiKey: return "api_key"
        case .unavailable: return "unavailable"
        case .error: return "error"
        case .unknown(let raw): return raw
        }
    }
}

/// `UsageProviderRemaining` — one provider login.
struct ProviderLimits: Decodable, Hashable, Sendable, Identifiable {
    var provider: String
    var kind: PlanKind
    var planLabel: String?
    var windows: [LimitWindow]
    var message: String?
    /// Where the message's numbers actually live, when they live off-app —
    /// Cursor's Spending dashboard is the only one today.
    var messageUrl: String?

    var id: String { provider }

    /// Meters, or a sentence. Enterprise, API-key and signed-out logins have
    /// no included usage to measure, and an empty bar would claim they were
    /// spent.
    var showsWindows: Bool { kind == .subscription && !windows.isEmpty }

    /// The plan on the right of the name: what the provider calls it, else
    /// what kind of login it is.
    var kindLabel: String? {
        if let planLabel, !planLabel.isEmpty { return planLabel }
        switch kind {
        case .enterprise: return "Enterprise"
        case .apiKey: return "API key"
        default: return nil
        }
    }
}

/// `UsageRemaining` — every login, and when they were read.
struct PlanLimits: Decodable, Hashable, Sendable {
    /// RFC 3339 UTC.
    var fetchedAt: String
    var providers: [ProviderLimits]
}

// MARK: - Copy

/// The two lines a meter carries, worded as the desktop words them.
enum LimitCopy {
    /// "36% left". Under a tenth of a percent is still not nothing, and
    /// rounding it to "0% left" would read as spent.
    static func left(_ percent: Double) -> String {
        guard percent.isFinite else { return "—" }
        if percent > 0, percent < 0.1 { return "<0.1% left" }
        if percent >= 10 { return "\(Int(percent.rounded()))% left" }
        // Rounded before formatting: `%.1f` breaks an exact tie to even and
        // the desktop's `toFixed` breaks it upward, and one card saying
        // 4.2% where the other says 4.3% is a bug report waiting to happen.
        return String(format: "%.1f%% left", (percent * 10).rounded() / 10)
    }

    /// "resets in 45m", "resets in 3h", "resets in 2d", then a date once the
    /// countdown stops meaning anything.
    static func reset(_ value: String?, now: Date = Date()) -> String? {
        guard let value, let at = parseWireTimestamp(value) else { return nil }
        let seconds = at.timeIntervalSince(now)
        if seconds <= 0 { return "resets now" }
        let minutes = (seconds / 60).rounded()
        if minutes < 60 { return "resets in \(Int(max(1, minutes)))m" }
        let hours = (minutes / 60).rounded()
        if hours < 24 { return "resets in \(Int(hours))h" }
        let days = (hours / 24).rounded()
        if days < 5 { return "resets in \(Int(days))d" }
        return "resets \(resetDate.string(from: at))"
    }

    /// "Sep 28", in the phone's own time zone — the reset is a moment, and
    /// the person reading it is here.
    private static let resetDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()
}

// MARK: - Fetch

/// Reads `usage:remaining`, ahead of the screen that shows it.
///
/// One per pairing, warmed once the chat list is up and again whenever the
/// app comes back to the foreground, so opening Settings paints numbers
/// instead of a sentence: the Mac calls five provider endpoints and takes
/// close to a second about it, which is a long time to look at a card that
/// is going to fill in.
///
/// Warmed, not polled. Claude's endpoint is rate-limited and the numbers
/// move slowly — a percentage that is two minutes old is the truth for
/// every practical purpose, so a read inside `freshFor` is skipped and a
/// stale one runs under the rows already on screen. Nothing here ever
/// empties the card to fill it again.
@MainActor
final class PlanLimitsStore: ObservableObject {
    @Published private(set) var limits: PlanLimits?
    @Published private(set) var loading = false
    @Published private(set) var failure: String?

    /// How long a read stays good enough to show without going back.
    private static let freshFor: TimeInterval = 120

    private static let log = Logger(subsystem: "com.argmax.remote", category: "limits")

    private let client: BridgeClient
    private var readAt: Date?

    init(client: BridgeClient) {
        self.client = client
    }

    /// What every caller but the retry button asks for: a read if there is
    /// nothing, or if what there is has aged out. Cheap to call often.
    func refreshIfStale(now: Date = Date()) async {
        guard !loading else { return }
        if let readAt, now.timeIntervalSince(readAt) < Self.freshFor { return }
        await reload()
    }

    func reload() async {
        loading = true
        failure = nil
        let startedAt = Date()
        do {
            limits = try await client.planLimits()
            readAt = Date()
            // The whole point of warming is that this second happens before
            // anyone is looking at it; a log line is how that is checked.
            Self.log.debug("usage:remaining in \(Int(Date().timeIntervalSince(startedAt) * 1000))ms")
        } catch {
            failure = hostFailureMessage(error)
            // Left stale on failure, so the next foreground or screen open
            // tries again rather than sitting on the error for two minutes.
            readAt = nil
        }
        loading = false
    }
}

#if DEBUG
extension PlanLimitsStore {
    static func preview(_ limits: PlanLimits?, failure: String? = nil, loading: Bool = false) -> PlanLimitsStore {
        let store = PlanLimitsStore(client: previewClient())
        store.limits = limits
        store.failure = failure
        store.loading = loading
        return store
    }
}
#endif
