use std::fs;
use std::path::{Path, PathBuf};

use crate::util::workspace_paths::normalize;

use chrono::Utc;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_shell::ShellExt;

use super::inputs::*;
use super::live_database;
use super::validation::ThemeMode;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ide::detection::{detect_installed_ides, DetectedIde};
use crate::persistence::database::vacuum_database;
use crate::state::AppState;

const LIGHT_BG: tauri::utils::config::Color = tauri::utils::config::Color(251, 251, 250, 255);
const DARK_BG: tauri::utils::config::Color = tauri::utils::config::Color(14, 14, 12, 255);
// Purple "Nebula" canvas (#5c4187) so cold-start window matches the theme's --bg.
const PURPLE_BG: tauri::utils::config::Color = tauri::utils::config::Color(92, 65, 135, 255);

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SystemOk {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupPhaseRecord {
    pub phase: String,
    pub elapsed_ms: f64,
    pub delta_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IpcChannelStats {
    pub channel: String,
    pub count: usize,
    pub total_recorded: usize,
    pub p50: f64,
    pub p99: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RowCounts {
    pub projects: i64,
    pub workspaces: i64,
    pub sessions: i64,
    pub events: i64,
    pub raw_outputs: i64,
    pub approvals: i64,
    pub checks: i64,
    pub checkpoints: i64,
    pub learnings: i64,
    pub usage_events: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseStats {
    pub row_counts: RowCounts,
    pub wal_bytes: u64,
    pub wal_autocheckpoint: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePragmas {
    pub journal_mode: String,
    pub foreign_keys: i64,
    pub synchronous: i64,
    pub busy_timeout: i64,
    pub wal_autocheckpoint: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub rss_bytes: u64,
    pub open_file_descriptors: u64,
    pub tokio_tracked_tasks: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub scope: String,
    pub message: String,
    pub fields: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub app_version: String,
    pub electron_version: String,
    pub node_version: String,
    pub sqlite_version: String,
    pub database_path: String,
    pub platform: String,
    pub arch: String,
    pub generated_at: String,
    pub startup_phases: Vec<StartupPhaseRecord>,
    pub database_stats: DatabaseStats,
    pub ipc_stats: Vec<IpcChannelStats>,
    pub recent_logs: Vec<LogEntry>,
    pub sqlite_pragmas: SqlitePragmas,
    pub runtime: RuntimeDiagnostics,
}

#[tauri::command(rename = "system:open-path")]
#[specta::specta]
pub fn system_open_path(app: AppHandle, input: SystemOpenPathInput) -> ArgmaxResult<SystemOk> {
    let target = resolve_open_target(
        input.path.as_str(),
        input.cwd.as_ref().map(|cwd| cwd.as_str()),
    )?;

    #[allow(deprecated)]
    app.shell()
        .open(target.to_string_lossy().to_string(), None)
        .map_err(|error| ArgmaxError::service("OPEN_PATH_FAILED", error.to_string()))?;

    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "system:list-detected-ides")]
#[specta::specta]
pub async fn system_list_detected_ides(_input: SystemListDetectedIdesInput) -> Vec<DetectedIde> {
    detect_installed_ides().await
}

#[tauri::command(rename = "system:diagnostics")]
#[specta::specta]
pub fn system_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
    _input: SystemDiagnosticsInput,
) -> ArgmaxResult<DiagnosticsReport> {
    let database = live_database(&state)?;
    let database_path = database_path(&app)?;
    let connection = database.connection();
    let sqlite_version = connection
        .query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "unknown".to_string());
    let database_stats = collect_database_stats(&connection, &database_path);
    let sqlite_pragmas = collect_sqlite_pragmas(&connection);
    drop(connection);

    Ok(DiagnosticsReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        electron_version: String::new(),
        node_version: String::new(),
        sqlite_version,
        database_path: database_path.to_string_lossy().to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        startup_phases: startup_phases(&state),
        database_stats,
        ipc_stats: ipc_stats(),
        recent_logs: Vec::new(),
        sqlite_pragmas,
        runtime: RuntimeDiagnostics {
            rss_bytes: rss_bytes(),
            open_file_descriptors: open_file_descriptor_count(),
            tokio_tracked_tasks: database.prune_task_count() as u64,
        },
    })
}

#[tauri::command(rename = "system:vacuum-database")]
#[specta::specta]
pub async fn system_vacuum_database(
    state: State<'_, AppState>,
    _input: SystemVacuumDatabaseInput,
) -> ArgmaxResult<SystemOk> {
    let database = live_database(&state)?;
    vacuum_database(database).await?;
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "system:set-theme")]
#[specta::specta]
pub fn system_set_theme(app: AppHandle, input: SystemSetThemeInput) -> ArgmaxResult<SystemOk> {
    persist_theme(&app, input.mode)?;
    apply_theme(&app, input.mode)?;
    Ok(SystemOk { ok: true })
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> ArgmaxResult<PathBuf> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    Ok(app_data.join("local-state"))
}

fn database_path<R: Runtime>(app: &AppHandle<R>) -> ArgmaxResult<PathBuf> {
    Ok(data_dir(app)?.join("argmax.sqlite"))
}

fn resolve_open_target(path: &str, cwd: Option<&str>) -> ArgmaxResult<PathBuf> {
    let raw = PathBuf::from(path);

    let Some(cwd) = cwd else {
        // No cwd to contain against — nothing to validate.
        return Ok(raw);
    };

    let cwd_real = fs::canonicalize(cwd)
        .map_err(|error| ArgmaxError::service("OPEN_CWD_FAILED", error.to_string()))?;
    let candidate = if raw.is_absolute() {
        raw
    } else {
        cwd_real.join(&raw)
    };

    // Prefer realpath containment when the target exists (catches symlink
    // escapes). When it doesn't exist yet, fall back to *logical* normalization
    // so a non-existent escaping path (e.g. `../../etc/passwd`) is rejected
    // rather than returned unvalidated — closing the TOCTOU gap where the file
    // is created between this check and the open.
    let resolved = fs::canonicalize(&candidate).unwrap_or_else(|_| normalize(&candidate));
    if !resolved.starts_with(&cwd_real) {
        return Err(ArgmaxError::service(
            "OPEN_PATH_ESCAPES_CWD",
            "path escapes cwd",
        ));
    }
    Ok(resolved)
}

fn persist_theme<R: Runtime>(app: &AppHandle<R>, mode: ThemeMode) -> ArgmaxResult<()> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| ArgmaxError::service("APP_DATA_DIR", error.to_string()))?;
    fs::create_dir_all(&app_data)
        .map_err(|error| ArgmaxError::service("THEME_DIR", error.to_string()))?;
    let body = serde_json::to_vec(&ThemeCache {
        mode: theme_mode_str(mode),
    })
    .map_err(|error| ArgmaxError::service("THEME_SERIALIZE", error.to_string()))?;
    fs::write(app_data.join("theme.json"), body)
        .map_err(|error| ArgmaxError::service("THEME_WRITE", error.to_string()))
}

fn apply_theme<R: Runtime>(app: &AppHandle<R>, mode: ThemeMode) -> ArgmaxResult<()> {
    let theme = match mode {
        ThemeMode::Light => Some(tauri::Theme::Light),
        ThemeMode::Dark => Some(tauri::Theme::Dark),
        // Purple is a dark-family theme — keep the native window chrome dark.
        ThemeMode::Purple => Some(tauri::Theme::Dark),
        ThemeMode::System => None,
    };
    app.set_theme(theme);
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_theme(theme)
            .map_err(|error| ArgmaxError::service("THEME_APPLY", error.to_string()))?;
        let background = match mode {
            ThemeMode::System if matches!(window.theme().ok(), Some(tauri::Theme::Dark)) => DARK_BG,
            _ => background_for_mode(mode),
        };
        window
            .set_background_color(Some(background))
            .map_err(|error| ArgmaxError::service("THEME_BACKGROUND", error.to_string()))?;
    }
    Ok(())
}

fn background_for_mode(mode: ThemeMode) -> tauri::utils::config::Color {
    match mode {
        ThemeMode::Dark => DARK_BG,
        ThemeMode::Purple => PURPLE_BG,
        ThemeMode::Light | ThemeMode::System => LIGHT_BG,
    }
}

fn theme_mode_str(mode: ThemeMode) -> &'static str {
    match mode {
        ThemeMode::Light => "light",
        ThemeMode::Dark => "dark",
        ThemeMode::System => "system",
        ThemeMode::Purple => "purple",
    }
}

#[derive(Serialize)]
struct ThemeCache {
    mode: &'static str,
}

fn collect_database_stats(
    connection: &rusqlite::Connection,
    database_path: &Path,
) -> DatabaseStats {
    DatabaseStats {
        row_counts: RowCounts {
            projects: count_rows(connection, "projects"),
            workspaces: count_rows(connection, "workspaces"),
            sessions: count_rows(connection, "sessions"),
            events: count_rows(connection, "events"),
            raw_outputs: count_rows(connection, "raw_outputs"),
            approvals: count_rows(connection, "approvals"),
            checks: count_rows(connection, "checks"),
            checkpoints: count_rows(connection, "checkpoints"),
            learnings: count_rows(connection, "learnings"),
            usage_events: count_rows(connection, "usage_events"),
        },
        wal_bytes: fs::metadata(format!("{}-wal", database_path.to_string_lossy()))
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        wal_autocheckpoint: pragma_i64(connection, "wal_autocheckpoint"),
    }
}

fn collect_sqlite_pragmas(connection: &rusqlite::Connection) -> SqlitePragmas {
    SqlitePragmas {
        journal_mode: pragma_string(connection, "journal_mode"),
        foreign_keys: pragma_i64(connection, "foreign_keys"),
        synchronous: pragma_i64(connection, "synchronous"),
        busy_timeout: pragma_i64(connection, "busy_timeout"),
        wal_autocheckpoint: pragma_i64(connection, "wal_autocheckpoint"),
    }
}

fn count_rows(connection: &rusqlite::Connection, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn pragma_i64(connection: &rusqlite::Connection, name: &str) -> i64 {
    let sql = format!("PRAGMA {name}");
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

fn pragma_string(connection: &rusqlite::Connection, name: &str) -> String {
    let sql = format!("PRAGMA {name}");
    connection
        .query_row(&sql, [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn startup_phases(state: &State<'_, AppState>) -> Vec<StartupPhaseRecord> {
    let mut marks = vec![("boot".to_string(), 0.0)];
    marks.extend(
        state
            .startup_timer
            .snapshot()
            .into_iter()
            .map(|(phase, elapsed)| (phase.to_string(), elapsed as f64)),
    );
    marks.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut previous = 0.0;
    marks
        .into_iter()
        .map(|(phase, elapsed_ms)| {
            let delta_ms = elapsed_ms - previous;
            previous = elapsed_ms;
            StartupPhaseRecord {
                phase,
                elapsed_ms,
                delta_ms,
            }
        })
        .collect()
}

fn ipc_stats() -> Vec<IpcChannelStats> {
    let registry = match std::panic::catch_unwind(crate::util::tracing_init::ipc_latency) {
        Ok(registry) => registry,
        Err(_) => return Vec::new(),
    };
    let mut channels = registry.known_channels();
    channels.sort();
    channels
        .into_iter()
        .map(|channel| IpcChannelStats {
            p50: registry
                .p50(&channel)
                .map(|duration| duration.as_secs_f64() * 1000.0)
                .unwrap_or(0.0),
            p99: registry
                .p99(&channel)
                .map(|duration| duration.as_secs_f64() * 1000.0)
                .unwrap_or(0.0),
            count: registry.count(&channel),
            total_recorded: registry.total_recorded(&channel),
            channel,
        })
        .collect()
}

fn rss_bytes() -> u64 {
    #[cfg(target_os = "linux")]
    {
        let page_size = 4096_u64;
        if let Ok(statm) = fs::read_to_string("/proc/self/statm") {
            if let Some(rss_pages) = statm.split_whitespace().nth(1) {
                return rss_pages.parse::<u64>().unwrap_or(0) * page_size;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id().to_string();
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &pid])
            .output()
        {
            if output.status.success() {
                let kib = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
                return kib * 1024;
            }
        }
    }

    0
}

fn open_file_descriptor_count() -> u64 {
    #[cfg(target_os = "linux")]
    let fd_dir = "/proc/self/fd";
    #[cfg(target_os = "macos")]
    let fd_dir = "/dev/fd";

    fs::read_dir(fd_dir)
        .map(|entries| entries.count() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::Database;
    use tempfile::tempdir;

    #[test]
    fn resolve_open_target_rejects_existing_escape_when_cwd_is_scoped() {
        let cwd = tempdir().expect("cwd");
        let outside = tempdir().expect("outside");
        let escape = outside.path().join("escape.txt");
        fs::write(&escape, "nope").expect("write escape");

        let error = resolve_open_target(
            escape.to_str().expect("utf8 path"),
            Some(cwd.path().to_str().expect("utf8 cwd")),
        )
        .expect_err("escape rejected");

        assert!(error.to_string().contains("path escapes cwd"));
    }

    #[test]
    fn resolve_open_target_rejects_nonexistent_escape() {
        // The escaping target does not exist, so canonicalize fails; logical
        // normalization must still reject it instead of returning it raw.
        let cwd = tempdir().expect("cwd");
        let error = resolve_open_target("../../etc/does-not-exist-xyz", Some(cwd.path().to_str().unwrap()))
            .expect_err("nonexistent escape rejected");
        assert!(error.to_string().contains("path escapes cwd"));
    }

    #[test]
    fn database_stats_count_rows_and_pragmas() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        let stats = collect_database_stats(&connection, Path::new("/tmp/argmax.sqlite"));
        let pragmas = collect_sqlite_pragmas(&connection);

        assert_eq!(stats.row_counts.projects, 0);
        assert!(stats.wal_autocheckpoint > 0);
        assert_ne!(pragmas.journal_mode, "unknown");
    }

    #[test]
    fn theme_mode_strings_match_renderer_contract() {
        assert_eq!(theme_mode_str(ThemeMode::Light), "light");
        assert_eq!(theme_mode_str(ThemeMode::Dark), "dark");
        assert_eq!(theme_mode_str(ThemeMode::System), "system");
        assert_eq!(theme_mode_str(ThemeMode::Purple), "purple");
    }
}
