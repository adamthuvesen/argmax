import Foundation
import SwiftUI

// Number and date shapes for the Insights pages, matching the desktop
// `usageFormat.ts` / `activityFormat.ts` so counts read alike on both.

enum InsightsFormat {
    private static let usd: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = 2
        formatter.minimumFractionDigits = 2
        return formatter
    }()

    private static let grouped: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.groupingSeparator = ","
        return formatter
    }()

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let isoDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.timeZone = TimeZone.current
        return formatter
    }()

    /// `$18,196.95` — hero totals.
    static func usdFull(_ value: Double) -> String {
        usd.string(from: NSNumber(value: value.isFinite ? value : 0)) ?? "$0.00"
    }

    /// `$1.1k`, `$275k`, `$8.3M` — axis ticks and compact rows.
    static func usdCompact(_ value: Double) -> String {
        let safe = value.isFinite ? value : 0
        let abs = abs(safe)
        let sign = safe < 0 ? "-" : ""
        switch abs {
        case 999_500...: return "\(sign)$\(trimmed(abs / 1_000_000))M"
        case 1_000...: return "\(sign)$\(trimmed(abs / 1_000))k"
        case 1...: return safe.truncatingRemainder(dividingBy: 1) == 0
            ? "\(sign)$\(Int(abs))" : "\(sign)$\(String(format: "%.1f", abs))"
        case 0: return "$0"
        default: return "\(sign)$\(String(format: "%.2f", abs))"
        }
    }

    /// `22.5B`, `434M`, `74M`, `1,557` — token counts and commit counts.
    static func compact(_ value: Double) -> String {
        let abs = abs(value)
        switch abs {
        case 1_000_000_000...: return "\(trimmed(value / 1_000_000_000))B"
        case 1_000_000...: return "\(trimmed(value / 1_000_000))M"
        case 10_000...: return "\(trimmed(value / 1_000))k"
        default: return grouped.string(from: NSNumber(value: value)) ?? "\(Int(value))"
        }
    }

    /// `45.9%`, `<0.1%`, `—` — share columns.
    static func percent(_ share: Double?) -> String {
        guard let share, share.isFinite else { return "—" }
        if share > 0 && share < 0.001 { return "<0.1%" }
        return "\(String(format: "%.1f", share * 100))%"
    }

    /// `↑ 15% vs the previous 30 days` — hero delta chips. Nil when there is
    /// no previous window to compare against.
    static func delta(current: Double, previous: Double?, windowLabel: String) -> String? {
        guard let previous, previous > 0, current.isFinite else { return nil }
        let pct = Int(((current - previous) / previous * 100).rounded())
        let arrow = pct >= 0 ? "↑" : "↓"
        return "\(arrow) \(abs(pct))% vs the previous \(windowLabel)"
    }

    /// `14m ago`, `3h ago`, `yesterday`, `1w ago` — repository last-commit.
    static func relative(_ iso: String?, now: Date = Date()) -> String {
        guard let iso, let date = parse(iso) else { return "—" }
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        switch seconds {
        case 0..<60: return "just now"
        case 60..<3_600:
            let minutes = seconds / 60
            return minutes == 1 ? "1m ago" : "\(minutes)m ago"
        case 3_600..<86_400:
            let hours = seconds / 3_600
            return hours == 1 ? "1h ago" : "\(hours)h ago"
        case 86_400..<172_800: return "yesterday"
        case 172_800..<604_800: return "\(seconds / 86_400)d ago"
        case 604_800..<2_592_000:
            let weeks = seconds / 604_800
            return weeks == 1 ? "1w ago" : "\(weeks)w ago"
        default:
            let months = seconds / 2_592_000
            return months <= 1 ? "1mo ago" : "\(months)mo ago"
        }
    }

    /// `18m`, `1h 05m`, `2d 3h` — PR cycle times and median cycle.
    static func cycle(_ seconds: Int?) -> String {
        guard let seconds, seconds >= 0 else { return "—" }
        switch seconds {
        case 0..<3_600: return "\(max(1, seconds / 60))m"
        case 3_600..<86_400:
            let hours = seconds / 3_600
            let minutes = (seconds % 3_600) / 60
            return minutes == 0 ? "\(hours)h" : "\(hours)h \(String(format: "%02d", minutes))m"
        default:
            let days = seconds / 86_400
            let hours = (seconds % 86_400) / 3_600
            return hours == 0 ? "\(days)d" : "\(days)d \(hours)h"
        }
    }

    /// `Sep 11` — card subtitles and review dates.
    static func shortDay(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "—" }
        return DateFormatter.cachedDay.string(from: date)
    }

    /// `AUG 13` — chart axis ticks.
    static func axisDay(_ iso: String) -> String {
        guard let date = parse(iso) else { return "" }
        return DateFormatter.cachedDay.string(from: date).uppercased()
    }

    /// `Sunday` + count — cadence peak lines.
    static func weekdayName(_ mondayFirst: Int) -> String {
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][((mondayFirst % 7) + 7) % 7]
    }

    /// Picks the one formatter the string's shape can match. Trying the
    /// three in turn cost two failed ISO8601 parses per heatmap day, and the
    /// 365-day grid parses on every render.
    static func parse(_ iso: String) -> Date? {
        if iso.count == 10 { return isoDay.date(from: iso) }
        if iso.contains(".") { return isoWithFraction.date(from: iso) }
        return isoPlain.date(from: iso)
    }

    private static func trimmed(_ value: Double) -> String {
        String(format: "%.1f", value)
            .replacingOccurrences(of: ".0", with: "")
    }
}

// MARK: - Series palette

/// Chart colors, taken from the desktop's `--usage-*` tokens
/// (`src/renderer/styles/tokens.css`) so a provider keeps its hue on both.
/// Assigned by identity — a window that reorders rows never repaints them.
enum InsightsPalette {
    static func provider(_ id: String) -> Color {
        switch id.lowercased() {
        case "claude": return Color(Theme.dynamic(light: 0xC1_68_3E, dark: 0xBE_6E_4A))
        case "codex": return Color(Theme.dynamic(light: 0x53_50_48, dark: 0xB7_B3_A9))
        case "cursor": return Color(Theme.dynamic(light: 0x5F_8B_D9, dark: 0x61_99_ED))
        case "opencode": return Color(Theme.dynamic(light: 0x22_96_77, dark: 0x2B_A3_88))
        case "grok", "grok build", "grok-build": return Color(
            Theme.dynamic(light: 0x96_54_93, dark: 0xAA_64_B3)
        )
        default: return Theme.muted
        }
    }

    /// Repository rank colors for the Activity charts: the same five hues in
    /// leaderboard order, then muted repeats that stay distinguishable.
    static func repo(rank: Int) -> Color {
        switch rank % 10 {
        case 0: return provider("claude")
        case 1: return Color(Theme.dynamic(light: 0x8A_85_7B, dark: 0x8A_85_7B))
        case 2: return provider("opencode")
        case 3: return provider("cursor")
        case 4: return provider("grok")
        default: return Theme.muted.opacity(0.55 + 0.1 * Double(rank % 5))
        }
    }

    /// Contribution-grid green ramp. Desktop thresholds are absolute
    /// (`0/3/7/12` in `ActivityHeatmap.tsx`); five steps, same shape.
    static func heat(_ commits: Int) -> Color {
        switch commits {
        case 0: return Color(Theme.raisedColor)
        case 1...2: return Theme.sage.opacity(0.28)
        case 3...6: return Theme.sage.opacity(0.5)
        case 7...11: return Theme.sage.opacity(0.75)
        default: return Theme.sage
        }
    }
}
