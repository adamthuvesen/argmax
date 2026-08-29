// Settings → Remote access: pairing status, config writes, and the ntfy test
// push. Desktop-only channels (they need the AppHandle for the app data dir
// and the server lifecycle), so all three sit in REMOTE_UNSUPPORTED_CHANNELS.

use std::time::Duration;

use qrcode::render::svg;
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use super::inputs::*;
use super::system::SystemOk;
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::remote::{self, RemoteConfig};
use crate::state::AppState;

const TAILSCALE_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// Candidate CLI locations: PATH first, then the Homebrew symlink target and
/// the app-bundle binary the macOS App Store build ships.
const TAILSCALE_BINARIES: &[&str] = &[
    "tailscale",
    "/usr/local/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    /// True while the bridge's server task is actually alive — stays false
    /// when enabling failed (typically a port already in use).
    pub serving: bool,
    pub port: u16,
    pub token: String,
    pub ntfy_topic: Option<String>,
    pub local_url: String,
    /// Reachable from the phone once `tailscale serve` proxies the port.
    /// Absent when the Tailscale CLI is not installed.
    pub tailnet_url: Option<String>,
    pub tailscale_running: bool,
    /// The URL the QR code encodes: tailnet when known, loopback otherwise,
    /// with the token in the fragment (never sent over the wire).
    pub pairing_url: String,
    pub qr_svg: String,
    pub serve_command: String,
}

#[tauri::command(rename = "remote:get-status", async)]
#[specta::specta]
pub async fn remote_get_status(
    app: AppHandle,
    state: State<'_, AppState>,
    _input: RemoteGetStatusInput,
) -> ArgmaxResult<RemoteStatus> {
    let config = read_config(&app)?;
    build_status(&state, config).await
}

#[tauri::command(rename = "remote:set-config", async)]
#[specta::specta]
pub async fn remote_set_config(
    app: AppHandle,
    state: State<'_, AppState>,
    input: RemoteSetConfigInput,
) -> ArgmaxResult<RemoteStatus> {
    if input.port < 1024 {
        return Err(invalid("port", "PORT_RESERVED", "port must be 1024–65535"));
    }
    let ntfy_topic = normalize_ntfy_topic(&input.ntfy_topic)?;

    let app_data_dir = require_app_data_dir(&app)?;
    let config = RemoteConfig {
        enabled: input.enabled,
        port: input.port,
        // The token survives every settings change; rotation would strand the
        // paired phone.
        token: remote::load_or_create_config(&app_data_dir).token,
        ntfy_topic,
    };
    remote::save_config(&app_data_dir, &config)?;
    remote::apply(&app, config.clone());

    // A failed bind surfaces as serving=false in the response; give the
    // spawned server a beat to bind before reporting.
    if config.enabled {
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    build_status(&state, config).await
}

#[tauri::command(rename = "remote:test-notification", async)]
#[specta::specta]
pub async fn remote_test_notification(
    app: AppHandle,
    _input: RemoteTestNotificationInput,
) -> ArgmaxResult<SystemOk> {
    let config = read_config(&app)?;
    let Some(topic_url) = config.ntfy_topic else {
        return Err(invalid(
            "ntfyTopic",
            "NTFY_TOPIC_MISSING",
            "set an ntfy topic before sending a test notification",
        ));
    };
    tauri::async_runtime::spawn_blocking(move || crate::remote::ntfy::post_test(&topic_url))
        .await
        .map_err(|error| ArgmaxError::service("NTFY_TEST_JOIN", error.to_string()))?
        .map_err(|error| ArgmaxError::service("NTFY_TEST_FAILED", error))?;
    Ok(SystemOk { ok: true })
}

fn read_config(app: &AppHandle) -> ArgmaxResult<RemoteConfig> {
    Ok(remote::load_or_create_config(&require_app_data_dir(app)?))
}

fn require_app_data_dir(app: &AppHandle) -> ArgmaxResult<std::path::PathBuf> {
    remote::ensure_app_data_dir(app)
        .ok_or_else(|| ArgmaxError::service("APP_DATA_DIR", "app data dir unavailable"))
}

async fn build_status(state: &AppState, config: RemoteConfig) -> ArgmaxResult<RemoteStatus> {
    let tailscale = probe_tailscale().await;
    let local_url = format!("http://127.0.0.1:{}/mobile.html", config.port);
    let tailnet_url = tailscale
        .as_ref()
        .map(|probe| format!("http://{}:{}/mobile.html", probe.dns_name, config.port));
    let pairing_url = format!(
        "{}#token={}",
        tailnet_url.as_deref().unwrap_or(&local_url),
        config.token
    );
    let qr_svg = render_qr_svg(&pairing_url)?;

    Ok(RemoteStatus {
        enabled: config.enabled,
        serving: remote::is_serving(state),
        port: config.port,
        token: config.token,
        ntfy_topic: config.ntfy_topic,
        local_url,
        tailnet_url,
        tailscale_running: tailscale.is_some_and(|probe| probe.running),
        pairing_url,
        qr_svg,
        serve_command: format!(
            "tailscale serve --http={port} --bg {port}",
            port = config.port
        ),
    })
}

/// SVG with `currentColor` modules on a transparent ground, so the Settings
/// panel colors it with the theme's text token.
fn render_qr_svg(pairing_url: &str) -> ArgmaxResult<String> {
    let code = QrCode::new(pairing_url.as_bytes())
        .map_err(|error| ArgmaxError::service("QR_ENCODE", error.to_string()))?;
    Ok(code
        .render::<svg::Color>()
        .quiet_zone(false)
        .min_dimensions(220, 220)
        .dark_color(svg::Color("currentColor"))
        .light_color(svg::Color("transparent"))
        .build())
}

/// '' clears push. A full http(s) URL is kept verbatim; a bare topic name is
/// expanded to ntfy.sh. Anything else is rejected rather than guessed at.
fn normalize_ntfy_topic(raw: &str) -> ArgmaxResult<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        if trimmed.chars().any(char::is_whitespace) {
            return Err(invalid(
                "ntfyTopic",
                "NTFY_TOPIC_INVALID",
                "topic URL must not contain whitespace",
            ));
        }
        return Ok(Some(trimmed.to_string()));
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Ok(Some(format!("https://ntfy.sh/{trimmed}")));
    }
    Err(invalid(
        "ntfyTopic",
        "NTFY_TOPIC_INVALID",
        "use a bare topic name (letters, digits, - or _) or a full https:// topic URL",
    ))
}

fn invalid(field: &str, code: &'static str, message: &str) -> ArgmaxError {
    ArgmaxError::invalid(InvalidInputIssue::at(
        vec!["input".to_string(), field.to_string()],
        code,
        message,
    ))
}

struct TailscaleProbe {
    dns_name: String,
    running: bool,
}

#[derive(Deserialize)]
struct TailscaleStatusJson {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: TailscaleSelfJson,
}

#[derive(Deserialize)]
struct TailscaleSelfJson {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

async fn probe_tailscale() -> Option<TailscaleProbe> {
    for binary in TAILSCALE_BINARIES {
        let output = tokio::time::timeout(
            TAILSCALE_PROBE_TIMEOUT,
            tokio::process::Command::new(binary)
                .args(["status", "--json"])
                .output(),
        )
        .await;
        let Ok(Ok(output)) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let Ok(status) = serde_json::from_slice::<TailscaleStatusJson>(&output.stdout) else {
            continue;
        };
        let dns_name = status.self_node.dns_name.trim_end_matches('.').to_string();
        if dns_name.is_empty() {
            continue;
        }
        return Some(TailscaleProbe {
            dns_name,
            running: status.backend_state == "Running",
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_topic_names_expand_to_ntfy_sh() {
        assert_eq!(
            normalize_ntfy_topic("argmax-adam_1").expect("valid"),
            Some("https://ntfy.sh/argmax-adam_1".to_string())
        );
    }

    #[test]
    fn urls_pass_through_and_empty_clears() {
        assert_eq!(
            normalize_ntfy_topic(" https://ntfy.example.com/mine ").expect("valid"),
            Some("https://ntfy.example.com/mine".to_string())
        );
        assert_eq!(normalize_ntfy_topic("   ").expect("valid"), None);
    }

    #[test]
    fn malformed_topics_are_rejected() {
        assert!(normalize_ntfy_topic("has space").is_err());
        assert!(normalize_ntfy_topic("https://ntfy.sh/a b").is_err());
        assert!(normalize_ntfy_topic("topic/with/slash").is_err());
    }

    #[test]
    fn qr_svg_renders_current_color_modules() {
        let svg = render_qr_svg("http://example.test/mobile.html#token=abc").expect("svg");
        assert!(svg.starts_with("<?xml"));
        assert!(svg.contains("currentColor"));
    }
}
