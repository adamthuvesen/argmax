//! Which gateway OpenCode's models run through: OpenRouter or Vercel AI
//! Gateway, chosen in Settings → Agents.
//!
//! The catalog keeps OpenRouter's ids (`openrouter/<vendor>/<model>`) as the
//! one stored spelling, so chats, pricing and routing never fork on the
//! gateway. A launch maps the id to the selected gateway's provider and slug
//! and hands OpenCode the gateway's settings in its inline config. Both
//! gateways are OpenCode built-ins (`openrouter`, `vercel`), so nothing here
//! proxies a request.
//!
//! A key saved in Argmax goes in that config as `options.apiKey`, which
//! OpenCode prefers over the one `opencode auth login` stored. Without one,
//! OpenCode's own login for that gateway is used, as before this setting.

use std::sync::RwLock;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use super::model_catalogue::{ModelId, VERCEL_SLUGS};
use crate::util::keychain::KeychainSecret;
use argmax_contracts::error::{ArgmaxError, ArgmaxResult};

const GATEWAY_KEY: &str = "opencode.gateway";

/// The provider prefix every catalog id carries.
const CATALOG_PROVIDER: &str = "openrouter";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OpencodeGateway {
    #[default]
    Openrouter,
    Vercel,
}

static OPENROUTER_KEY: KeychainSecret = KeychainSecret::new(
    "Argmax OpenRouter API key",
    "OpenRouter API key",
    "OPENCODE_GATEWAY_KEY_INVALID",
    "OPENCODE_GATEWAY_KEYCHAIN_FAILED",
);

static VERCEL_KEY: KeychainSecret = KeychainSecret::new(
    "Argmax Vercel AI Gateway API key",
    "Vercel AI Gateway API key",
    "OPENCODE_GATEWAY_KEY_INVALID",
    "OPENCODE_GATEWAY_KEYCHAIN_FAILED",
);

/// The choice, mirrored from `ui_state` so launch paths with no database
/// handle (one-shot helpers, the usage meter) read the same gateway.
static SELECTED: RwLock<OpencodeGateway> = RwLock::new(OpencodeGateway::Openrouter);

impl OpencodeGateway {
    /// OpenCode's provider id for the gateway.
    pub fn provider_id(self) -> &'static str {
        match self {
            Self::Openrouter => "openrouter",
            Self::Vercel => "vercel",
        }
    }

    pub fn key(self) -> &'static KeychainSecret {
        match self {
            Self::Openrouter => &OPENROUTER_KEY,
            Self::Vercel => &VERCEL_KEY,
        }
    }

    /// The `(providerID, modelID)` OpenCode should run a catalog model on.
    /// An id from another provider (a custom model) passes through unchanged.
    pub fn route<'a>(self, provider: &'a str, model: &'a str) -> (&'a str, &'a str) {
        if provider != CATALOG_PROVIDER {
            return (provider, model);
        }
        match self {
            Self::Openrouter => (provider, model),
            Self::Vercel => (
                self.provider_id(),
                VERCEL_SLUGS
                    .iter()
                    .find(|(openrouter, _)| *openrouter == model)
                    .map(|(_, vercel)| *vercel)
                    .unwrap_or(model),
            ),
        }
    }

    /// `<provider>/<model>` for a CLI `-m` flag.
    pub fn route_model_id(self, model_id: &ModelId) -> String {
        match model_id.split_once('/') {
            Some((provider, model)) => {
                let (provider, model) = self.route(provider, model);
                format!("{provider}/{model}")
            }
            None => model_id.to_string(),
        }
    }

    /// The gateway's part of OpenCode's inline config: its key, when Argmax
    /// holds one. Without one the config names nothing and OpenCode's own
    /// login for the gateway applies.
    pub fn inline_config(self, api_key: Option<&str>) -> Value {
        match api_key {
            Some(api_key) => {
                json!({ "provider": { self.provider_id(): { "options": { "apiKey": api_key } } } })
            }
            None => json!({}),
        }
    }
}

/// Proves a key works with one authenticated read: OpenRouter's key endpoint
/// or Vercel's credit balance, the same reads the Usage page makes. A
/// rejection and an unreachable gateway both refuse the save, with different
/// words, so a typo never reaches a turn.
pub fn check_key(gateway: OpencodeGateway, api_key: &str) -> ArgmaxResult<()> {
    let (url, name) = match gateway {
        OpencodeGateway::Openrouter => (crate::usage::remaining::opencode::USAGE_URL, "OpenRouter"),
        OpencodeGateway::Vercel => (
            crate::usage::remaining::opencode::VERCEL_CREDITS_URL,
            "Vercel AI Gateway",
        ),
    };
    // The Keychain is fenced too, so the save fails there with its own words.
    if argmax_process::environment::verification_requested() {
        return Ok(());
    }
    // Runs on a blocking thread (`read_off_main`), where a blocking client may
    // be built and dropped.
    let unverified = |error: reqwest::Error| {
        ArgmaxError::service(
            "OPENCODE_GATEWAY_KEY_UNVERIFIED",
            format!("Could not check the key with {name}, so it was not saved: {error}"),
        )
    };
    crate::util::tls::install_crypto_provider();
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .and_then(|client| {
            client
                .get(url)
                .header("Authorization", format!("Bearer {api_key}"))
                .header("Accept", "application/json")
                .send()
        })
        .map_err(unverified)?;
    match response.status().as_u16() {
        401 | 403 => Err(ArgmaxError::service(
            "OPENCODE_GATEWAY_KEY_REJECTED",
            format!("{name} rejected that key, so it was not saved."),
        )),
        _ => response.error_for_status().map(|_| ()).map_err(unverified),
    }
}

/// The gateway new launches use.
pub fn selected() -> OpencodeGateway {
    *SELECTED
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The selected gateway's inline config, with the key Argmax holds for it.
/// A Keychain that cannot be read fails the launch: an empty config would let
/// OpenCode fall back to its own login and bill a different account.
pub fn launch_config() -> ArgmaxResult<(OpencodeGateway, Value)> {
    let gateway = selected();
    let key = gateway.key().read()?;
    Ok((gateway, gateway.inline_config(key.as_deref())))
}

/// Reads the saved choice into the mirror. Called once the database opens; an
/// unreadable row reads as OpenRouter, the gateway every launch used before.
pub fn load(connection: &Connection) {
    let gateway =
        argmax_store::app_settings::read_ui_value(connection, GATEWAY_KEY).unwrap_or_default();
    *SELECTED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = gateway;
}

/// Saves the choice. It applies from the next launch; a running turn keeps the
/// gateway its OpenCode server started with.
pub fn select(connection: &Connection, gateway: OpencodeGateway) -> ArgmaxResult<()> {
    argmax_store::app_settings::write_ui_value(connection, GATEWAY_KEY, &gateway)?;
    *SELECTED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = gateway;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use argmax_contracts::validation::ProviderId;

    #[test]
    fn openrouter_keeps_catalog_ids() {
        let gateway = OpencodeGateway::Openrouter;
        assert_eq!(
            gateway.route("openrouter", "z-ai/glm-5.3"),
            ("openrouter", "z-ai/glm-5.3")
        );
        assert_eq!(
            gateway.route_model_id(&ModelId::resolve(
                ProviderId::Opencode,
                "openrouter/z-ai/glm-5.3-flash"
            )),
            "openrouter/z-ai/glm-5.3-flash"
        );
    }

    #[test]
    fn retired_deepseek_cli_ids_follow_the_successor_on_both_gateways() {
        for gateway in [OpencodeGateway::Openrouter, OpencodeGateway::Vercel] {
            assert_eq!(
                gateway.route_model_id(&ModelId::resolve(
                    ProviderId::Opencode,
                    "openrouter/deepseek/deepseek-v4.1-flash"
                )),
                format!(
                    "{}/deepseek/deepseek-v4.1-flash-1017",
                    gateway.provider_id()
                )
            );
        }
    }

    #[test]
    fn vercel_maps_every_catalog_model_to_its_slug() {
        let gateway = OpencodeGateway::Vercel;
        for (catalog, vercel) in [
            ("openrouter/z-ai/glm-5.3-flash", "vercel/zai/glm-5.3-flash"),
            ("openrouter/z-ai/glm-5.3", "vercel/zai/glm-5.3"),
            (
                "openrouter/deepseek/deepseek-v4.1-flash-1017",
                "vercel/deepseek/deepseek-v4.1-flash-1017",
            ),
            (
                "openrouter/deepseek/deepseek-v4-pro-0813",
                "vercel/deepseek/deepseek-v4-pro-0813",
            ),
            ("openrouter/moonshotai/kimi-k3", "vercel/moonshotai/kimi-k3"),
            (
                "openrouter/qwen/qwen3.8-max-0902",
                "vercel/alibaba/qwen3.8-max-0902",
            ),
            (
                "openrouter/qwen/qwen3.8-flash",
                "vercel/alibaba/qwen3.8-flash",
            ),
            (
                "openrouter/meta/muse-spark-1.3-contributor",
                "vercel/meta/muse-spark-1.3-contributor",
            ),
            ("openrouter/meta/muse-wonder", "vercel/meta/muse-wonder-1.0"),
        ] {
            assert_eq!(
                gateway.route_model_id(&ModelId::resolve(ProviderId::Opencode, catalog)),
                vercel,
                "{catalog}"
            );
        }
    }

    #[test]
    fn ids_from_other_providers_pass_through() {
        assert_eq!(
            OpencodeGateway::Vercel.route("anthropic", "claude-sonnet-5"),
            ("anthropic", "claude-sonnet-5")
        );
    }

    #[test]
    fn a_saved_key_goes_in_the_gateways_options() {
        let config = OpencodeGateway::Openrouter.inline_config(Some("sk-or-v1-0123456789abcdef"));
        assert_eq!(
            config["provider"]["openrouter"]["options"]["apiKey"],
            "sk-or-v1-0123456789abcdef"
        );
        assert!(config["provider"].get("vercel").is_none());
        let config = OpencodeGateway::Vercel.inline_config(Some("vck_0123456789abcdef"));
        assert_eq!(
            config["provider"]["vercel"]["options"]["apiKey"],
            "vck_0123456789abcdef"
        );
    }

    #[test]
    fn without_a_key_the_config_leaves_auth_to_opencode() {
        assert_eq!(OpencodeGateway::Vercel.inline_config(None), json!({}));
        assert_eq!(OpencodeGateway::Openrouter.inline_config(None), json!({}));
    }

    #[test]
    fn the_choice_round_trips_and_defaults_to_openrouter() {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(
                "CREATE TABLE ui_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);",
            )
            .expect("schema");
        load(&connection);
        assert_eq!(selected(), OpencodeGateway::Openrouter);
        select(&connection, OpencodeGateway::Vercel).expect("save");
        *SELECTED.write().unwrap() = OpencodeGateway::Openrouter;
        load(&connection);
        assert_eq!(selected(), OpencodeGateway::Vercel);
        select(&connection, OpencodeGateway::Openrouter).expect("restore");
    }
}
