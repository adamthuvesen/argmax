// Phone push straight to Apple, for the native Argmax remote app.
//
// The ntfy sink next door goes through a public relay; this one does not.
// The Mac holds an APNs auth key (`.p8`), signs its own provider token, and
// POSTs to `api.push.apple.com` itself, so a notification never leaves the
// path between this machine and Apple. Both sinks read the same trigger table
// in `signal.rs`, so a chat that buzzes one buzzes the other.
//
// Apple requires HTTP/2 here; `ureq` (the ntfy sink's client) speaks 1.1 only,
// so this rides the `reqwest` client already in the tree. Sends happen on the
// Tokio runtime rather than the caller's thread, the same way the ntfy sink
// fires its POST off a throwaway thread — the dashboard-delta path must never
// wait on Apple.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::json;

use crate::persistence::sessions::SessionSummary;
use crate::remote::signal::{signal_for, PushSignal, SignalDedupe};
use crate::remote::{ApnsConfig, PushDevice};
use crate::util::sync::LockOrRecover;

/// The native remote app's bundle id, which is also the `apns-topic` the auth
/// key must be provisioned for.
pub const BUNDLE_ID: &str = "com.argmax.remote";

const PRODUCTION_HOST: &str = "api.push.apple.com";
const SANDBOX_HOST: &str = "api.development.push.apple.com";

/// Apple rejects a provider token older than an hour, and rejects re-signing
/// more often than every 20 minutes. Fifty leaves room on both sides.
const TOKEN_TTL: Duration = Duration::from_secs(50 * 60);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a push did not land.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendFailure {
    /// Apple says this device is gone for good — the app was deleted, or the
    /// token was minted for the other environment. Retrying can only fail, so
    /// the caller drops the token instead.
    DeviceGone(String),
    /// Anything else: a bad key, a throttle, Apple being down, no network.
    Rejected(String),
}

impl std::fmt::Display for SendFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DeviceGone(reason) | Self::Rejected(reason) => f.write_str(reason),
        }
    }
}

/// A configured APNs connection: the signing key, the environment, and a
/// pooled HTTP/2 client. Built once per config change and shared, because
/// Apple wants one long-lived connection rather than one per notification.
pub struct ApnsClient {
    token: ProviderToken,
    http: reqwest::Client,
    host: &'static str,
}

impl ApnsClient {
    /// Read the `.p8` named by the config and build a client from it. `None`
    /// when the config is incomplete — that is the disabled state, not an
    /// error.
    pub fn open(config: &ApnsConfig) -> Option<Result<Self, String>> {
        let (key_path, key_id, team_id) = config.credentials()?;
        let pem = match std::fs::read_to_string(key_path) {
            Ok(pem) => pem,
            Err(error) => {
                return Some(Err(format!("failed to read {key_path}: {error}")));
            }
        };
        Some(Self::from_pem(&pem, key_id, team_id, config.sandbox))
    }

    pub fn from_pem(pem: &str, key_id: &str, team_id: &str, sandbox: bool) -> Result<Self, String> {
        let token = ProviderToken::new(pem, key_id, team_id)?;
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| format!("failed to build the APNs HTTP client: {error}"))?;
        Ok(Self {
            token,
            http,
            host: if sandbox {
                SANDBOX_HOST
            } else {
                PRODUCTION_HOST
            },
        })
    }

    pub async fn send(&self, device_token: &str, signal: &PushSignal) -> Result<(), SendFailure> {
        let bearer = self.token.bearer().map_err(SendFailure::Rejected)?;
        let response = self
            .http
            .post(format!("https://{}/3/device/{device_token}", self.host))
            .header("authorization", format!("bearer {bearer}"))
            .header("apns-topic", BUNDLE_ID)
            .header("apns-push-type", "alert")
            .header("apns-priority", signal.priority.apns_header())
            .json(&payload(signal))
            .send()
            .await
            .map_err(|error| SendFailure::Rejected(error.to_string()))?;

        let status = response.status().as_u16();
        if status == 200 {
            return Ok(());
        }
        let body = response.text().await.unwrap_or_default();
        Err(classify(status, &body))
    }
}

/// The notification Apple delivers. `thread-id` groups a chat's pushes into
/// one stack on the lock screen, and `sessionId` is what the native app reads
/// to deep-link the tap — the same job ntfy's `Click` header does. Both are
/// omitted for the test push, which belongs to no chat; sending an empty
/// string would deep-link the app at a session that does not exist.
fn payload(signal: &PushSignal) -> serde_json::Value {
    let mut aps = json!({
        "alert": { "title": signal.title, "body": signal.body },
        "sound": "default",
        "interruption-level": signal.priority.interruption_level(),
    });
    let mut root = json!({});
    if !signal.session_id.is_empty() {
        aps["thread-id"] = json!(signal.session_id);
        root["sessionId"] = json!(signal.session_id);
    }
    root["aps"] = aps;
    root
}

/// The push behind Settings → "Send test push".
pub fn test_signal() -> PushSignal {
    PushSignal {
        title: "Argmax: Test notification".to_string(),
        body: "Push notifications are working.".to_string(),
        priority: crate::remote::signal::SignalPriority::Normal,
        session_id: String::new(),
        tags: "bell",
    }
}

/// Map an APNs rejection onto whether the device token is worth keeping.
/// Apple answers 410 once a token is retired and 400 `BadDeviceToken` when it
/// never belonged to this topic or environment; both are permanent.
fn classify(status: u16, body: &str) -> SendFailure {
    let reason = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value.get("reason")?.as_str().map(str::to_string))
        .unwrap_or_else(|| body.trim().to_string());
    let detail = if reason.is_empty() {
        format!("APNs returned {status}")
    } else {
        format!("APNs returned {status} ({reason})")
    };
    match (status, reason.as_str()) {
        (410, _) | (400, "BadDeviceToken") => SendFailure::DeviceGone(detail),
        _ => SendFailure::Rejected(detail),
    }
}

/// The ES256 JWT Apple wants in the `authorization` header, re-signed inside
/// its one-hour life.
struct ProviderToken {
    key: EcdsaKeyPair,
    rng: SystemRandom,
    key_id: String,
    team_id: String,
    cached: Mutex<Option<(String, Instant)>>,
}

impl ProviderToken {
    fn new(pem: &str, key_id: &str, team_id: &str) -> Result<Self, String> {
        let rng = SystemRandom::new();
        let pkcs8 = pkcs8_from_pem(pem)?;
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8, &rng)
            .map_err(|error| format!("the APNs key is not a P-256 private key: {error}"))?;
        Ok(Self {
            key,
            rng,
            key_id: key_id.to_string(),
            team_id: team_id.to_string(),
            cached: Mutex::new(None),
        })
    }

    fn bearer(&self) -> Result<String, String> {
        let mut cached = self.cached.lock_or_recover("apns provider token");
        if let Some((token, signed_at)) = cached.as_ref() {
            if signed_at.elapsed() < TOKEN_TTL {
                return Ok(token.clone());
            }
        }
        let token = self.sign(unix_now())?;
        *cached = Some((token.clone(), Instant::now()));
        Ok(token)
    }

    fn sign(&self, issued_at: u64) -> Result<String, String> {
        let header = json!({ "alg": "ES256", "kid": self.key_id });
        let claims = json!({ "iss": self.team_id, "iat": issued_at });
        let signing_input = format!("{}.{}", b64_json(&header)?, b64_json(&claims)?);
        let signature = self
            .key
            .sign(&self.rng, signing_input.as_bytes())
            .map_err(|_| "failed to sign the APNs provider token".to_string())?;
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

fn b64_json(value: &serde_json::Value) -> Result<String, String> {
    serde_json::to_vec(value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|error| format!("failed to encode the APNs provider token: {error}"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default()
}

/// Apple hands out the auth key as a PKCS#8 PEM in a `.p8` file. Strip the
/// armour and decode; a file that is not one is rejected rather than fed to
/// ring as bytes, so the Settings panel can say what is wrong.
fn pkcs8_from_pem(pem: &str) -> Result<Vec<u8>, String> {
    let mut inside = false;
    let mut body = String::new();
    for line in pem.lines() {
        let line = line.trim();
        if line.starts_with("-----BEGIN") {
            inside = true;
        } else if line.starts_with("-----END") {
            inside = false;
        } else if inside {
            body.push_str(line);
        }
    }
    if body.is_empty() {
        return Err("the APNs key file is not a PEM private key (.p8)".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|error| format!("the APNs key file is not valid base64: {error}"))
}

type Sink = Box<dyn Fn(PushSignal) + Send + Sync>;

/// Fans every qualifying transition out to the paired devices.
pub struct ApnsPublisher {
    sink: Sink,
    dedupe: SignalDedupe,
}

impl ApnsPublisher {
    pub fn new(client: Arc<ApnsClient>, devices: Vec<PushDevice>, app_data_dir: PathBuf) -> Self {
        Self::with_sink(Box::new(move |signal: PushSignal| {
            let client = Arc::clone(&client);
            let devices = devices.clone();
            let app_data_dir = app_data_dir.clone();
            tauri::async_runtime::spawn(async move {
                for device in &devices {
                    match client.send(&device.token, &signal).await {
                        Ok(()) => {}
                        Err(SendFailure::DeviceGone(reason)) => {
                            tracing::info!(
                                device = %device.name,
                                %reason,
                                "APNs retired a device; dropping it from remote.json"
                            );
                            forget_device(&app_data_dir, &device.token);
                        }
                        Err(SendFailure::Rejected(reason)) => {
                            tracing::warn!(device = %device.name, %reason, "APNs push failed");
                        }
                    }
                }
            });
        }))
    }

    fn with_sink(sink: Sink) -> Self {
        Self {
            sink,
            dedupe: SignalDedupe::new("apns last signaled"),
        }
    }

    /// Called for every session row in a dashboard delta, next to the ntfy
    /// publisher and off the same trigger table.
    pub fn observe(&self, session: &SessionSummary) {
        let Some(signal) = signal_for(session) else {
            return;
        };
        if !self.dedupe.admit(session) {
            return;
        }
        (self.sink)(signal);
    }
}

/// Drop a device Apple has retired. Re-reads `remote.json` rather than
/// rewriting the snapshot the publisher was built with, because Settings may
/// have paired or removed a device since.
pub fn forget_device(app_data_dir: &Path, device_token: &str) {
    let mut config = crate::remote::load_or_create_config(app_data_dir);
    let before = config.apns.devices.len();
    config
        .apns
        .devices
        .retain(|device| device.token != device_token);
    if config.apns.devices.len() == before {
        return;
    }
    if let Err(error) = crate::remote::save_config(app_data_dir, &config) {
        tracing::warn!(%error, "failed to drop a retired APNs device from remote.json");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::signal::SignalPriority;
    use crate::remote::{save_config, RemoteConfig};
    use ring::signature::{KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
    use tempfile::tempdir;

    /// A throwaway P-256 key in Apple's `.p8` wrapper. Generated per test run,
    /// so no real APNs credential ever enters the repository.
    fn test_key_pem() -> String {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng)
            .expect("generate key");
        let body = base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref());
        let lines: Vec<String> = body
            .as_bytes()
            .chunks(64)
            .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        )
    }

    fn signal(priority: SignalPriority) -> PushSignal {
        PushSignal {
            title: "Argmax: Needs approval".to_string(),
            body: "Build the dashboard".to_string(),
            priority,
            session_id: "s1".to_string(),
            tags: "raised_hand",
        }
    }

    fn device(token: &str) -> PushDevice {
        PushDevice {
            token: token.to_string(),
            name: format!("phone-{token}"),
            registered_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn the_provider_token_is_a_verifiable_es256_jwt() {
        let pem = test_key_pem();
        let token = ProviderToken::new(&pem, "KEY123", "TEAM456").expect("token");

        let jwt = token.sign(1_767_225_600).expect("sign");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3, "a JWT is three dot-separated segments");

        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).expect("header b64"))
                .expect("header json");
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "KEY123");

        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("claims b64"))
                .expect("claims json");
        assert_eq!(claims["iss"], "TEAM456");
        assert_eq!(claims["iat"], 1_767_225_600u64);

        // The signature has to verify against the key's own public half, over
        // exactly `header.claims` — the bug this catches is signing the wrong
        // bytes, which Apple would answer with an opaque 403.
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).expect("signature b64");
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, token.key.public_key().as_ref())
            .verify(signing_input.as_bytes(), &signature)
            .expect("signature verifies");
    }

    #[test]
    fn the_provider_token_is_reused_until_it_ages_out() {
        let token = ProviderToken::new(&test_key_pem(), "KEY123", "TEAM456").expect("token");

        let first = token.bearer().expect("first");
        assert_eq!(token.bearer().expect("second"), first);

        // Age the cache past its TTL; the next call has to re-sign.
        *token.cached.lock().expect("cache") = Some((
            first.clone(),
            Instant::now() - TOKEN_TTL - Duration::from_secs(1),
        ));
        assert_ne!(token.bearer().expect("third"), first);
    }

    #[test]
    fn a_file_that_is_not_a_pem_key_is_rejected_loudly() {
        assert!(ProviderToken::new("not a key at all", "K", "T").is_err());
        assert!(ProviderToken::new(
            "-----BEGIN PRIVATE KEY-----\nnot base64!!\n-----END PRIVATE KEY-----\n",
            "K",
            "T"
        )
        .is_err());
        // Well-formed base64 that is not a P-256 PKCS#8 key.
        assert!(ProviderToken::new(
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
            "K",
            "T"
        )
        .is_err());
    }

    #[test]
    fn the_payload_carries_the_alert_thread_and_session_id() {
        assert_eq!(
            payload(&signal(SignalPriority::Urgent)),
            json!({
                "aps": {
                    "alert": { "title": "Argmax: Needs approval", "body": "Build the dashboard" },
                    "sound": "default",
                    "thread-id": "s1",
                    "interruption-level": "time-sensitive",
                },
                "sessionId": "s1",
            })
        );
    }

    #[test]
    fn a_finished_chat_is_active_not_time_sensitive() {
        let payload = payload(&signal(SignalPriority::Normal));
        assert_eq!(payload["aps"]["interruption-level"], "active");
    }

    #[test]
    fn the_test_push_carries_no_session_to_deep_link_into() {
        let payload = payload(&test_signal());
        assert!(payload.get("sessionId").is_none());
        assert!(payload["aps"].get("thread-id").is_none());
        assert_eq!(
            payload["aps"]["alert"]["title"],
            "Argmax: Test notification"
        );
    }

    #[test]
    fn a_retired_token_is_classified_as_gone_and_a_throttle_is_not() {
        assert!(matches!(
            classify(410, r#"{"reason":"Unregistered","timestamp":1}"#),
            SendFailure::DeviceGone(_)
        ));
        assert!(matches!(
            classify(400, r#"{"reason":"BadDeviceToken"}"#),
            SendFailure::DeviceGone(_)
        ));
        assert!(matches!(
            classify(400, r#"{"reason":"BadTopic"}"#),
            SendFailure::Rejected(_)
        ));
        assert!(matches!(
            classify(429, r#"{"reason":"TooManyRequests"}"#),
            SendFailure::Rejected(_)
        ));
        // Apple's reason should reach the log, not be swallowed.
        assert_eq!(
            classify(410, r#"{"reason":"Unregistered"}"#).to_string(),
            "APNs returned 410 (Unregistered)"
        );
    }

    #[test]
    fn a_gone_device_is_dropped_from_the_config_and_the_others_stay() {
        let dir = tempdir().expect("tempdir");
        let mut config = RemoteConfig::disabled();
        config.apns.devices = vec![device("aaaa"), device("bbbb")];
        save_config(dir.path(), &config).expect("save");

        forget_device(dir.path(), "aaaa");

        let reread = crate::remote::load_or_create_config(dir.path());
        assert_eq!(
            reread
                .apns
                .devices
                .iter()
                .map(|device| device.token.as_str())
                .collect::<Vec<_>>(),
            vec!["bbbb"]
        );
    }

    #[test]
    fn forgetting_an_unknown_device_leaves_the_config_alone() {
        let dir = tempdir().expect("tempdir");
        let mut config = RemoteConfig::disabled();
        config.apns.devices = vec![device("aaaa")];
        save_config(dir.path(), &config).expect("save");

        forget_device(dir.path(), "cccc");

        assert_eq!(
            crate::remote::load_or_create_config(dir.path())
                .apns
                .devices
                .len(),
            1
        );
    }

    /// The publisher's own contract, with the network stood in for: one push
    /// per (state, attention), silence for a chat nobody is waiting on.
    #[test]
    fn the_publisher_fans_out_once_per_transition() {
        use crate::remote::signal::fixtures::session;
        use crate::sessions::attention::AttentionState;
        use crate::sessions::state::SessionState;
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel();
        let publisher = ApnsPublisher::with_sink(Box::new(move |signal| {
            let _ = tx.send(signal);
        }));

        publisher.observe(&session(SessionState::Running, AttentionState::Normal));
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));
        publisher.observe(&session(
            SessionState::Running,
            AttentionState::ApprovalNeeded,
        ));

        let signal = rx.try_recv().expect("approval push");
        assert_eq!(signal.title, "Argmax: Needs approval");
        assert_eq!(signal.priority, SignalPriority::Urgent);
        assert!(rx.try_recv().is_err(), "duplicate transition must not fire");
    }
}
