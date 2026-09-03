//! Grok Build sessions: `~/.grok/sessions/<percent-encoded cwd>/<sessionId>/updates.jsonl`.
//!
//! One `turn_completed` update closes each turn and carries the whole turn's
//! usage, already broken down per model in `modelUsage`. Grok also reports its
//! own cost in `costUsdTicks` (USD x 1e10), which beats the list-price table
//! because the CLI bills its own `-build` SKUs rather than xAI's API rates.

use serde_json::{Map, Value};

use crate::ipc::validation::ProviderId;
use crate::providers::normalizer::{number_value, object_value, string_value};
use crate::usage::records::{
    line_may_carry_usage, TranscriptContext, UsageRecord, UsageRecordTokens,
};

/// `costUsdTicks` is USD scaled by 1e10.
const TICKS_PER_USD: f64 = 1e10;

/// Model name for a turn whose `modelUsage` map is empty, so the tokens still
/// land somewhere the page can show.
const UNNAMED_MODEL: &str = "grok";

/// Turns one Grok `updates.jsonl` (or the tail of one) into usage records, one
/// per model that billed in each completed turn.
pub fn parse_grok_updates(text: &str, ctx: &TranscriptContext) -> Vec<UsageRecord> {
    let project_path = project_path_from_source(ctx.source_path);
    let path_session = ctx
        .session_id_hint
        .map(str::to_string)
        .or_else(|| session_id_from_path(ctx.source_path));
    let mut records = Vec::new();

    for line in text.lines() {
        if !line_may_carry_usage(line) {
            continue;
        }
        let Ok(Value::Object(row)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        records.extend(turn_records(&row, path_session.as_deref(), &project_path));
    }

    records
}

fn turn_records(
    row: &Map<String, Value>,
    path_session: Option<&str>,
    project_path: &Option<String>,
) -> Vec<UsageRecord> {
    let Some(params) = object_value(row.get("params")) else {
        return Vec::new();
    };
    let Some(update) = object_value(params.get("update")) else {
        return Vec::new();
    };
    if string_value(update.get("sessionUpdate")) != Some("turn_completed") {
        return Vec::new();
    }
    let Some(usage) = object_value(update.get("usage")) else {
        return Vec::new();
    };
    let Some(session_id) = string_value(params.get("sessionId"))
        .map(str::to_string)
        .or_else(|| path_session.map(str::to_string))
    else {
        return Vec::new();
    };
    let Some(at_ms) = timestamp_ms(row, params) else {
        return Vec::new();
    };
    let prompt_id = string_value(update.get("prompt_id"));

    let mut per_model = model_entries(usage);
    allocate_cost(&mut per_model, usage);

    per_model
        .into_iter()
        .filter(|entry| !entry.tokens.is_empty())
        .map(|entry| UsageRecord {
            provider: ProviderId::Grok,
            session_id: session_id.clone(),
            at_ms,
            tokens: entry.tokens,
            reported_cost_usd: entry.cost_usd,
            dedupe_key: prompt_id
                .map(|prompt| format!("grok:{session_id}:{prompt}:{}", entry.model_id)),
            project_path: project_path.clone(),
            model_id: entry.model_id,
        })
        .collect()
}

struct ModelEntry {
    model_id: String,
    tokens: UsageRecordTokens,
    /// Tokens this entry billed, the basis for its share of an aggregate cost.
    billed_tokens: i64,
    cost_usd: Option<f64>,
}

/// One entry per model named in `modelUsage`, or a single unnamed entry
/// carrying the turn total when the map is empty.
fn model_entries(usage: &Map<String, Value>) -> Vec<ModelEntry> {
    let Some(model_usage) = object_value(usage.get("modelUsage")).filter(|map| !map.is_empty())
    else {
        return vec![entry(UNNAMED_MODEL.to_string(), usage)];
    };
    model_usage
        .iter()
        .filter_map(|(model_id, value)| {
            object_value(Some(value)).map(|counts| entry(model_id.clone(), counts))
        })
        .collect()
}

fn entry(model_id: String, counts: &Map<String, Value>) -> ModelEntry {
    let input = number_value(counts.get("inputTokens")) as i64;
    let cache_read = number_value(counts.get("cachedReadTokens")) as i64;
    let cache_write = number_value(counts.get("cacheCreationTokens")) as i64;
    let output = number_value(counts.get("outputTokens")) as i64;
    let total = match number_value(counts.get("totalTokens")) as i64 {
        0 => input + output,
        total => total,
    };
    ModelEntry {
        model_id,
        tokens: UsageRecordTokens {
            // Grok's `inputTokens` counts the cached reads it served.
            input_uncached: (input - cache_read).max(0),
            cache_read,
            cache_write_5m: cache_write,
            cache_write_1h: 0,
            output,
            reasoning: number_value(counts.get("reasoningTokens")) as i64,
        },
        billed_tokens: total,
        cost_usd: ticks_to_usd(counts.get("costUsdTicks")),
    }
}

/// A model entry that ticked its own cost keeps it. Whatever the turn's
/// aggregate ticks leave over is split across the entries that did not, by
/// token share, so a turn's records still sum to what Grok charged.
fn allocate_cost(entries: &mut [ModelEntry], usage: &Map<String, Value>) {
    let unticked: i64 = entries
        .iter()
        .filter(|entry| entry.cost_usd.is_none())
        .map(|entry| entry.billed_tokens)
        .sum();
    if unticked <= 0 {
        return;
    }
    let Some(aggregate) = ticks_to_usd(usage.get("costUsdTicks")) else {
        return;
    };
    let claimed: f64 = entries.iter().filter_map(|entry| entry.cost_usd).sum();
    let remainder = (aggregate - claimed).max(0.0);
    for entry in entries.iter_mut().filter(|entry| entry.cost_usd.is_none()) {
        entry.cost_usd = Some(remainder * entry.billed_tokens as f64 / unticked as f64);
    }
}

fn ticks_to_usd(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .map(|ticks| ticks / TICKS_PER_USD)
}

/// `_meta.agentTimestampMs` is the agent's own clock in milliseconds; the
/// line's top-level `timestamp` is whole seconds.
fn timestamp_ms(row: &Map<String, Value>, params: &Map<String, Value>) -> Option<i64> {
    object_value(params.get("_meta"))
        .and_then(|meta| meta.get("agentTimestampMs"))
        .and_then(Value::as_i64)
        .or_else(|| {
            row.get("timestamp")
                .and_then(Value::as_i64)
                .map(|s| s * 1000)
        })
}

fn session_id_from_path(path: &std::path::Path) -> Option<String> {
    path.parent()?.file_name()?.to_str().map(str::to_string)
}

/// The directory above the session is the working directory, percent-encoded.
fn project_path_from_source(path: &std::path::Path) -> Option<String> {
    let encoded = path.parent()?.parent()?.file_name()?.to_str()?;
    crate::attachments::protocol::percent_decode(encoded).ok()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    const SOURCE: &str = "/Users/a/.grok/sessions/%2FUsers%2Fa%2Fdev%2Fmenti%2Fargmax/01a05e06-f76c-73b2-875b-a93d02cce3e3/updates.jsonl";

    fn context(path: &Path) -> TranscriptContext<'_> {
        TranscriptContext {
            source_path: path,
            session_id_hint: None,
        }
    }

    #[test]
    fn splits_a_single_model_turn_and_decodes_the_project_path() {
        let text = include_str!("../../tests/fixtures/usage/grok-single-model.jsonl");
        let records = parse_grok_updates(text, &context(Path::new(SOURCE)));

        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.model_id, "grok-4.6-build");
        assert_eq!(record.tokens.cache_read, 1_556_096);
        assert_eq!(record.tokens.input_uncached, 1_674_423 - 1_556_096);
        assert_eq!(record.tokens.output, 14_420);
        assert_eq!(record.tokens.reasoning, 13_797);
        assert_eq!(record.reported_cost_usd, Some(0.187_207_74));
        assert_eq!(record.at_ms, 1_788_284_260_474);
        assert_eq!(
            record.project_path.as_deref(),
            Some("/Users/a/dev/menti/argmax")
        );
        assert_eq!(
            record.dedupe_key.as_deref(),
            Some("grok:01a05e06-f76c-73b2-875b-a93d02cce3e3:bca674fb-5157-40c6-98d4-2b46cff95a9d:grok-4.6-build")
        );
    }

    #[test]
    fn two_ticked_models_keep_their_own_cost() {
        let text = include_str!("../../tests/fixtures/usage/grok-two-models.jsonl");
        let records = parse_grok_updates(text, &context(Path::new(SOURCE)));

        assert_eq!(records.len(), 2);
        let mut by_model: Vec<(&str, f64)> = records
            .iter()
            .map(|record| {
                (
                    record.model_id.as_str(),
                    record.reported_cost_usd.expect("ticked"),
                )
            })
            .collect();
        by_model.sort_by(|left, right| left.0.cmp(right.0));
        assert_eq!(by_model[0].0, "grok-4.5-build");
        assert_eq!(by_model[1].0, "grok-4.6-build");
        assert!((by_model[0].1 - 0.014_607_896).abs() < 1e-12);
        assert!((by_model[1].1 - 0.187_207_74).abs() < 1e-12);
        // The turn's records add up to what the turn charged.
        let total: f64 = by_model.iter().map(|(_, cost)| cost).sum();
        assert!((total - 0.201_815_636).abs() < 1e-12, "total {total}");
    }

    #[test]
    fn each_model_keeps_its_own_tokens() {
        let text = include_str!("../../tests/fixtures/usage/grok-two-models.jsonl");
        let records = parse_grok_updates(text, &context(Path::new(SOURCE)));
        let small = records
            .iter()
            .find(|record| record.model_id == "grok-4.5-build")
            .expect("second model");
        assert_eq!(small.tokens.output, 362);
        assert_eq!(small.tokens.cache_read, 128);
        assert_eq!(small.tokens.input_uncached, 20_505 - 128);
        assert_ne!(records[0].dedupe_key, records[1].dedupe_key);
    }

    #[test]
    fn an_unticked_model_pro_rates_the_leftover_cost() {
        let text = include_str!("../../tests/fixtures/usage/grok-prorated.jsonl");
        let records = parse_grok_updates(text, &context(Path::new(SOURCE)));

        assert_eq!(records.len(), 2);
        let ticked = records
            .iter()
            .find(|record| record.model_id == "grok-4.6-build")
            .expect("ticked model");
        let unticked = records
            .iter()
            .find(|record| record.model_id == "grok-4.5-build")
            .expect("unticked model");

        assert!((ticked.reported_cost_usd.expect("cost") - 0.187_207_74).abs() < 1e-12);
        // Aggregate 0.201815636 minus the ticked 0.18720774, all of it to the
        // one model that reported no ticks of its own.
        assert!(
            (unticked.reported_cost_usd.expect("cost") - 0.014_607_896).abs() < 1e-12,
            "got {:?}",
            unticked.reported_cost_usd
        );
    }

    #[test]
    fn two_unticked_models_split_the_turn_by_token_share() {
        let text = include_str!("../../tests/fixtures/usage/grok-two-models.jsonl")
            .replace("\"costUsdTicks\":1872077400", "\"noTicks\":1872077400")
            .replace("\"costUsdTicks\":146078960", "\"noTicks\":146078960");
        let records = parse_grok_updates(&text, &context(Path::new(SOURCE)));

        assert_eq!(records.len(), 2);
        let aggregate = 0.201_815_636_f64;
        let shares = 1_688_843.0 + 20_867.0;
        for record in &records {
            let billed = if record.model_id == "grok-4.6-build" {
                1_688_843.0
            } else {
                20_867.0
            };
            let expected = aggregate * billed / shares;
            assert!(
                (record.reported_cost_usd.expect("prorated") - expected).abs() < 1e-12,
                "{} got {:?} expected {expected}",
                record.model_id,
                record.reported_cost_usd
            );
        }
    }

    #[test]
    fn a_turn_without_a_model_map_still_counts_its_tokens() {
        let text = include_str!("../../tests/fixtures/usage/grok-single-model.jsonl").replace(
            "\"modelUsage\":{\"grok-4.6-build\":",
            "\"unusedModelUsage\":{\"x\":",
        );
        let records = parse_grok_updates(&text, &context(Path::new(SOURCE)));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].model_id, "grok");
        assert_eq!(records[0].tokens.output, 14_420);
        assert_eq!(records[0].reported_cost_usd, Some(0.187_207_74));
    }

    #[test]
    fn a_turn_without_a_prompt_id_cannot_be_deduped() {
        let text = include_str!("../../tests/fixtures/usage/grok-single-model.jsonl")
            .replace("\"prompt_id\"", "\"promptless\"");
        let records = parse_grok_updates(&text, &context(Path::new(SOURCE)));
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].dedupe_key, None);
    }

    #[test]
    fn malformed_lines_are_skipped_without_panicking() {
        let text = "{\"params\":{\"update\":{\"sessionUpdate\":\"turn_completed\"\n\nnope\n{\"params\":{\"update\":{\"sessionUpdate\":\"turn_completed\",\"usage\":{}}}}\n";
        assert!(parse_grok_updates(text, &context(Path::new(SOURCE))).is_empty());
    }
}
