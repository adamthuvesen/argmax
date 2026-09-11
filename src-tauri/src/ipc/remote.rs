// Settings → Remote access: pairing status, config writes, the ntfy test
// push, and the APNs key and paired phones. Status and the config writes are
// desktop-only — they hand out the pairing token and take a filesystem path
// for the auth key — so they sit in REMOTE_UNSUPPORTED_CHANNELS. Pairing
// itself does not: the phone is the only thing that knows its own APNs device
// token, so it registers, unregisters, and tests over the bridge.

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
use crate::remote::{self, PushDevice, RemoteConfig};
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
    pub apns: RemoteApnsStatus,
}

/// Direct-to-Apple push, as Settings shows it. Separate from the on-disk
/// [`crate::remote::ApnsConfig`] because it also answers "is this usable",
/// which the config cannot.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemoteApnsStatus {
    /// True once the key path, key id, and team id are all filled in. Devices
    /// can pair before that; they just receive nothing until it flips.
    pub configured: bool,
    pub key_path: Option<String>,
    pub key_id: Option<String>,
    pub team_id: Option<String>,
    pub sandbox: bool,
    pub devices: Vec<RemotePushDevice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushDevice {
    pub token: String,
    pub name: String,
    pub registered_at: String,
}

impl From<&PushDevice> for RemotePushDevice {
    fn from(device: &PushDevice) -> Self {
        Self {
            token: device.token.clone(),
            name: device.name.clone(),
            registered_at: device.registered_at.clone(),
        }
    }
}

/// What the phone needs before it asks iOS for notification permission: does
/// this host hold an APNs key at all. The full [`RemoteApnsStatus`] would
/// answer it too, but that arrives with the pairing token attached.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushCapability {
    pub configured: bool,
}

/// One row of the "Send test push" result: the phone, and whether Apple took
/// it. Reported per device so one dead phone does not read as a broken key.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushTestResult {
    pub token: String,
    pub name: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command(rename = "remote:get-status", async)]
#[specta::specta]
pub async fn remote_get_status(
    state: State<'_, AppState>,
    _input: RemoteGetStatusInput,
) -> ArgmaxResult<RemoteStatus> {
    let config = read_config(&state)?;
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

    let app_data_dir = state.require_app_data_dir()?;
    // Patched rather than rebuilt, so the pairing token (rotation would
    // strand the paired phone) and the APNs block survive every save here.
    let mut config = remote::load_or_create_config(app_data_dir);
    config.enabled = input.enabled;
    config.port = input.port;
    config.ntfy_topic = ntfy_topic;
    // Persisted so the push publishers can deep-link at boot, where the async
    // tailnet probe is out of reach. Saving Settings is what keeps it current
    // after the tailnet name changes.
    config.mobile_url = Some(mobile_page_url(
        probe_tailscale().await.as_ref(),
        input.port,
        probe_serve_tls_port(input.port).await,
    ));
    remote::save_config(app_data_dir, &config)?;
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
    state: State<'_, AppState>,
    _input: RemoteTestNotificationInput,
) -> ArgmaxResult<SystemOk> {
    let config = read_config(&state)?;
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

#[tauri::command(rename = "remote:set-apns-config", async)]
#[specta::specta]
pub async fn remote_set_apns_config(
    state: State<'_, AppState>,
    input: RemoteSetApnsConfigInput,
) -> ArgmaxResult<RemoteStatus> {
    let key_path = normalize_key_path(&input.key_path)?;
    let key_id = normalize_apple_id("apnsKeyId", &input.key_id)?;
    let team_id = normalize_apple_id("apnsTeamId", &input.team_id)?;

    let app_data_dir = state.require_app_data_dir()?;
    let mut config = remote::load_or_create_config(app_data_dir);
    config.apns.key_path = key_path;
    config.apns.key_id = key_id;
    config.apns.team_id = team_id;
    config.apns.sandbox = input.sandbox;
    remote::save_config(app_data_dir, &config)?;
    remote::apply_push(&state, &config);

    build_status(&state, config).await
}

#[tauri::command(rename = "remote:register-push-device", async)]
#[specta::specta]
pub async fn remote_register_push_device(
    state: State<'_, AppState>,
    input: RemoteRegisterPushDeviceInput,
) -> ArgmaxResult<Vec<RemotePushDevice>> {
    remote_register_push_device_impl(&state, input)
}

/// The phone calls this itself, over the bridge, on every launch — Apple may
/// rotate the token, and only the device knows the new one.
pub fn remote_register_push_device_impl(
    state: &AppState,
    input: RemoteRegisterPushDeviceInput,
) -> ArgmaxResult<Vec<RemotePushDevice>> {
    let token = normalize_device_token(&input.token)?;
    let name = normalize_device_name(&input.name)?;

    let app_data_dir = state.require_app_data_dir()?;
    let mut config = remote::load_or_create_config(app_data_dir);
    let registered_at = chrono::Utc::now().to_rfc3339();
    // The app re-registers on every launch, so a token we already hold is a
    // rename plus a fresher timestamp, never a duplicate row.
    match config
        .apns
        .devices
        .iter_mut()
        .find(|device| device.token == token)
    {
        Some(existing) => {
            existing.name = name;
            existing.registered_at = registered_at;
        }
        None => config.apns.devices.push(PushDevice {
            token,
            name,
            registered_at,
        }),
    }
    remote::save_config(app_data_dir, &config)?;
    remote::apply_push(state, &config);

    Ok(push_devices(&config))
}

#[tauri::command(rename = "remote:unregister-push-device", async)]
#[specta::specta]
pub async fn remote_unregister_push_device(
    state: State<'_, AppState>,
    input: RemoteUnregisterPushDeviceInput,
) -> ArgmaxResult<Vec<RemotePushDevice>> {
    remote_unregister_push_device_impl(&state, input)
}

pub fn remote_unregister_push_device_impl(
    state: &AppState,
    input: RemoteUnregisterPushDeviceInput,
) -> ArgmaxResult<Vec<RemotePushDevice>> {
    let token = normalize_device_token(&input.token)?;

    let app_data_dir = state.require_app_data_dir()?;
    let mut config = remote::load_or_create_config(app_data_dir);
    config.apns.devices.retain(|device| device.token != token);
    remote::save_config(app_data_dir, &config)?;
    remote::apply_push(state, &config);

    Ok(push_devices(&config))
}

/// Whether push can work at all from here, for a client that has to decide
/// whether to ask iOS for notification permission. Asking and then never
/// sending anything is worse than not asking.
#[tauri::command(rename = "remote:push-capability", async)]
#[specta::specta]
pub async fn remote_push_capability(
    state: State<'_, AppState>,
    _input: RemotePushCapabilityInput,
) -> ArgmaxResult<RemotePushCapability> {
    remote_push_capability_impl(&state)
}

pub fn remote_push_capability_impl(state: &AppState) -> ArgmaxResult<RemotePushCapability> {
    let config = remote::load_or_create_config(state.require_app_data_dir()?);
    Ok(RemotePushCapability {
        configured: config.apns.credentials().is_some(),
    })
}

/// Settings → "Send test push". Every paired phone gets one, and each answer
/// comes back on its own row: a single retired token must not read as a
/// broken auth key.
#[tauri::command(rename = "remote:push-test", async)]
#[specta::specta]
pub async fn remote_push_test(
    state: State<'_, AppState>,
    _input: RemotePushTestInput,
) -> ArgmaxResult<Vec<RemotePushTestResult>> {
    remote_push_test_impl(&state).await
}

/// Also reachable from the phone, which is where "did that key ever work"
/// actually gets answered.
pub async fn remote_push_test_impl(state: &AppState) -> ArgmaxResult<Vec<RemotePushTestResult>> {
    let app_data_dir = state.require_app_data_dir()?.to_path_buf();
    let config = remote::load_or_create_config(&app_data_dir);
    if config.apns.devices.is_empty() {
        return Err(invalid(
            "apnsDevices",
            "APNS_NO_DEVICES",
            "pair a phone before sending a test push",
        ));
    }
    let client = remote::apns::ApnsClient::open(&config.apns)
        .ok_or_else(|| {
            invalid(
                "apnsKeyPath",
                "APNS_NOT_CONFIGURED",
                "set the APNs key path, key id, and team id before sending a test push",
            )
        })?
        .map_err(|error| ArgmaxError::service("APNS_KEY_INVALID", error))?;

    let signal = remote::apns::test_signal();
    let mut results = Vec::with_capacity(config.apns.devices.len());
    for device in &config.apns.devices {
        let outcome = client.send(&device.token, &signal).await;
        if let Err(remote::apns::SendFailure::DeviceGone(_)) = &outcome {
            remote::apns::forget_device(&app_data_dir, &device.token);
        }
        results.push(RemotePushTestResult {
            token: device.token.clone(),
            name: device.name.clone(),
            ok: outcome.is_ok(),
            error: outcome.err().map(|failure| failure.to_string()),
        });
    }
    // A retired token may have been dropped above; rebuild the publisher off
    // what actually survived.
    remote::apply_push(state, &remote::load_or_create_config(&app_data_dir));
    Ok(results)
}

fn push_devices(config: &RemoteConfig) -> Vec<RemotePushDevice> {
    config.apns.devices.iter().map(Into::into).collect()
}

fn read_config(state: &AppState) -> ArgmaxResult<RemoteConfig> {
    Ok(remote::load_or_create_config(state.require_app_data_dir()?))
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
        serve_command: format!("tailscale serve --bg {}", config.port),
        apns: RemoteApnsStatus {
            configured: config.apns.credentials().is_some(),
            key_path: config.apns.key_path.clone(),
            key_id: config.apns.key_id.clone(),
            team_id: config.apns.team_id.clone(),
            sandbox: config.apns.sandbox,
            devices: config.apns.devices.iter().map(Into::into).collect(),
        },
    })
}

/// '' clears APNs push. Anything else has to be an absolute path to a file
/// that exists: a relative path would resolve against whatever directory the
/// app happens to be launched from, and a missing one only fails later, from
/// a background thread, where nobody sees it.
fn normalize_key_path(raw: &str) -> ArgmaxResult<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let path = std::path::Path::new(trimmed);
    if !path.is_absolute() {
        return Err(invalid(
            "apnsKeyPath",
            "APNS_KEY_PATH_RELATIVE",
            "use the full path to the .p8 file",
        ));
    }
    if !path.is_file() {
        return Err(invalid(
            "apnsKeyPath",
            "APNS_KEY_PATH_MISSING",
            "no file at that path",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// Apple's Key ID and Team ID are both 10 alphanumeric characters. '' clears.
fn normalize_apple_id(field: &'static str, raw: &str) -> ArgmaxResult<Option<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() != 10 || !trimmed.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(invalid(
            field,
            "APNS_ID_INVALID",
            "Apple's key and team ids are 10 letters and digits",
        ));
    }
    Ok(Some(trimmed.to_string()))
}

/// An APNs device token is hex. Rejecting anything else here keeps a typo out
/// of the request URL, where it would come back as an opaque 400.
fn normalize_device_token(raw: &str) -> ArgmaxResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 200 || !trimmed.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(invalid(
            "token",
            "PUSH_TOKEN_INVALID",
            "a device token is hexadecimal",
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn normalize_device_name(raw: &str) -> ArgmaxResult<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("name", "PUSH_NAME_EMPTY", "name the device"));
    }
    Ok(trimmed.chars().take(64).collect())
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
    fn an_apns_key_path_must_be_an_absolute_file_and_empty_clears() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = dir.path().join("AuthKey_ABC1234567.p8");
        std::fs::write(&key, "placeholder").expect("write");

        assert_eq!(normalize_key_path("  ").expect("valid"), None);
        assert_eq!(
            normalize_key_path(&format!(" {} ", key.display())).expect("valid"),
            Some(key.display().to_string())
        );
        assert!(normalize_key_path("AuthKey.p8").is_err(), "relative");
        assert!(
            normalize_key_path(&dir.path().join("absent.p8").display().to_string()).is_err(),
            "missing file"
        );
        assert!(
            normalize_key_path(&dir.path().display().to_string()).is_err(),
            "a directory"
        );
    }

    #[test]
    fn apple_ids_are_ten_alphanumerics_and_empty_clears() {
        assert_eq!(
            normalize_apple_id("apnsKeyId", " AB12CD34EF ").expect("valid"),
            Some("AB12CD34EF".to_string())
        );
        assert_eq!(normalize_apple_id("apnsKeyId", "").expect("valid"), None);
        assert!(
            normalize_apple_id("apnsKeyId", "AB12CD34E").is_err(),
            "nine"
        );
        assert!(
            normalize_apple_id("apnsTeamId", "AB12-CD34E").is_err(),
            "punctuation"
        );
    }

    #[test]
    fn device_tokens_are_hex_and_case_folded() {
        assert_eq!(
            normalize_device_token(" A1B2c3 ").expect("valid"),
            "a1b2c3".to_string()
        );
        assert!(normalize_device_token("").is_err());
        assert!(normalize_device_token("not-hex").is_err());
        assert!(normalize_device_token(&"a".repeat(201)).is_err());
    }

    #[test]
    fn device_names_are_required_and_capped() {
        assert_eq!(
            normalize_device_name("  Adam's iPhone ").expect("valid"),
            "Adam's iPhone"
        );
        assert!(normalize_device_name("   ").is_err());
        assert_eq!(
            normalize_device_name(&"x".repeat(200))
                .expect("valid")
                .len(),
            64
        );
    }

    /// The wire type is a hand-written view of the on-disk one; this is what
    /// makes a field added to `PushDevice` and forgotten here fail loudly.
    #[test]
    fn the_wire_device_carries_every_stored_field() {
        let stored = PushDevice {
            token: "a1b2".to_string(),
            name: "iPhone".to_string(),
            registered_at: "2026-01-01T00:00:00Z".to_string(),
        };
        let wire = RemotePushDevice::from(&stored);
        assert_eq!(wire.token, stored.token);
        assert_eq!(wire.name, stored.name);
        assert_eq!(wire.registered_at, stored.registered_at);
        assert_eq!(
            serde_json::to_value(&wire).expect("json"),
            serde_json::json!({
                "token": "a1b2",
                "name": "iPhone",
                "registeredAt": "2026-01-01T00:00:00Z",
            })
        );
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
