import Foundation

struct ChatDateGroup: Identifiable, Equatable {
    var id: String
    var label: String
    var rows: [ChatRow]
}

/// The desktop session list's local-calendar buckets, newest first.
func groupChatsByDate(_ rows: [ChatRow], now: Date, calendar: Calendar = .current) -> [ChatDateGroup] {
    var groups = [
        ChatDateGroup(id: "today", label: "Today", rows: []),
        ChatDateGroup(id: "yesterday", label: "Yesterday", rows: []),
        ChatDateGroup(id: "last-7", label: "Last 7 Days", rows: []),
        ChatDateGroup(id: "older", label: "Older", rows: [])
    ]
    let today = calendar.startOfDay(for: now)
    for row in rows.sorted(by: { $0.workspace.lastActivityAt > $1.workspace.lastActivityAt }) {
        let activity = parseWireTimestamp(row.workspace.lastActivityAt) ?? now
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: activity), to: today).day ?? 0
        let index = days <= 0 ? 0 : days == 1 ? 1 : days <= 7 ? 2 : 3
        groups[index].rows.append(row)
    }
    return groups.filter { !$0.rows.isEmpty }
}
