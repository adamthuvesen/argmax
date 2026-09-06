//! Codex remaining usage via `codex app-server`, falling back to the newest
//! `rate_limits` snapshot in a local rollout.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::{json, Value};

use crate::ipc::validation::ProviderId;
use crate::providers::environment::build_provider_environment;

use super::{
    remaining_from_used, resets_at_from_epoch, window_id_for_minutes, window_label_for_minutes,
    RemainingSource, UsageLimitWindow, UsageProviderRemaining,
};

const APP_SERVER_TIMEOUT: Duration = Duration::from_secs(8);
const JSONL_TAIL_BYTES: u64 = 256 * 1024;

pub fn fetch(source: &dyn RemainingSource) -> UsageProviderRemaining {
    if let Ok(body) = source.codex_rate_limits() {
        return row_from_snapshot(&body, None);
    }
    if let Some(body) = last_jsonl_rate_limits(source.home()) {
        return row_from_snapshot(&body, Some("From the last Codex session."));
    }
    if api_key_mode(source.home()) {
        return UsageProviderRemaining::api_key(ProviderId::Codex);
    }
    UsageProviderRemaining::unavailable(
        ProviderId::Codex,
        "Sign in with the Codex CLI to see remaining usage.",
    )
}

pub fn fetch_app_server_rate_limits(home: &Path) -> Result<Value, String> {
    let environment = build_provider_environment(Vec::<(String, String)>::new());
    let mut command = Command::new("codex");
    command
        .args(["app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    for (key, value) in &environment {
        command.env(key, value);
    }
    command.env("HOME", home);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| -> Result<Value, String> {
            let mut stdin = stdin.ok_or_else(|| "no stdin".to_string())?;
            let mut stdout = stdout.ok_or_else(|| "no stdout".to_string())?;
            use std::io::Write;
            writeln!(
                stdin,
                "{}",
                json!({
                    "method": "initialize",
                    "id": 0,
                    "params": {
                        "clientInfo": {
                            "name": "argmax",
                            "title": "Argmax",
                            "version": env!("CARGO_PKG_VERSION")
                        }
                    }
                })
            )
            .map_err(|error| error.to_string())?;
            let init = read_jsonrpc_result(&mut stdout, 0)?;
            if init.get("error").is_some() {
                return Err("initialize failed".into());
            }
            writeln!(stdin, "{}", json!({ "method": "initialized" }))
                .map_err(|error| error.to_string())?;
            writeln!(
                stdin,
                "{}",
                json!({ "method": "account/rateLimits/read", "id": 1 })
            )
            .map_err(|error| error.to_string())?;
            read_jsonrpc_result(&mut stdout, 1)
        })();
        let _ = tx.send(result);
    });
    let result = match rx.recv_timeout(APP_SERVER_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out waiting for Codex app-server".into());
        }
    };
    let _ = child.kill();
    let _ = child.wait();
    let payload = result?;
    if let Some(error) = payload.get("error") {
        return Err(error.to_string());
    }
    payload
        .get("result")
        .cloned()
        .ok_or_else(|| "no result".into())
}

fn read_jsonrpc_result(stdout: &mut impl Read, id: i64) -> Result<Value, String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdout.read(&mut byte) {
            Ok(0) => return Err("Codex app-server closed".into()),
            Ok(_) => {
                if byte[0] == b'\n' {
                    if buf.is_empty() {
                        continue;
                    }
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    buf.clear();
                    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                        continue;
                    };
                    if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
                        return Ok(value);
                    }
                } else {
                    buf.push(byte[0]);
                    if buf.len() > 1_000_000 {
                        return Err("Codex app-server line too long".into());
                    }
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn row_from_snapshot(body: &Value, stale_note: Option<&str>) -> UsageProviderRemaining {
    let snapshot = body
        .get("rateLimits")
        .or_else(|| body.get("rate_limits"))
        .unwrap_or(body);
    let plan = snapshot
        .get("planType")
        .or_else(|| snapshot.get("plan_type"))
        .or_else(|| body.get("planType"))
        .or_else(|| body.get("plan_type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if is_enterprise_plan(plan) || credits_unlimited(snapshot) {
        return UsageProviderRemaining::enterprise(ProviderId::Codex, "Enterprise");
    }
    if plan.eq_ignore_ascii_case("apikey") || plan.eq_ignore_ascii_case("api_key") {
        return UsageProviderRemaining::api_key(ProviderId::Codex);
    }
    let windows = windows_from_snapshot(snapshot);
    if windows.is_empty() {
        return UsageProviderRemaining::unavailable(
            ProviderId::Codex,
            "Codex did not report a remaining-usage window.",
        );
    }
    let mut row =
        UsageProviderRemaining::subscription(ProviderId::Codex, plan_label(plan), windows);
    if let Some(note) = stale_note {
        row.message = Some(note.to_string());
    }
    row
}

fn is_enterprise_plan(plan: &str) -> bool {
    let plan = plan.to_ascii_lowercase();
    plan.contains("enterprise") || plan == "ent26" || plan.starts_with("edu")
}

fn credits_unlimited(snapshot: &Value) -> bool {
    snapshot
        .get("credits")
        .and_then(|credits| credits.get("unlimited"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn plan_label(plan: &str) -> Option<String> {
    if plan.is_empty() {
        return None;
    }
    Some(match plan.to_ascii_lowercase().as_str() {
        "plus" => "Plus".into(),
        "pro" => "Pro".into(),
        "prolite" => "Pro".into(),
        "team" => "Team".into(),
        "business" => "Business".into(),
        "go" => "Go".into(),
        "free" => "Free".into(),
        other => other.replace('_', " "),
    })
}

fn windows_from_snapshot(snapshot: &Value) -> Vec<UsageLimitWindow> {
    let mut windows = Vec::new();
    push_window(&mut windows, snapshot.get("primary"), "primary");
    push_window(
        &mut windows,
        snapshot
            .get("secondary")
            .or_else(|| snapshot.get("secondary_window")),
        "secondary",
    );
    if windows.is_empty() {
        push_window(&mut windows, snapshot.get("primary_window"), "primary");
    }
    windows
}

fn push_window(windows: &mut Vec<UsageLimitWindow>, raw: Option<&Value>, fallback_id: &str) {
    let Some(raw) = raw else {
        return;
    };
    if raw.is_null() {
        return;
    }
    let used = raw
        .get("usedPercent")
        .or_else(|| raw.get("used_percent"))
        .and_then(|v| v.as_f64());
    let Some(used) = used else {
        return;
    };
    let minutes = raw
        .get("windowDurationMins")
        .or_else(|| raw.get("window_minutes"))
        .and_then(json_i64)
        .or_else(|| {
            raw.get("limit_window_seconds")
                .and_then(json_i64)
                .map(|secs| secs / 60)
        });
    let resets = raw
        .get("resetsAt")
        .or_else(|| raw.get("resets_at"))
        .and_then(resets_at_from_epoch);
    windows.push(UsageLimitWindow {
        id: window_id_for_minutes(minutes).to_string(),
        label: if minutes.is_some() {
            window_label_for_minutes(minutes).to_string()
        } else {
            fallback_id.to_string()
        },
        remaining_percent: remaining_from_used(used),
        resets_at: resets,
    });
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|n| n as i64))
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
}

fn last_jsonl_rate_limits(home: &Path) -> Option<Value> {
    let mut files = rollout_files(home);
    files.sort_by_key(|path| std::cmp::Reverse(mtime(path)));
    for path in files.into_iter().take(5) {
        if let Some(found) = scan_file_for_rate_limits(&path) {
            return Some(found);
        }
    }
    None
}

fn rollout_files(home: &Path) -> Vec<PathBuf> {
    let root = home.join(".codex/sessions");
    let mut files = Vec::new();
    let Ok(years) = fs::read_dir(&root) else {
        return files;
    };
    for year in years.flatten() {
        let Ok(months) = fs::read_dir(year.path()) else {
            continue;
        };
        for month in months.flatten() {
            let Ok(days) = fs::read_dir(month.path()) else {
                continue;
            };
            for day in days.flatten() {
                let Ok(entries) = fs::read_dir(day.path()) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                        files.push(path);
                    }
                }
            }
        }
    }
    files
}

fn mtime(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn scan_file_for_rate_limits(path: &Path) -> Option<Value> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    if len > JSONL_TAIL_BYTES {
        file.seek(SeekFrom::End(-(JSONL_TAIL_BYTES as i64))).ok()?;
    }
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    let mut last = None;
    for line in buf.lines() {
        if !line.contains("rate_limits") && !line.contains("rateLimits") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(found) = find_rate_limits(&value) {
            last = Some(found);
        }
    }
    last
}

fn find_rate_limits(value: &Value) -> Option<Value> {
    match value {
        Value::Object(map) => {
            if let Some(limits) = map.get("rate_limits").or_else(|| map.get("rateLimits")) {
                if limits.is_object() {
                    return Some(limits.clone());
                }
            }
            if let Some(payload) = map.get("payload") {
                if let Some(found) = find_rate_limits(payload) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn api_key_mode(home: &Path) -> bool {
    let text = fs::read_to_string(home.join(".codex/auth.json")).ok();
    let Some(text) = text else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    json.get("auth_mode")
        .and_then(|v| v.as_str())
        .is_some_and(|mode| mode.eq_ignore_ascii_case("apikey"))
        && json.get("tokens").is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::remaining::tests::FakeSource;
    use crate::usage::remaining::UsagePlanKind;
    use serde_json::json;

    #[test]
    fn weekly_only_primary_is_weekly_not_five_hour() {
        let snapshot = json!({
            "planType": "pro",
            "primary": { "usedPercent": 12.0, "windowDurationMins": 10080, "resetsAt": 1789278487 },
            "secondary": null,
            "credits": { "hasCredits": false, "unlimited": false }
        });
        let row = row_from_snapshot(&snapshot, None);
        assert_eq!(row.kind, UsagePlanKind::Subscription);
        assert_eq!(row.plan_label.as_deref(), Some("Pro"));
        assert_eq!(row.windows.len(), 1);
        assert_eq!(row.windows[0].label, "Weekly");
        assert!((row.windows[0].remaining_percent - 88.0).abs() < 0.01);
    }

    #[test]
    fn enterprise_plan_has_no_windows() {
        let snapshot = json!({
            "planType": "enterprise",
            "primary": { "usedPercent": 10.0, "windowDurationMins": 300 },
            "credits": { "unlimited": true }
        });
        let row = row_from_snapshot(&snapshot, None);
        assert_eq!(row.kind, UsagePlanKind::Enterprise);
        assert!(row.windows.is_empty());
    }

    #[test]
    fn jsonl_fallback_is_labeled_stale() {
        let dir = tempfile::tempdir().expect("temp");
        let day = dir.path().join(".codex/sessions/2026/09/06");
        std::fs::create_dir_all(&day).expect("dir");
        std::fs::write(
            day.join("rollout-2026-09-06T11-00-00-abc.jsonl"),
            r#"{"payload":{"rate_limits":{"plan_type":"pro","primary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1789278487},"secondary":null}}}"#,
        )
        .expect("jsonl");
        let source = FakeSource::new(dir.path().to_path_buf());
        let row = fetch(&source);
        assert_eq!(row.kind, UsagePlanKind::Subscription);
        assert_eq!(row.message.as_deref(), Some("From the last Codex session."));
        assert_eq!(row.windows[0].label, "Weekly");
    }
}
