import SwiftUI

// What one Arc timeline row says, and how the rows fall into days. A port of
// `src/renderer/lib/arcTimeline.ts`; a change to one is a change to both.

struct ArcEventPresentation: Equatable {
    enum Glyph: Equatable {
        case symbol(String)
        case pullRequest
        case merged
    }

    enum Tone: Equatable {
        case accent, agent, success, danger, merged, notes, schedule, warning, quiet
    }

    /// The verb that leads the row: "Launched", "Checks failing".
    var verb: String
    /// What the verb is about, when there is something to name.
    var subject: String?
    var glyph: Glyph
    var tone: Tone
    /// A short fact after the line: a SHA, a line diff.
    var badge: String?
    /// Whether `detail` is someone's words (quoted) or a plain fact.
    var detailIsQuote = false
}

func presentArcEvent(_ event: ArcTimelineEvent) -> ArcEventPresentation {
    switch event.kind {
    case .created:
        return .init(verb: "Arc created", glyph: .symbol("flag"), tone: .accent)
    case .coordinatorStarted:
        return .init(verb: event.title, glyph: .symbol("safari"), tone: .accent)
    case .memberLaunched:
        return event.status == "adopted"
            ? .init(verb: "Joined", subject: event.title, glyph: .symbol("person.badge.plus"), tone: .agent)
            : .init(verb: "Launched", subject: event.title, glyph: .symbol("paperplane"), tone: .agent)
    case .memberFinished:
        switch event.status {
        case "failed":
            return .init(verb: "Failed", subject: event.title, glyph: .symbol("xmark.circle"), tone: .danger, detailIsQuote: true)
        case "cancelled":
            return .init(verb: "Stopped", subject: event.title, glyph: .symbol("nosign"), tone: .quiet, detailIsQuote: true)
        default:
            return .init(verb: "Finished", subject: event.title, glyph: .symbol("checkmark.circle"), tone: .success, detailIsQuote: true)
        }
    case .prChecksFailing:
        return .init(verb: "Checks failing", subject: prSubject(event), glyph: .pullRequest, tone: .danger, badge: event.status)
    case .prChecksPassing:
        return .init(verb: "Checks passing", subject: prSubject(event), glyph: .pullRequest, tone: .success, badge: event.status)
    case .prMerged:
        return .init(verb: "Merged", subject: prSubject(event), glyph: .merged, tone: .merged)
    case .notesUpdated:
        // The title is the first new line of NOTES.md, the coordinator's own
        // heading, so it reads as a quotation rather than a member's name.
        return .init(
            verb: "Notes updated",
            subject: event.title == "Notes updated" ? nil : "“\(event.title)”",
            glyph: .symbol("note.text"),
            tone: .notes,
            badge: event.status,
            detailIsQuote: true
        )
    case .briefUpdated:
        return .init(verb: "Brief edited", glyph: .symbol("doc.text"), tone: .quiet)
    case .stateChanged:
        switch event.status {
        case "paused": return .init(verb: event.title, glyph: .symbol("pause.circle"), tone: .warning)
        case "done": return .init(verb: event.title, glyph: .symbol("checkmark.square"), tone: .quiet)
        default: return .init(verb: event.title, glyph: .symbol("play.circle"), tone: .quiet)
        }
    case .scheduledRun:
        return .init(verb: "Scheduled run", subject: event.title, glyph: .symbol("clock"), tone: .schedule)
    case .unknown:
        return .init(verb: event.title, glyph: .symbol("circle"), tone: .quiet)
    }
}

private func prSubject(_ event: ArcTimelineEvent) -> String {
    guard let number = event.prNumber else { return event.title }
    return "#\(number) \(event.title)"
}

/// Member and pull request rows can sit in any of the arc's projects, so they
/// say which; the arc's own events never move.
func arcEventShowsProject(_ event: ArcTimelineEvent) -> Bool {
    switch event.kind {
    case .memberLaunched, .memberFinished, .prChecksFailing, .prChecksPassing, .prMerged: return true
    default: return false
    }
}

struct ArcTimelineDay: Identifiable, Equatable {
    var id: String
    var label: String
    var events: [ArcTimelineEvent]
}

/// Newest-first events grouped by local calendar day: Today, Yesterday, then
/// the weekday and date, with the year only when it is not this one.
func groupArcTimelineByDay(
    _ events: [ArcTimelineEvent],
    now: Date = .now,
    calendar: Calendar = .current
) -> [ArcTimelineDay] {
    var days: [ArcTimelineDay] = []
    for event in events {
        let when = parseWireTimestamp(event.occurredAt)
        let key = when.map { date in
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
        } ?? "unknown"
        if days.last?.id == key {
            days[days.count - 1].events.append(event)
        } else {
            days.append(ArcTimelineDay(id: key, label: arcDayLabel(when, now: now, calendar: calendar), events: [event]))
        }
    }
    return days
}

private func arcDayLabel(_ date: Date?, now: Date, calendar: Calendar) -> String {
    guard let date else { return "Earlier" }
    if calendar.isDate(date, inSameDayAs: now) { return "Today" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
        return "Yesterday"
    }
    var style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).weekday(.wide).month(.abbreviated).day()
    if calendar.component(.year, from: date) != calendar.component(.year, from: now) {
        style = style.year()
    }
    return date.formatted(style)
}

extension ArcEventPresentation.Tone {
    func color(accent: Color) -> Color {
        switch self {
        case .accent: return accent
        case .agent: return Color(Theme.activityBlueColor)
        case .success: return Theme.sage
        case .danger: return Theme.rose
        case .merged: return Theme.violet
        case .notes: return Color(Theme.activityCoralColor)
        case .schedule: return Color(Theme.activityGoldColor)
        case .warning: return Theme.amber
        case .quiet: return Theme.mutedStrong
        }
    }
}
