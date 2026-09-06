//! Shared window math: remaining % from used %, labels from duration.

use chrono::{TimeZone, Utc};

pub fn remaining_from_used(used: f64) -> f64 {
    if !used.is_finite() {
        return 0.0;
    }
    (100.0 - used).clamp(0.0, 100.0)
}

/// ~5 hours → 5-hour, ~7 days → Weekly, otherwise Monthly.
pub fn window_label_for_minutes(minutes: Option<i64>) -> &'static str {
    match minutes {
        Some(m) if m > 0 && m <= 12 * 60 => "5-hour",
        Some(m) if m > 0 && m <= 10 * 24 * 60 => "Weekly",
        Some(m) if m > 0 => "Monthly",
        _ => "Window",
    }
}

pub fn window_id_for_minutes(minutes: Option<i64>) -> &'static str {
    match minutes {
        Some(m) if m > 0 && m <= 12 * 60 => "five_hour",
        Some(m) if m > 0 && m <= 10 * 24 * 60 => "seven_day",
        Some(m) if m > 0 => "monthly",
        _ => "window",
    }
}

pub fn resets_at_from_epoch(value: &serde_json::Value) -> Option<String> {
    let secs = if let Some(n) = value.as_i64() {
        n
    } else if let Some(n) = value.as_f64() {
        n as i64
    } else if let Some(s) = value.as_str() {
        s.parse::<i64>().ok()?
    } else {
        return None;
    };
    // Milliseconds if it looks like one.
    let secs = if secs > 10_000_000_000 {
        secs / 1000
    } else {
        secs
    };
    Utc.timestamp_opt(secs, 0)
        .single()
        .map(|at| at.to_rfc3339())
}

pub fn resets_at_from_iso(value: &serde_json::Value) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|at| at.with_timezone(&Utc).to_rfc3339())
        .or_else(|| Some(text.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn remaining_clamps() {
        assert_eq!(remaining_from_used(12.0), 88.0);
        assert_eq!(remaining_from_used(0.0), 100.0);
        assert_eq!(remaining_from_used(100.0), 0.0);
        assert_eq!(remaining_from_used(140.0), 0.0);
    }

    #[test]
    fn labels_follow_duration_not_a_hardcoded_five_hours() {
        assert_eq!(window_label_for_minutes(Some(300)), "5-hour");
        assert_eq!(window_id_for_minutes(Some(300)), "five_hour");
        assert_eq!(window_label_for_minutes(Some(10_080)), "Weekly");
        assert_eq!(window_id_for_minutes(Some(10_080)), "seven_day");
        assert_eq!(window_label_for_minutes(Some(43_200)), "Monthly");
    }

    #[test]
    fn epoch_and_iso_reset_times() {
        let iso = resets_at_from_epoch(&json!(1_789_278_487)).expect("epoch");
        assert!(iso.starts_with("2026-"));
        let from_iso = resets_at_from_iso(&json!("2026-09-06T16:00:00Z")).expect("iso");
        assert!(from_iso.contains("2026-09-06"));
    }
}
