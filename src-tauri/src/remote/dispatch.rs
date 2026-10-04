//! Remote transport adapter. Typed operations and exposure policy live in ipc::catalogue.
use crate::error::{ArgmaxError, ArgmaxResult, InvalidInputIssue};
use crate::state::AppState;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

pub async fn dispatch(state: &AppState, channel: &str, input: Value) -> ArgmaxResult<Value> {
    dispatch_with_default_agent(
        state,
        channel,
        input,
        crate::default_agent::DefaultAgent::factory(),
    )
    .await
}

pub fn dispatch_with_default_agent<'a>(
    state: &'a AppState,
    channel: &'a str,
    input: Value,
    default_agent: crate::default_agent::DefaultAgent,
) -> crate::providers::runtime::BoxFuture<'a, ArgmaxResult<Value>> {
    if channel == "dashboard:changes" {
        return Box::pin(async move {
            let input: crate::remote::dashboard_changes::DashboardChangesInput =
                parse(channel, input)?;
            let snapshot = encode(crate::ipc::dashboard::dashboard_list_impl(state).await?)?;
            Ok(state
                .remote_dashboard_baselines
                .changes(snapshot, input.base_digest.as_deref()))
        });
    }
    crate::ipc::catalogue::dispatch(state, channel, input, default_agent)
}

pub(crate) fn parse<T: DeserializeOwned>(channel: &str, input: Value) -> ArgmaxResult<T> {
    serde_json::from_value(input).map_err(|error| {
        ArgmaxError::invalid(InvalidInputIssue::at(
            vec!["input".to_string()],
            "REMOTE_INPUT_INVALID",
            format!("{channel}: {error}"),
        ))
    })
}

pub(crate) fn encode<T: Serialize>(value: T) -> ArgmaxResult<Value> {
    serde_json::to_value(value)
        .map_err(|error| ArgmaxError::service("REMOTE_ENCODE_FAILED", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::REGISTERED_CHANNELS;
    use crate::persistence::Database;
    use std::sync::Arc;

    #[tokio::test]
    async fn every_registered_channel_is_implemented_or_declared_unsupported() {
        let state = AppState::new();
        let mut unknown = Vec::new();

        for channel in REGISTERED_CHANNELS {
            if crate::ipc::catalogue::COMMAND_CONTRACTS
                .iter()
                .any(|entry| {
                    entry.channel == *channel
                        && entry.remote == crate::ipc::catalogue::RemoteAccess::Desktop
                })
            {
                continue;
            }
            // `Value::Null` fails every input parse, so a handled channel
            // reports invalid input long before it touches a service.
            let error = dispatch(&state, channel, Value::Null)
                .await
                .expect_err("garbage input never succeeds");
            if is_service_error(&error, "UNKNOWN_CHANNEL") {
                unknown.push(*channel);
            }
        }

        assert!(
            unknown.is_empty(),
            "channels missing from the remote dispatcher: {}",
            unknown.join(", ")
        );
    }

    #[tokio::test]
    async fn dispatch_reads_the_live_database_and_rejects_native_channels() {
        let state = AppState::new();
        assert!(state
            .db
            .set(Arc::new(Database::open_in_memory().expect("open database")))
            .is_ok());

        let ping = dispatch(&state, "health:ping", serde_json::json!({}))
            .await
            .expect("health ping");
        assert_eq!(ping["ok"], true);

        let dashboard = dispatch(&state, "dashboard:list", serde_json::json!({}))
            .await
            .expect("dashboard list");
        assert!(dashboard["projects"]
            .as_array()
            .expect("projects array")
            .is_empty());

        let unsupported = dispatch(
            &state,
            "system:set-theme",
            serde_json::json!({"mode": "dark"}),
        )
        .await
        .expect_err("native channel rejected");
        assert!(is_service_error(&unsupported, "REMOTE_UNSUPPORTED"));

        let unknown = dispatch(&state, "nope:nope", Value::Null)
            .await
            .expect_err("unknown channel rejected");
        assert!(is_service_error(&unknown, "UNKNOWN_CHANNEL"));
    }

    #[tokio::test]
    async fn remote_can_save_an_image_into_the_host_attachment_store() {
        let dir = tempfile::tempdir().expect("attachment directory");
        let state = AppState::new();
        state
            .attachments
            .set(Arc::new(
                crate::attachments::store::AttachmentStore::with_base_dir(dir.path()),
            ))
            .expect("attachment store once cell");

        let saved = dispatch(
            &state,
            "attachments:save-image",
            serde_json::json!({
                "sessionId": "launch-mobile",
                "mimeType": "image/png",
                "dataBase64": "TQ=="
            }),
        )
        .await
        .expect("save image over remote bridge");

        assert_eq!(saved["sizeBytes"], 1);
        let path = saved["filePath"].as_str().expect("saved file path");
        assert!(path.starts_with(&dir.path().to_string_lossy().to_string()));
        assert_eq!(std::fs::read(path).expect("saved image"), b"M");
    }

    /// The phone pairs itself, so the whole push-device round trip has to
    /// work with nothing but `&AppState` — no `AppHandle` in reach.
    #[tokio::test]
    async fn a_phone_pairs_and_unpairs_itself_over_the_bridge() {
        let dir = tempfile::tempdir().expect("app data dir");
        let state = AppState::new();
        state
            .app_data_dir
            .set(dir.path().to_path_buf())
            .expect("app data dir once cell");

        let paired = dispatch(
            &state,
            "remote:register-push-device",
            serde_json::json!({"token": "A1B2C3D4", "name": "Adam's iPhone"}),
        )
        .await
        .expect("register over remote bridge");
        assert_eq!(paired.as_array().expect("devices").len(), 1);
        assert_eq!(paired[0]["token"], "a1b2c3d4", "tokens are normalized");
        assert_eq!(paired[0]["name"], "Adam's iPhone");

        // Apple hands the app the same token on the next launch, and the app
        // re-registers unconditionally. That is a rename, not a second row.
        let repaired = dispatch(
            &state,
            "remote:register-push-device",
            serde_json::json!({"token": "a1b2c3d4", "name": "Work iPhone"}),
        )
        .await
        .expect("re-register over remote bridge");
        assert_eq!(repaired.as_array().expect("devices").len(), 1);
        assert_eq!(repaired[0]["name"], "Work iPhone");

        let persisted = crate::remote::load_or_create_config(dir.path());
        assert_eq!(persisted.apns.devices.len(), 1);
        assert_eq!(persisted.apns.devices[0].name, "Work iPhone");

        let remaining = dispatch(
            &state,
            "remote:unregister-push-device",
            serde_json::json!({"token": "a1b2c3d4"}),
        )
        .await
        .expect("unregister over remote bridge");
        assert!(remaining.as_array().expect("devices").is_empty());
        assert!(crate::remote::load_or_create_config(dir.path())
            .apns
            .devices
            .is_empty());
    }

    /// Reachability is the point: the test push has to fail on *its own*
    /// error, not on `REMOTE_UNSUPPORTED`.
    #[tokio::test]
    async fn a_test_push_with_no_paired_phone_reports_that_and_not_unsupported() {
        let dir = tempfile::tempdir().expect("app data dir");
        let state = AppState::new();
        state
            .app_data_dir
            .set(dir.path().to_path_buf())
            .expect("app data dir once cell");

        let error = dispatch(&state, "remote:push-test", serde_json::json!({}))
            .await
            .expect_err("no phone is paired");

        assert!(
            matches!(&error, ArgmaxError::InvalidInput { issues, .. }
                if issues.iter().any(|issue| issue.code == "APNS_NO_DEVICES")),
            "unexpected error: {error:?}"
        );
    }

    #[tokio::test]
    async fn push_capability_reports_whether_the_host_holds_a_key() {
        let dir = tempfile::tempdir().expect("app data dir");
        let state = AppState::new();
        state
            .app_data_dir
            .set(dir.path().to_path_buf())
            .expect("app data dir once cell");

        let unconfigured = dispatch(&state, "remote:push-capability", serde_json::json!({}))
            .await
            .expect("capability over remote bridge");
        assert_eq!(unconfigured["configured"], false);

        let mut config = crate::remote::load_or_create_config(dir.path());
        config.apns.key_path = Some("/keys/AuthKey_ABC1234567.p8".to_string());
        config.apns.key_id = Some("ABC1234567".to_string());
        config.apns.team_id = Some("TEAM123456".to_string());
        crate::remote::save_config(dir.path(), &config).expect("save");

        let configured = dispatch(&state, "remote:push-capability", serde_json::json!({}))
            .await
            .expect("capability over remote bridge");
        assert_eq!(configured["configured"], true);
    }

    #[tokio::test]
    async fn malformed_input_is_reported_as_invalid_not_a_panic() {
        let state = AppState::new();

        let error = dispatch(&state, "session:search", serde_json::json!({"query": 7}))
            .await
            .expect_err("bad query type rejected");

        assert!(matches!(error, ArgmaxError::InvalidInput { .. }));
    }

    fn is_service_error(error: &ArgmaxError, expected: &str) -> bool {
        matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == expected)
    }
}
