//! Schedule parsing and next-occurrence math for scheduled tasks.
//!
//! Two schedule shapes are stored per routine, exactly one of them set:
//! a 6-field cron expression (the `cron` crate dialect: sec min hour dom
//! month dow [year], which the renderer generates from its friendly
//! controls) or a one-shot RFC 3339 timestamp. All persisted timestamps
//! are normalized to UTC millis so the lexicographic `next_run_at <= now`
//! comparison in `due_routines` stays correct.

use std::str::FromStr;

use chrono::{DateTime, Local, NaiveDateTime, SecondsFormat, TimeZone, Utc};
use cron::Schedule;

use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};

/// How long a failed recurring routine waits before its next attempt. A
/// one-shot never retries: it is marked disabled with the error surfaced.
const RETRY_BACKOFF_MINUTES: i64 = 15;

pub fn validate_schedule(cron_expr: Option<&str>, run_once_at: Option<&str>) -> ArgmaxResult<()> {
    match (cron_expr, run_once_at) {
        (Some(cron), None) => parse_cron(cron).map(|_| ()),
        (None, Some(_)) => Ok(()),
        (Some(_), Some(_)) => Err(schedule_issue(
            "SCHEDULE_BOTH",
            "provide either a cron expression or a one-shot time, not both",
        )),
        (None, None) => Err(schedule_issue(
            "SCHEDULE_MISSING",
            "provide a cron expression or a one-shot time",
        )),
    }
}

/// The next occurrence strictly after `after`. For a cron schedule this is
/// the next future match; for a one-shot it is the stored time only while
/// still in the future. Overdue occurrences therefore collapse into a
/// single late run instead of replaying every missed tick.
pub fn next_occurrence(
    cron_expr: Option<&str>,
    run_once_at: Option<&str>,
    after: DateTime<Utc>,
) -> ArgmaxResult<Option<DateTime<Utc>>> {
    match (cron_expr, run_once_at) {
        (Some(cron), _) => Ok(parse_cron(cron)?.after(&after).next()),
        (None, Some(at)) => Ok(parse_once_at(at)?.and_then(|time| (time > after).then_some(time))),
        (None, None) => Err(schedule_issue(
            "SCHEDULE_MISSING",
            "routine has no schedule",
        )),
    }
}

/// Normalizes a one-shot input to the canonical UTC millis format. Accepts
/// an RFC 3339 timestamp or a naive local `datetime-local` value (what the
/// renderer's `<input type="datetime-local">` produces), which is
/// interpreted in the user's local timezone.
pub fn normalize_once_input(value: &str) -> ArgmaxResult<String> {
    let time = if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        parsed.with_timezone(&Utc)
    } else if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        Local
            .from_local_datetime(&naive)
            .earliest()
            .ok_or_else(|| {
                schedule_issue(
                    "SCHEDULE_INVALID",
                    "time does not exist in the local timezone",
                )
            })?
            .with_timezone(&Utc)
    } else if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M") {
        Local
            .from_local_datetime(&naive)
            .earliest()
            .ok_or_else(|| {
                schedule_issue(
                    "SCHEDULE_INVALID",
                    "time does not exist in the local timezone",
                )
            })?
            .with_timezone(&Utc)
    } else {
        return Err(schedule_issue(
            "SCHEDULE_INVALID",
            "one-shot time must be an RFC 3339 timestamp or a local datetime",
        ));
    };
    Ok(format_rfc3339(time))
}

pub fn retry_after(now: DateTime<Utc>) -> DateTime<Utc> {
    now + chrono::Duration::minutes(RETRY_BACKOFF_MINUTES)
}

pub fn format_rfc3339(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn parse_cron(cron_expr: &str) -> ArgmaxResult<Schedule> {
    Schedule::from_str(cron_expr).map_err(|_| {
        schedule_issue(
            "SCHEDULE_INVALID",
            "not a valid cron expression (expected: sec min hour day month weekday)",
        )
    })
}

fn parse_once_at(value: &str) -> ArgmaxResult<Option<DateTime<Utc>>> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| Some(time.with_timezone(&Utc)))
        .map_err(|_| schedule_issue("SCHEDULE_INVALID", "one-shot time is not a valid timestamp"))
}

fn schedule_issue(code: &'static str, message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["schedule".into()],
        code,
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn utc(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs, 0).unwrap()
    }

    #[test]
    fn exactly_one_schedule_shape_is_accepted() {
        assert!(validate_schedule(Some("0 0 9 * * *"), None).is_ok());
        assert!(validate_schedule(None, Some("2026-08-30T09:00:00.000Z")).is_ok());
        assert!(validate_schedule(None, None).is_err());
        assert!(validate_schedule(Some("0 0 9 * * *"), Some("2026-08-30T09:00:00.000Z")).is_err());
    }

    #[test]
    fn invalid_cron_is_rejected() {
        assert!(validate_schedule(Some("not a cron"), None).is_err());
        assert!(validate_schedule(Some("99 99 99 * * *"), None).is_err());
    }

    #[test]
    fn cron_next_occurrence_is_strictly_after() {
        let next = next_occurrence(Some("0 0 9 * * *"), None, utc(1000)).unwrap();
        let next = next.expect("daily 9am always has a next occurrence");
        assert!(next > utc(1000));
    }

    #[test]
    fn overdue_one_shot_collapses_to_none() {
        let past = utc(1000);
        let stored = "1970-01-01T00:16:40.000Z";
        assert_eq!(next_occurrence(None, Some(stored), past).unwrap(), None);
        let future = "2030-01-01T00:00:00.000Z";
        assert_eq!(
            next_occurrence(None, Some(future), past).unwrap(),
            Some(utc(1893456000))
        );
    }

    #[test]
    fn naive_local_input_is_normalized_to_utc_millis() {
        let normalized = normalize_once_input("2026-08-30T09:00").unwrap();
        assert!(normalized.ends_with(".000Z"));
        assert!(DateTime::parse_from_rfc3339(&normalized).is_ok());
        assert!(normalize_once_input("not a time").is_err());
    }
}
