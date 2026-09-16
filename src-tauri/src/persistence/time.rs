pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// `hours` before now, in the same wire format as [`now_iso`] — for a
/// range-scanned rolling window (an Arc's launches in the last day).
pub fn hours_ago(hours: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::hours(hours))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
