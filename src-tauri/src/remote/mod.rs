// Optional remote bridge.
//
// When `remote.json` in the app data dir says `enabled: true`, an axum server
// binds 127.0.0.1:<port> and serves the renderer bundle plus a token-gated
// WebSocket that proxies the same IPC channels the desktop webview uses. The
// listener is loopback-only on purpose: Tailscale Serve owns tailnet exposure,
// so nothing here should ever bind 0.0.0.0.
//
// The bridge is off by default. Startup writes a disabled `remote.json` with a
// fresh token on first run so enabling it is a one-word edit, never a token
// hunt.

pub mod apns;
pub mod dispatch;
pub mod ntfy;
pub mod operations;
pub mod server;
pub mod signal;
pub mod ws;

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;
use uuid::Uuid;

const CONFIG_FILE_NAME: &str = "remote.json";
const DEFAULT_PORT: u16 = 8790;

/// Buffered push events per connected client. A busy turn emits a
/// `dashboard:delta` per streamed chunk, so a client that stalls briefly must
/// not stall the emit sites; it gets a `Lagged` warning instead.
pub const REMOTE_EVENT_CAPACITY: usize = 256;

/// Buffered terminal push events per connected client, on their own channel.
/// A `cat` of a large file produces terminal output faster than a phone over a
/// tailnet can drain it; sharing the buffer above meant that flood evicted the
/// `dashboard:delta`s carrying approval requests, and every eviction cost the
/// client a full snapshot reload. Terminal output is a best-effort mirror the
/// mobile client does not even render, so it gets a small buffer of its own
/// and drops silently.
pub const REMOTE_TERMINAL_EVENT_CAPACITY: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_port")]
    pub port: u16,
    pub token: String,
    /// Full ntfy topic URL (e.g. `https://ntfy.sh/<topic>`). When set, session
    /// transitions that need the user push to the phone regardless of
    /// `enabled` — notifications are useful even without the WS bridge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ntfy_topic: Option<String>,
    /// Mobile page URL pushes deep-link into — the same base the pairing QR
    /// encodes, so a notification opens wherever the phone was paired.
    /// Re-derived from the tailnet probe whenever Settings saves, because the
    /// publisher runs far from the async probe and needs it at boot too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mobile_url: Option<String>,
    /// Direct-to-Apple push for the native remote app. Absent means disabled,
    /// which is also what a partially filled block means — see
    /// [`ApnsConfig::credentials`].
    #[serde(default, skip_serializing_if = "ApnsConfig::is_absent")]
    pub apns: ApnsConfig,
}

impl RemoteConfig {
    /// A freshly seeded, disabled config. Also the fallback whenever the file
    /// on disk cannot be read or parsed.
    pub(crate) fn disabled() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: generate_token(),
            ntfy_topic: None,
            mobile_url: None,
            apns: ApnsConfig::default(),
        }
    }
}

/// The APNs auth key and the phones paired against it. Every field is
/// optional so an untouched `remote.json` carries no `apns` block at all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ApnsConfig {
    /// Absolute path to the `.p8` auth key downloaded from Apple Developer →
    /// Keys. The key stays where the user put it; Argmax only reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// The 10-character Key ID Apple shows next to that key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    /// The 10-character Team ID from the developer account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Send to Apple's development host instead. A token minted by a debug
    /// build of the app only works there, and vice versa.
    #[serde(default)]
    pub sandbox: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub devices: Vec<PushDevice>,
}

impl ApnsConfig {
    /// The three values a push needs, or `None` while any of them is missing.
    /// Blank strings count as missing: an emptied Settings field must turn
    /// push off, not send a request Apple answers with 403.
    pub fn credentials(&self) -> Option<(&str, &str, &str)> {
        let key_path = non_empty(self.key_path.as_deref())?;
        let key_id = non_empty(self.key_id.as_deref())?;
        let team_id = non_empty(self.team_id.as_deref())?;
        Some((key_path, key_id, team_id))
    }

    fn is_absent(&self) -> bool {
        self == &Self::default()
    }
}

/// One paired phone. The token is APNs' own device token, re-registered by
/// the app on every launch because Apple may rotate it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushDevice {
    pub token: String,
    /// What the user sees in Settings, e.g. the device name the app reports.
    pub name: String,
    /// RFC 3339, for the Settings list.
    pub registered_at: String,
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    (!value.is_empty()).then_some(value)
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

/// A push event mirrored from the desktop `emit` sites to every connected
/// remote client. Native-only channels (`menu:command`) are not mirrored.
#[derive(Debug, Clone)]
pub struct RemoteEvent {
    pub channel: &'static str,
    pub payload: Value,
}

/// Mirror one desktop push event to the remote clients. Serialization happens
/// once per event and only while someone is listening — the desktop emit path
/// must not pay for a bridge nobody is connected to.
pub fn publish(
    events: &broadcast::Sender<RemoteEvent>,
    channel: &'static str,
    payload: &impl Serialize,
) {
    if events.receiver_count() == 0 {
        return;
    }
    match serde_json::to_value(payload) {
        Ok(payload) => {
            // Send fails only when every receiver went away between the count
            // above and here, which is not worth logging.
            let _ = events.send(RemoteEvent { channel, payload });
        }
        Err(error) => tracing::warn!(?error, channel, "failed to serialize remote event"),
    }
}

/// Read `remote.json`, seeding a disabled one when it is missing. Any failure
/// (unreadable, malformed) is loud and leaves the bridge disabled.
pub fn load_or_create_config(app_data_dir: &Path) -> RemoteConfig {
    let path = app_data_dir.join(CONFIG_FILE_NAME);
    match std::fs::read_to_string(&path) {
        Ok(body) => match serde_json::from_str::<RemoteConfig>(&body) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %path.display(),
                    "remote.json is malformed; remote bridge stays disabled"
                );
                RemoteConfig::disabled()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let config = RemoteConfig::disabled();
            match serde_json::to_vec_pretty(&config) {
                Ok(body) => {
                    if let Err(error) = std::fs::write(&path, body) {
                        tracing::warn!(?error, path = %path.display(), "failed to seed remote.json");
                    }
                }
                Err(error) => tracing::warn!(?error, "failed to serialize remote.json"),
            }
            config
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                path = %path.display(),
                "failed to read remote.json; remote bridge stays disabled"
            );
            RemoteConfig::disabled()
        }
    }
}

/// Persist `remote.json`. Failures are returned loudly so the Settings panel
/// can tell the user the change did not stick.
pub fn save_config(app_data_dir: &Path, config: &RemoteConfig) -> crate::error::ArgmaxResult<()> {
    let path = app_data_dir.join(CONFIG_FILE_NAME);
    let body = serde_json::to_vec_pretty(config).map_err(|error| {
        crate::error::ArgmaxError::service("REMOTE_CONFIG_ENCODE", error.to_string())
    })?;
    std::fs::write(&path, body).map_err(|error| {
        crate::error::ArgmaxError::service(
            "REMOTE_CONFIG_WRITE",
            format!("failed to write {}: {error}", path.display()),
        )
    })
}

/// A v4 UUID's simple form is exactly 32 hex characters (122 random bits),
/// which is the token shape the remote client expects.
fn generate_token() -> String {
    Uuid::new_v4().simple().to_string()
}

/// Resolve the config and bring the bridge in line with it. Spawned after the
/// rest of setup so a bridge failure cannot touch boot.
pub async fn start(app: tauri::AppHandle) {
    let state = tauri::Manager::state::<crate::state::AppState>(&app);
    let Some(app_data_dir) = state.app_data_dir.get() else {
        tracing::warn!("remote bridge: setup resolved no app data dir; staying disabled");
        return;
    };
    let config = load_or_create_config(app_data_dir);
    apply(&app, config);
}

/// Bring the bridge and both push publishers in line with `config`: swap the
/// publishers, stop any running server, and start a new one when enabled.
/// Called at boot and whenever the Settings panel saves a change.
pub fn apply(app: &tauri::AppHandle, config: RemoteConfig) {
    let state = tauri::Manager::state::<crate::state::AppState>(app);
    apply_push(&state, &config);

    let mut server = state
        .remote_server
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut retired = RETIRED_SERVER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // A handle retired by an earlier disable may still be holding the port.
    let previous = server.take().or_else(|| retired.take());
    if let Some(handle) = &previous {
        // Aborting drops the axum serve future, which closes the listener and
        // every connected WebSocket.
        handle.abort();
    }
    if config.enabled {
        let app = app.clone();
        *server = Some(tauri::async_runtime::spawn(async move {
            if let Some(previous) = previous {
                // The abort completes asynchronously; rebinding the same port
                // before the old listener has dropped loses the race and the
                // new server dies on EADDRINUSE.
                let _ = previous.await;
            }
            server::serve(app, config).await;
        }));
    } else {
        // Park the aborted handle rather than dropping it, so a later enable
        // still has something to await before it rebinds the port.
        *retired = previous;
        tracing::debug!("remote bridge disabled");
    }
}

/// Swap the ntfy and APNs publishers for the ones `config` describes, leaving
/// the bridge server alone. Pairing a phone goes through here rather than
/// [`apply`]: rebinding the port would drop every connected client, including
/// the phone that just registered. Takes `&AppState`, not the `AppHandle`,
/// because the phone pairs itself over the bridge, where there is none.
pub fn apply_push(state: &crate::state::AppState, config: &RemoteConfig) {
    let ntfy_publisher = config.ntfy_topic.clone().map(|topic| {
        std::sync::Arc::new(ntfy::NtfyPublisher::new(topic, config.mobile_url.clone()))
    });
    let apns_publisher = build_apns_publisher(state, config);
    if let Ok(mut ntfy) = state.ntfy.write() {
        *ntfy = ntfy_publisher;
    }
    let apns_installed = match state.apns.write() {
        Ok(mut apns) => {
            *apns = apns_publisher;
            apns.is_some()
        }
        Err(_) => false,
    };
    tracing::debug!(
        ntfy = config.ntfy_topic.is_some(),
        apns = apns_installed,
        devices = config.apns.devices.len(),
        "push publishers installed"
    );
}

/// The APNs publisher for `config`, or `None` when push is off. A key that
/// will not load is a warning and a disabled sink, not a boot failure: the
/// Settings panel reports the same problem when the user next opens it.
fn build_apns_publisher(
    state: &crate::state::AppState,
    config: &RemoteConfig,
) -> Option<std::sync::Arc<apns::ApnsPublisher>> {
    if config.apns.devices.is_empty() {
        return None;
    }
    let app_data_dir = state.app_data_dir.get()?.clone();
    match apns::ApnsClient::open(&config.apns)? {
        Ok(client) => Some(std::sync::Arc::new(apns::ApnsPublisher::new(
            std::sync::Arc::new(client),
            config.apns.devices.clone(),
            app_data_dir,
        ))),
        Err(error) => {
            tracing::warn!(%error, "APNs push is configured but the key could not be loaded");
            None
        }
    }
}

/// A server task that was aborted while the bridge is disabled. It is kept out
/// of `AppState::remote_server` because that slot answers `is_serving`, and an
/// abort that has not completed yet would read as a live server.
static RETIRED_SERVER: std::sync::Mutex<Option<tauri::async_runtime::JoinHandle<()>>> =
    std::sync::Mutex::new(None);

/// True while a server task is alive. A finished handle means the server died
/// (typically a failed port bind), so surface that as "not serving".
pub fn is_serving(state: &crate::state::AppState) -> bool {
    state
        .remote_server
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .is_some_and(|handle| !handle.inner().is_finished())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn missing_config_is_seeded_disabled_with_a_fresh_token() {
        let dir = tempdir().expect("tempdir");

        let config = load_or_create_config(dir.path());

        assert!(!config.enabled);
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.token.len(), 32);
        assert!(config.token.chars().all(|c| c.is_ascii_hexdigit()));

        let written =
            std::fs::read_to_string(dir.path().join(CONFIG_FILE_NAME)).expect("seeded remote.json");
        let reread: RemoteConfig = serde_json::from_str(&written).expect("parse seeded config");
        assert_eq!(reread.token, config.token);
    }

    #[test]
    fn malformed_config_stays_disabled() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(dir.path().join(CONFIG_FILE_NAME), "{ not json").expect("write");

        assert!(!load_or_create_config(dir.path()).enabled);
    }

    /// An untouched config carries no `apns` block, and a config that has one
    /// survives a save/load round trip with its devices intact.
    #[test]
    fn the_apns_block_is_absent_until_it_is_used() {
        let dir = tempdir().expect("tempdir");
        load_or_create_config(dir.path());

        let seeded = std::fs::read_to_string(dir.path().join(CONFIG_FILE_NAME)).expect("seeded");
        assert!(!seeded.contains("apns"), "seeded config: {seeded}");

        let mut config = load_or_create_config(dir.path());
        config.apns.key_path = Some("/keys/AuthKey_ABC1234567.p8".to_string());
        config.apns.key_id = Some("ABC1234567".to_string());
        config.apns.team_id = Some("TEAM123456".to_string());
        config.apns.sandbox = true;
        config.apns.devices.push(PushDevice {
            token: "a1b2".to_string(),
            name: "iPhone".to_string(),
            registered_at: "2026-01-01T00:00:00Z".to_string(),
        });
        save_config(dir.path(), &config).expect("save");

        let reread = load_or_create_config(dir.path());
        assert_eq!(reread.apns, config.apns);
        assert_eq!(
            reread.apns.credentials(),
            Some(("/keys/AuthKey_ABC1234567.p8", "ABC1234567", "TEAM123456"))
        );
    }

    /// A half-filled block is the disabled state, not a request to send with
    /// whatever is there.
    #[test]
    fn incomplete_apns_credentials_read_as_unconfigured() {
        let mut apns = ApnsConfig {
            key_path: Some("/keys/AuthKey.p8".to_string()),
            key_id: Some("ABC1234567".to_string()),
            team_id: None,
            sandbox: false,
            devices: Vec::new(),
        };
        assert_eq!(apns.credentials(), None);
        apns.team_id = Some("   ".to_string());
        assert_eq!(apns.credentials(), None, "blank is missing");
    }

    #[test]
    fn enabled_config_round_trips() {
        let dir = tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(CONFIG_FILE_NAME),
            r#"{"enabled":true,"port":9001,"token":"abc"}"#,
        )
        .expect("write");

        let config = load_or_create_config(dir.path());

        assert!(config.enabled);
        assert_eq!(config.port, 9001);
        assert_eq!(config.token, "abc");
    }
}
