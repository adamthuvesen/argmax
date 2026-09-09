// Settings → Remote access: pairing status, config writes, and the ntfy test
// push. Desktop-only channels (they need the AppHandle for the app data dir
// and the server lifecycle), so all three sit in REMOTE_UNSUPPORTED_CHANNELS.

use std::collections::HashMap;
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
        // Persisted so the ntfy publisher can deep-link at boot, where the
        // async tailnet probe is out of reach. Saving Settings is what keeps it
        // current after the tailnet name changes.
        mobile_url: Some(mobile_page_url(
            probe_tailscale().await.as_ref(),
            input.port,
            probe_serve_tls_port(input.port).await,
        )),
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

/// The mobile page as the phone reaches it: over the tailnet when Tailscale is
/// up, else loopback. One definition so the pairing QR, the Settings links, and
/// the ntfy deep link can never point somewhere different from each other.
fn mobile_page_url(
    tailscale: Option<&TailscaleProbe>,
    port: u16,
    serve_tls_port: Option<u16>,
) -> String {
    match (tailscale, serve_tls_port) {
        // 443 needs no port in the URL, and leaving it off is what keeps the
        // pairing link short enough to read off a QR code.
        (Some(probe), Some(443)) => format!("https://{}/mobile.html", probe.dns_name),
        (Some(probe), Some(tls)) => format!("https://{}:{}/mobile.html", probe.dns_name, tls),
        (Some(probe), None) => format!("http://{}:{}/mobile.html", probe.dns_name, port),
        (None, _) => format!("http://127.0.0.1:{port}/mobile.html"),
    }
}

async fn build_status(state: &AppState, config: RemoteConfig) -> ArgmaxResult<RemoteStatus> {
    let tailscale = probe_tailscale().await;
    let tls_port = if tailscale.is_some() {
        probe_serve_tls_port(config.port).await
    } else {
        None
    };
    let local_url = mobile_page_url(None, config.port, None);
    let tailnet_url = tailscale
        .as_ref()
        .map(|probe| mobile_page_url(Some(probe), config.port, tls_port));
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

#[derive(Deserialize)]
struct ServeStatusJson {
    #[serde(rename = "TCP", default)]
    tcp: HashMap<String, ServeTcpJson>,
    #[serde(rename = "Web", default)]
    web: HashMap<String, ServeWebJson>,
}

#[derive(Deserialize)]
struct ServeTcpJson {
    #[serde(rename = "HTTPS", default)]
    https: bool,
}

#[derive(Deserialize)]
struct ServeWebJson {
    #[serde(rename = "Handlers", default)]
    handlers: HashMap<String, ServeHandlerJson>,
}

#[derive(Deserialize)]
struct ServeHandlerJson {
    #[serde(rename = "Proxy", default)]
    proxy: Option<String>,
}

/// The port Tailscale Serve terminates TLS on for this bridge, if it does.
///
/// A tailnet can carry both spellings at once — `tailscale serve --http=8790`
/// leaves a plain handler behind when the TLS one is added — so the question is
/// not "is Serve on" but "is there an HTTPS handler pointing at our port". The
/// phone wants that one: a service worker will not register outside a secure
/// context, and `crypto.randomUUID` and the clipboard are missing there.
fn serve_tls_port(status: &ServeStatusJson, bridge_port: u16) -> Option<u16> {
    let target = format!("http://127.0.0.1:{bridge_port}");
    let mut ports: Vec<u16> = status
        .web
        .iter()
        .filter(|(_, web)| {
            web.handlers
                .values()
                .any(|handler| handler.proxy.as_deref() == Some(target.as_str()))
        })
        .filter_map(|(host_port, _)| host_port.rsplit_once(':')?.1.parse::<u16>().ok())
        .filter(|port| {
            status
                .tcp
                .get(&port.to_string())
                .is_some_and(|entry| entry.https)
        })
        .collect();
    // Lowest wins so 443 — the one that needs no port in the URL — is preferred
    // over any other TLS handler someone has also configured.
    ports.sort_unstable();
    ports.first().copied()
}

async fn probe_serve_tls_port(bridge_port: u16) -> Option<u16> {
    for binary in TAILSCALE_BINARIES {
        let output = tokio::time::timeout(
            TAILSCALE_PROBE_TIMEOUT,
            tokio::process::Command::new(binary)
                .args(["serve", "status", "--json"])
                .output(),
        )
        .await;
        let Ok(Ok(output)) = output else { continue };
        if !output.status.success() {
            continue;
        }
        let Ok(status) = serde_json::from_slice::<ServeStatusJson>(&output.stdout) else {
            continue;
        };
        return serve_tls_port(&status, bridge_port);
    }
    None
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

    /// The shape `tailscale serve status --json` prints once TLS is on. Both
    /// spellings are present here on purpose: `--http=8790` leaves its plain
    /// handler behind when the HTTPS one is added, which is the state a tailnet
    /// is actually in after the switch.
    const SERVE_STATUS_BOTH: &str = r#"{
      "TCP": { "443": { "HTTPS": true }, "8790": { "HTTP": true } },
      "Web": {
        "mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8790" } } },
        "mac.tail1234.ts.net:8790": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8790" } } }
      }
    }"#;

    fn serve_status(json: &str) -> ServeStatusJson {
        serde_json::from_str(json).expect("serve status")
    }

    #[test]
    fn prefers_the_tls_handler_when_serve_carries_both() {
        assert_eq!(
            serve_tls_port(&serve_status(SERVE_STATUS_BOTH), 8790),
            Some(443)
        );
    }

    #[test]
    fn ignores_a_tls_handler_pointed_at_someone_else() {
        // Another service on the same tailnet must not turn our pairing link
        // into an https one that reaches it instead of the bridge.
        let status = serve_status(
            r#"{
              "TCP": { "443": { "HTTPS": true } },
              "Web": { "mac.tail1234.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } }
            }"#,
        );
        assert_eq!(serve_tls_port(&status, 8790), None);
    }

    #[test]
    fn plain_http_serve_alone_is_not_tls() {
        let status = serve_status(
            r#"{
              "TCP": { "8790": { "HTTP": true } },
              "Web": { "mac.tail1234.ts.net:8790": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8790" } } } }
            }"#,
        );
        assert_eq!(serve_tls_port(&status, 8790), None);
    }

    #[test]
    fn the_pairing_url_drops_the_port_on_443_and_keeps_it_otherwise() {
        let probe = TailscaleProbe {
            dns_name: "mac.tail1234.ts.net".into(),
            running: true,
        };
        assert_eq!(
            mobile_page_url(Some(&probe), 8790, Some(443)),
            "https://mac.tail1234.ts.net/mobile.html"
        );
        assert_eq!(
            mobile_page_url(Some(&probe), 8790, Some(8443)),
            "https://mac.tail1234.ts.net:8443/mobile.html"
        );
        assert_eq!(
            mobile_page_url(Some(&probe), 8790, None),
            "http://mac.tail1234.ts.net:8790/mobile.html"
        );
    }
}
