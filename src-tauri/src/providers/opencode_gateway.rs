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

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::persistence::{sqlite_error, time::now_iso};
use crate::util::keychain::KeychainSecret;

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

/// Vercel slugs that differ from OpenRouter's, keyed by the OpenRouter model
/// part of a catalog id. Any other catalog model has the same slug on both,
/// checked against Vercel's catalog on 2026-10-15. Adding an OpenCode model
/// means checking its Vercel slug (docs/providers.md has the checklist).
const VERCEL_SLUGS: &[(&str, &str)] = &[
    ("z-ai/glm-5.3-flash", "zai/glm-5.3-flash"),
    ("z-ai/glm-5.3", "zai/glm-5.3"),
    ("qwen/qwen3.8-max-0902", "alibaba/qwen3.8-max-0902"),
    ("qwen/qwen3.8-flash", "alibaba/qwen3.8-flash"),
    ("meta/muse-wonder", "meta/muse-wonder-1.0"),
];

/// MiniMax M2.7 is in the picker for its speed: Groq served it at 367 tok/s
/// where its cheapest OpenRouter host ran near 50 (OpenRouter endpoint stats,
/// 2026-10-04).
const MINIMAX_M2_7: &str = "minimax/minimax-m2.7";

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
    pub fn route_model_id(self, model_id: &str) -> String {
        match model_id.split_once('/') {
            Some((provider, model)) => {
                let (provider, model) = self.route(provider, model);
                format!("{provider}/{model}")
            }
            None => model_id.to_string(),
        }
    }

    /// The gateway's part of OpenCode's inline config: its key, when Argmax
    /// holds one, and the MiniMax host preference.
    ///
    /// On OpenRouter MiniMax is pinned to Groq with no fallbacks, so a Groq
    /// outage fails the turn rather than quietly running it slowly. OpenCode
    /// passes a model's `options` through as OpenRouter's `provider` routing
    /// field. Vercel takes the same `options` as its gateway routing, but
    /// whether Groq serves MiniMax there is not established, so it is only
    /// preferred: a pin to a host that does not serve it would fail every turn.
    pub fn inline_config(self, api_key: Option<&str>) -> Value {
        let minimax = match self {
            Self::Openrouter => {
                json!({ "options": { "provider": { "only": ["groq"], "allow_fallbacks": false } } })
            }
            Self::Vercel => json!({ "options": { "order": ["groq"] } }),
        };
        let mut provider =
            json!({ "models": { self.route(CATALOG_PROVIDER, MINIMAX_M2_7).1: minimax } });
        if let Some(api_key) = api_key {
            provider["options"] = json!({ "apiKey": api_key });
        }
        json!({ "provider": { self.provider_id(): provider } })
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
    if super::verification::requested() {
        return Ok(());
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build();
    match agent
        .get(url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("Accept", "application/json")
        .call()
    {
        Ok(_) => Ok(()),
        Err(ureq::Error::Status(401 | 403, _)) => Err(ArgmaxError::service(
            "OPENCODE_GATEWAY_KEY_REJECTED",
            format!("{name} rejected that key, so it was not saved."),
        )),
        Err(error) => Err(ArgmaxError::service(
            "OPENCODE_GATEWAY_KEY_UNVERIFIED",
            format!("Could not check the key with {name}, so it was not saved: {error}"),
        )),
    }
}

/// The gateway new launches use.
pub fn selected() -> OpencodeGateway {
    *SELECTED
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The selected gateway's inline config, with the key Argmax holds for it.
pub fn launch_config() -> (OpencodeGateway, Value) {
    let gateway = selected();
    let key = gateway.key().stored();
    (gateway, gateway.inline_config(key.as_deref()))
}

/// Reads the saved choice into the mirror. Called once the database opens; an
/// unreadable row reads as OpenRouter, the gateway every launch used before.
pub fn load(connection: &Connection) {
    let stored: Option<String> = connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .and_then(|mut statement| {
            statement
                .query_row(params![GATEWAY_KEY], |row| row.get(0))
                .optional()
        })
        .unwrap_or(None);
    let gateway = stored
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default();
    *SELECTED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = gateway;
}

/// Saves the choice. It applies from the next launch; a running turn keeps the
/// gateway its OpenCode server started with.
pub fn select(connection: &Connection, gateway: OpencodeGateway) -> ArgmaxResult<()> {
    let value = serde_json::to_string(&gateway).map_err(crate::persistence::json_error)?;
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![GATEWAY_KEY, value, now_iso()])
        .map_err(sqlite_error)?;
    *SELECTED
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = gateway;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_keeps_catalog_ids() {
        let gateway = OpencodeGateway::Openrouter;
        assert_eq!(
            gateway.route("openrouter", "z-ai/glm-5.3"),
            ("openrouter", "z-ai/glm-5.3")
        );
        assert_eq!(
            gateway.route_model_id("openrouter/z-ai/glm-5.3-flash"),
            "openrouter/z-ai/glm-5.3-flash"
        );
    }

    #[test]
    fn vercel_maps_every_catalog_model_to_its_slug() {
        let gateway = OpencodeGateway::Vercel;
        for (catalog, vercel) in [
            ("openrouter/z-ai/glm-5.3-flash", "vercel/zai/glm-5.3-flash"),
            ("openrouter/z-ai/glm-5.3", "vercel/zai/glm-5.3"),
            (
                "openrouter/deepseek/deepseek-v4.1-flash",
                "vercel/deepseek/deepseek-v4.1-flash",
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
            (
                "openrouter/minimax/minimax-m2.7",
                "vercel/minimax/minimax-m2.7",
            ),
        ] {
            assert_eq!(gateway.route_model_id(catalog), vercel, "{catalog}");
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
    fn openrouter_config_pins_minimax_to_groq_and_carries_the_key() {
        let config = OpencodeGateway::Openrouter.inline_config(Some("sk-or-v1-0123456789abcdef"));
        let provider = &config["provider"]["openrouter"];
        assert_eq!(
            provider["models"]["minimax/minimax-m2.7"]["options"]["provider"]["only"],
            json!(["groq"])
        );
        assert_eq!(provider["options"]["apiKey"], "sk-or-v1-0123456789abcdef");
        assert!(config["provider"].get("vercel").is_none());
    }

    #[test]
    fn vercel_config_prefers_groq_and_leaves_the_key_to_opencode_without_one() {
        let config = OpencodeGateway::Vercel.inline_config(None);
        let provider = &config["provider"]["vercel"];
        assert_eq!(
            provider["models"]["minimax/minimax-m2.7"]["options"]["order"],
            json!(["groq"])
        );
        assert!(provider.get("options").is_none());
        assert!(config["provider"].get("openrouter").is_none());
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
