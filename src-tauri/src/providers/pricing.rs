use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

use phf::phf_map;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

pub static MODEL_PRICING: phf::Map<&'static str, ModelPricing> = phf_map! {
    "claude-fable-5" => ModelPricing { input: 10.0, output: 50.0, cache_read: 1.0, cache_write: 12.5 },
    "claude-opus-4-8" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    "claude-sonnet-5" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-4-5" => ModelPricing { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
    "gpt-5.5" => ModelPricing { input: 5.0, output: 30.0, cache_read: 0.5, cache_write: 0.0 },
    "composer-2.5" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gemini-3.5-flash" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "claude-opus-4-8-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.5-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
};

static STORED_MODEL_PRICING_ALIASES: phf::Map<&'static str, ModelPricing> = phf_map! {
    "claude-opus-4-7" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-6" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-5" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-1" => ModelPricing { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
    "claude-opus-4" => ModelPricing { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
    "claude-sonnet-4-6" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4-5" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-sonnet-4" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-3-7-sonnet" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-3-5-haiku" => ModelPricing { input: 0.8, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
    "claude-3-opus" => ModelPricing { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
    "claude-3-haiku" => ModelPricing { input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.3 },
    "gpt-5" => ModelPricing { input: 1.25, output: 10.0, cache_read: 0.125, cache_write: 0.0 },
    "gpt-5-codex" => ModelPricing { input: 1.25, output: 10.0, cache_read: 0.125, cache_write: 0.0 },
    "gpt-5-codex-mini" => ModelPricing { input: 0.25, output: 2.0, cache_read: 0.025, cache_write: 0.0 },
    "gpt-5.1" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.1-codex-max" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.1-codex-mini" => ModelPricing { input: 0.25, output: 2.0, cache_read: 0.025, cache_write: 0.0 },
    "gpt-5.2" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.2-codex" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.3" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.3-codex" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.3-chat-latest" => ModelPricing { input: 1.75, output: 14.0, cache_read: 0.175, cache_write: 0.0 },
    "gpt-5.4" => ModelPricing { input: 2.5, output: 15.0, cache_read: 0.25, cache_write: 0.0 },
    "gpt-5.4-codex" => ModelPricing { input: 2.5, output: 15.0, cache_read: 0.25, cache_write: 0.0 },
    "gpt-5.4-mini" => ModelPricing { input: 0.75, output: 4.5, cache_read: 0.075, cache_write: 0.0 },
    "gpt-5.4-nano" => ModelPricing { input: 0.2, output: 1.25, cache_read: 0.02, cache_write: 0.0 },
    "gpt-5.4-pro" => ModelPricing { input: 30.0, output: 180.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.5-pro" => ModelPricing { input: 30.0, output: 180.0, cache_read: 0.0, cache_write: 0.0 },
    "o4-mini" => ModelPricing { input: 1.1, output: 4.4, cache_read: 0.275, cache_write: 0.0 },
    "claude-opus-4-7-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
};

pub fn normalize_model_id(model_id: &str) -> String {
    let bytes = model_id.as_bytes();
    if bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit)
    {
        model_id[..model_id.len() - 9].to_string()
    } else {
        model_id.to_string()
    }
}

pub fn cost_of(usage: UsageCounts, model_id: &str) -> f64 {
    let key = normalize_model_id(model_id);
    let Some(price) = MODEL_PRICING
        .get(key.as_str())
        .or_else(|| STORED_MODEL_PRICING_ALIASES.get(key.as_str()))
    else {
        let logged = logged_unknown_models();
        if logged
            .lock()
            .expect("unknown-model log mutex")
            .insert(key.clone())
        {
            tracing::warn!(target: "pricing", model_id, normalized = key, "unknown model id");
        }
        return 0.0;
    };
    let million = 1_000_000.0;
    (usage.input as f64 * price.input) / million
        + (usage.output as f64 * price.output) / million
        + (usage.cache_read as f64 * price.cache_read) / million
        + (usage.cache_write as f64 * price.cache_write) / million
}

fn logged_unknown_models() -> &'static Mutex<HashSet<String>> {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOGGED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(test)]
pub fn reset_unknown_model_log_for_test() {
    logged_unknown_models()
        .lock()
        .expect("unknown-model log mutex")
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_date_suffix() {
        assert_eq!(normalize_model_id("gpt-5.5-20260524"), "gpt-5.5");
        assert_eq!(normalize_model_id("gpt-5.5-medium"), "gpt-5.5-medium");
    }

    #[test]
    fn computes_cost_from_million_token_rates() {
        let cost = cost_of(
            UsageCounts {
                input: 1_000_000,
                output: 500_000,
                cache_read: 100_000,
                cache_write: 10_000,
            },
            "gpt-5.5",
        );
        assert_eq!(cost, 20.05);
    }

    #[test]
    fn prices_stored_legacy_ids_without_restoring_them_to_the_model_table() {
        assert!(MODEL_PRICING.get("claude-sonnet-4-6").is_none());
        assert!(MODEL_PRICING.get("gpt-5.4-codex").is_none());
        assert!(MODEL_PRICING.get("o4-mini").is_none());
        assert_eq!(
            cost_of(
                UsageCounts {
                    input: 1_000_000,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                "claude-sonnet-4-6",
            ),
            3.0,
        );
        assert_eq!(
            cost_of(
                UsageCounts {
                    input: 1_000_000,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                "claude-sonnet-4-6-20250101",
            ),
            3.0,
        );
        assert_eq!(
            cost_of(
                UsageCounts {
                    input: 1_000_000,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                "gpt-5.4-codex",
            ),
            2.5,
        );
        assert_eq!(
            cost_of(
                UsageCounts {
                    input: 1_000_000,
                    output: 0,
                    cache_read: 0,
                    cache_write: 0,
                },
                "o4-mini",
            ),
            1.1,
        );
    }

    #[test]
    fn unknown_models_cost_zero() {
        reset_unknown_model_log_for_test();
        assert_eq!(
            cost_of(
                UsageCounts {
                    input: 1,
                    output: 1,
                    cache_read: 1,
                    cache_write: 1,
                },
                "mystery",
            ),
            0.0,
        );
    }
}
