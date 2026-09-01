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

pub mod dispatch;
pub mod ntfy;
pub mod server;
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
}

impl RemoteConfig {
    /// A freshly seeded, disabled config. Also the fallback whenever the file
    /// on disk cannot be read or parsed.
    fn disabled() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: generate_token(),
            ntfy_topic: None,
            mobile_url: None,
        }
    }
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
    let Some(app_data_dir) = ensure_app_data_dir(&app) else {
        return;
    };
    let config = load_or_create_config(&app_data_dir);
    apply(&app, config);
}

/// Bring the bridge and the ntfy publisher in line with `config`: swap the
/// publisher, stop any running server, and start a new one when enabled.
/// Called at boot and whenever the Settings panel saves a change.
pub fn apply(app: &tauri::AppHandle, config: RemoteConfig) {
    let state = tauri::Manager::state::<crate::state::AppState>(app);

    let publisher = config.ntfy_topic.clone().map(|topic| {
        std::sync::Arc::new(ntfy::NtfyPublisher::new(topic, config.mobile_url.clone()))
    });
    if let Ok(mut ntfy) = state.ntfy.write() {
        *ntfy = publisher;
    }

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

pub fn ensure_app_data_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_data_dir = match crate::util::data_dir::app_data_dir(app) {
        Ok(dir) => dir,
        Err(error) => {
            tracing::warn!(?error, "remote bridge: app_data_dir unavailable");
            return None;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&app_data_dir) {
        tracing::warn!(?error, path = %app_data_dir.display(), "remote bridge: failed to create app data dir");
        return None;
    }
    Some(app_data_dir)
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
