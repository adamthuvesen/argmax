use crate::usage::records::UsageRecordTokens;
use crate::util::sync::LockOrRecover;
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
    // Fable 5.1 keeps Fable 5's per-token rates; cache reads are a quarter of Fable 5's.
    "claude-fable-5-1" => ModelPricing { input: 10.0, output: 50.0, cache_read: 0.25, cache_write: 12.5 },
    "claude-opus-5" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
    "claude-sonnet-5" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-4-5" => ModelPricing { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
    "gpt-5.6-sol" => ModelPricing { input: 5.0, output: 30.0, cache_read: 0.5, cache_write: 6.25 },
    "gpt-5.6-terra" => ModelPricing { input: 2.0, output: 12.0, cache_read: 0.2, cache_write: 2.5 },
    "gpt-5.6-luna" => ModelPricing { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
    "composer-2.5" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "cursor-grok-4.6-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gemini-3.8-flash-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.6-luna-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.6-terra-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.6-sol-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "claude-opus-5-thinking-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    // OpenCode Zen free tier — ids keep the `opencode/` provider prefix the
    // CLI's `-m` flag expects. All bill $0.
    "opencode/big-pickle" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "opencode/hy3-free" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "opencode/mimo-v2.5-free" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "opencode/nemotron-3.5-lightning-free" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "opencode/nemotron-3-ultra-free" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "opencode/muse-spark-1.3-contributor-free" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    // OpenCode Go (opencode-go/*) — billed per-token models.
    "opencode-go/glm-5.3-flash" => ModelPricing { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0.0 },
    "opencode-go/glm-5.3" => ModelPricing { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0.0 },
    "opencode-go/kimi-k3" => ModelPricing { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 0.0 },
    "opencode-go/qwen3.8-max" => ModelPricing { input: 2.0, output: 6.0, cache_read: 0.25, cache_write: 2.5 },
    "opencode-go/qwen3.8-flash" => ModelPricing { input: 0.15, output: 0.47, cache_read: 0.016, cache_write: 0.2 },
    "opencode-go/deepseek-v4-pro" => ModelPricing { input: 0.66, output: 1.98, cache_read: 0.022, cache_write: 0.0 },
    "opencode-go/deepseek-v4-flash" => ModelPricing { input: 0.22, output: 0.66, cache_read: 0.007, cache_write: 0.0 },
    // Grok Build bills its own SKUs (`grok-4.6-build` / `grok-4.5-build` in the
    // CLI's modelUsage map), not xAI's public API list price. Rates below were
    // solved from the CLI's own `total_cost_usd` across runs with varied token
    // mixes and reproduce it exactly; grok-4.6 lands at 0.17x the published API
    // rate and grok-4.5 at 0.34x. Cache writes are never billed separately
    // (cache_creation_input_tokens is always 0). Re-derive if xAI reprices.
    "grok-4.6" => ModelPricing { input: 0.34, output: 1.02, cache_read: 0.085, cache_write: 0.0 },
    "grok-4.5" => ModelPricing { input: 0.68, output: 2.04, cache_read: 0.102, cache_write: 0.0 },
    // The same SKUs as the CLI's `modelUsage` map spells them in its session
    // logs, so the usage ledger can price cache savings for Grok turns.
    "grok-4.6-build" => ModelPricing { input: 0.34, output: 1.02, cache_read: 0.085, cache_write: 0.0 },
    "grok-4.5-build" => ModelPricing { input: 0.68, output: 2.04, cache_read: 0.102, cache_write: 0.0 },
};

static STORED_MODEL_PRICING_ALIASES: phf::Map<&'static str, ModelPricing> = phf_map! {
    "claude-fable-5" => ModelPricing { input: 10.0, output: 50.0, cache_read: 1.0, cache_write: 12.5 },
    "claude-opus-4-8" => ModelPricing { input: 5.0, output: 25.0, cache_read: 0.5, cache_write: 6.25 },
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
    "gpt-5.5" => ModelPricing { input: 5.0, output: 30.0, cache_read: 0.5, cache_write: 0.0 },
    "gpt-5.5-pro" => ModelPricing { input: 30.0, output: 180.0, cache_read: 0.0, cache_write: 0.0 },
    "o4-mini" => ModelPricing { input: 1.1, output: 4.4, cache_read: 0.275, cache_write: 0.0 },
    "claude-opus-4-8-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "claude-opus-4-7-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gpt-5.5-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gemini-3.5-flash" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gemini-3.6-flash-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "gemini-3.7-flash-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
    "cursor-grok-4.5-medium" => ModelPricing { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
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
            .lock_or_recover("unknown-model log")
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

/// The list price for a model, across both the picker table and the aliases
/// kept for ids only old sessions still carry. `None` is a model the table
/// does not know: the usage page counts its tokens and shows it as unpriced
/// rather than claiming a dollar figure it cannot stand behind.
pub fn list_price(model_id: &str) -> Option<ModelPricing> {
    let key = normalize_model_id(model_id);
    MODEL_PRICING
        .get(key.as_str())
        .or_else(|| STORED_MODEL_PRICING_ALIASES.get(key.as_str()))
        .copied()
}

/// Anthropic bills a 1 h cache write at 2x the input rate and a 5 m write at
/// 1.25x. `ModelPricing::cache_write` holds the 5 m rate, which is what every
/// existing caller means by a cache write. Only Claude transcripts report the
/// split (`cache_creation.ephemeral_1h_input_tokens`), so this rate applies to
/// Claude records alone.
pub fn cache_write_1h_rate(price: &ModelPricing) -> f64 {
    price.input * 2.0
}

/// List-price cost of one usage record, or `None` for a model the table does
/// not know.
pub fn price_record(tokens: &UsageRecordTokens, model_id: &str) -> Option<f64> {
    let price = list_price(model_id)?;
    let million = 1_000_000.0;
    Some(
        (tokens.input_uncached as f64 * price.input
            + tokens.cache_read as f64 * price.cache_read
            + tokens.cache_write_5m as f64 * price.cache_write
            + tokens.cache_write_1h as f64 * cache_write_1h_rate(&price)
            + tokens.output as f64 * price.output)
            / million,
    )
}

/// What the cache reads in this record would have cost at the uncached input
/// rate, minus what they did cost. Clamped at zero: a model priced with cache
/// reads dearer than fresh input saves nothing.
pub fn cache_savings(tokens: &UsageRecordTokens, price: &ModelPricing) -> f64 {
    ((tokens.cache_read as f64 * (price.input - price.cache_read)) / 1_000_000.0).max(0.0)
}

fn logged_unknown_models() -> &'static Mutex<HashSet<String>> {
    static LOGGED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    LOGGED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(test)]
pub fn reset_unknown_model_log_for_test() {
    logged_unknown_models()
        .lock_or_recover("unknown-model log")
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
    fn prices_persisted_model_ids_missing_from_the_picker_table() {
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
    fn codex_auto_review_is_unpriced() {
        // Codex's own reviewer model has no published rate. It must stay out
        // of both tables so the usage page counts its tokens and says
        // "unpriced" instead of quietly billing them at $0.
        assert_eq!(normalize_model_id("codex-auto-review"), "codex-auto-review");
        assert!(list_price("codex-auto-review").is_none());
        assert_eq!(
            price_record(
                &UsageRecordTokens {
                    input_uncached: 10_000,
                    cache_read: 500_000,
                    output: 4_000,
                    ..UsageRecordTokens::default()
                },
                "codex-auto-review",
            ),
            None,
        );
    }

    #[test]
    fn one_hour_cache_writes_bill_at_twice_input() {
        let price = list_price("claude-fable-5-1").expect("known model");
        assert_eq!(cache_write_1h_rate(&price), 20.0);
        assert_eq!(price.cache_write, 12.5);
        assert_eq!(
            price_record(
                &UsageRecordTokens {
                    cache_write_1h: 1_000_000,
                    ..UsageRecordTokens::default()
                },
                "claude-fable-5-1",
            ),
            Some(20.0),
        );
        assert_eq!(
            price_record(
                &UsageRecordTokens {
                    cache_write_5m: 1_000_000,
                    ..UsageRecordTokens::default()
                },
                "claude-fable-5-1",
            ),
            Some(12.5),
        );
    }

    #[test]
    fn cache_savings_is_the_uncached_premium_never_negative() {
        let price = list_price("claude-opus-5").expect("known model");
        assert_eq!(
            cache_savings(
                &UsageRecordTokens {
                    cache_read: 1_000_000,
                    ..UsageRecordTokens::default()
                },
                &price,
            ),
            4.5,
        );
        let free = list_price("opencode/big-pickle").expect("known model");
        assert_eq!(
            cache_savings(
                &UsageRecordTokens {
                    cache_read: 1_000_000,
                    ..UsageRecordTokens::default()
                },
                &free,
            ),
            0.0,
        );
    }

    #[test]
    fn list_price_reaches_both_tables_and_strips_date_suffixes() {
        assert!(list_price("claude-opus-5").is_some());
        assert!(list_price("claude-sonnet-4-6").is_some());
        assert_eq!(
            list_price("claude-sonnet-4-6-20250101"),
            list_price("claude-sonnet-4-6"),
        );
        assert!(list_price("mystery-model").is_none());
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
