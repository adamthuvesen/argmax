//! Claude Code transcripts: `~/.claude/projects/<slug>/<sessionId>.jsonl` and
//! the sidechain files under `<slug>/<sessionId>/subagents/*.jsonl`.
//!
//! Usage rides on `type:"assistant"` lines under `message.usage`. Claude
//! writes one such line per content block of a message and repeats the same
//! usage on every one of them, so the block count would multiply a turn's
//! tokens by three or four without the `message.id` dedupe below.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::ipc::validation::ProviderId;
use crate::providers::normalizer::{number_value, object_value, string_value};
use crate::usage::records::{
    line_may_carry_usage, rfc3339_to_ms, TranscriptContext, UsageRecord, UsageRecordTokens,
};

/// Claude's placeholder model for rows it generated without calling the API.
/// The usage block is a copy of the previous real call, so counting it would
/// bill the same tokens twice.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// Turns one Claude transcript (or the tail of one) into usage records.
/// Repeats of the same billed call inside `text` are dropped; the caller owns
/// dedupe across files.
pub fn parse_claude_transcript(text: &str, ctx: &TranscriptContext) -> Vec<UsageRecord> {
    let path_session = session_id_from_path(ctx);
    let mut seen: HashSet<String> = HashSet::new();
    let mut records = Vec::new();

    for line in text.lines() {
        if !line_may_carry_usage(line) {
            continue;
        }
        let Ok(Value::Object(row)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = record_from_row(&row, path_session.as_deref()) else {
            continue;
        };
        if let Some(key) = record.dedupe_key.as_ref() {
            if !seen.insert(key.clone()) {
                continue;
            }
        }
        records.push(record);
    }

    records
}

fn record_from_row(row: &Map<String, Value>, path_session: Option<&str>) -> Option<UsageRecord> {
    if string_value(row.get("type")) != Some("assistant") {
        return None;
    }
    let message = object_value(row.get("message"))?;
    let usage = object_value(message.get("usage"))?;
    let model_id = string_value(message.get("model"))?;
    if model_id == SYNTHETIC_MODEL {
        return None;
    }
    let tokens = tokens_from_usage(usage);
    if tokens.is_empty() {
        return None;
    }
    let at_ms = rfc3339_to_ms(string_value(row.get("timestamp")))?;
    let session_id = path_session
        .or_else(|| string_value(row.get("sessionId")))?
        .to_string();

    Some(UsageRecord {
        provider: ProviderId::Claude,
        model_id: model_id.to_string(),
        session_id,
        at_ms,
        tokens,
        // Claude's transcript never carries a dollar figure.
        reported_cost_usd: None,
        dedupe_key: dedupe_key(
            string_value(message.get("id")),
            string_value(row.get("requestId")),
        ),
        project_path: string_value(row.get("cwd")).map(str::to_string),
    })
}

fn tokens_from_usage(usage: &Map<String, Value>) -> UsageRecordTokens {
    let creation_total = number_value(usage.get("cache_creation_input_tokens")) as i64;
    // `cache_creation` splits the write between the 1 h and 5 m TTLs, which
    // bill at different rates. It only decides the split, never the size:
    // nine lines in 155k on this machine carry a split under a zero total —
    // aborted turns whose every other counter is zero as well — and counting
    // those would bill a write the transcript says never happened. Older
    // transcripts have no split object at all; everything Claude wrote before
    // the 1 h TTL existed was a 5 m write.
    let split = object_value(usage.get("cache_creation")).map(|split| {
        (
            number_value(split.get("ephemeral_1h_input_tokens")) as i64,
            number_value(split.get("ephemeral_5m_input_tokens")) as i64,
        )
    });
    let (write_1h, write_5m) = match split {
        Some((hour, five)) if hour + five == creation_total => (hour, five),
        _ => (0, creation_total),
    };

    UsageRecordTokens {
        // Claude's `input_tokens` already excludes cache reads and writes.
        input_uncached: number_value(usage.get("input_tokens")) as i64,
        cache_read: number_value(usage.get("cache_read_input_tokens")) as i64,
        cache_write_5m: write_5m,
        cache_write_1h: write_1h,
        output: number_value(usage.get("output_tokens")) as i64,
        reasoning: object_value(usage.get("output_tokens_details"))
            .map(|details| number_value(details.get("thinking_tokens")) as i64)
            .unwrap_or(0),
    }
}

/// One key per billed call. Both halves are present on every line current
/// Claude writes; a transcript old enough to be missing one still dedupes on
/// the other, and a line missing both is counted as seen.
fn dedupe_key(message_id: Option<&str>, request_id: Option<&str>) -> Option<String> {
    match (message_id, request_id) {
        (Some(message), Some(request)) => Some(format!("claude:{message}:{request}")),
        (Some(message), None) => Some(format!("claude:{message}")),
        (None, Some(request)) => Some(format!("claude:{request}")),
        (None, None) => None,
    }
}

/// The session a transcript file belongs to. A subagent transcript lives at
/// `<sessionId>/subagents/<childId>.jsonl` and its lines carry the child's own
/// `sessionId`, so the file's own path is what attributes its tokens to the
/// session the user actually ran.
fn session_id_from_path(ctx: &TranscriptContext) -> Option<String> {
    if let Some(hint) = ctx.session_id_hint {
        return Some(hint.to_string());
    }
    let path = ctx.source_path;
    let parent = path.parent();
    if parent.and_then(|dir| dir.file_name()) == Some(std::ffi::OsStr::new("subagents")) {
        return parent
            .and_then(|dir| dir.parent())
            .and_then(|dir| dir.file_name())
            .and_then(|name| name.to_str())
            .map(str::to_string);
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::providers::pricing::price_record;

    fn context(path: &Path) -> TranscriptContext<'_> {
        TranscriptContext {
            source_path: path,
            session_id_hint: None,
        }
    }

    #[test]
    fn counts_one_message_once_across_its_content_blocks() {
        let text = include_str!("../../tests/fixtures/usage/claude-three-blocks.jsonl");
        let path = Path::new("/p/0c272e51-552a-44c4-87de-1deed759c117.jsonl");
        let records = parse_claude_transcript(text, &context(path));

        assert_eq!(records.len(), 2, "three blocks of one message plus one more");
        assert_eq!(
            records[0].dedupe_key.as_deref(),
            Some("claude:msg_011CefzhyXmXNGx7TWbgxn2Z:req_011Cefzhxk996H3QS1yEdWjq")
        );
        assert_eq!(records[0].tokens.output, 214);
        assert_eq!(records[0].tokens.reasoning, 52);
        assert_eq!(records[0].tokens.cache_read, 83_284);
        assert_eq!(records[0].tokens.cache_write_1h, 4_298);
        assert_eq!(records[0].session_id, "0c272e51-552a-44c4-87de-1deed759c117");
        assert_eq!(
            records[0].project_path.as_deref(),
            Some("/Users/adamthuvesen/dev/menti/argmax")
        );
        assert_eq!(records[1].tokens.output, 196);
    }

    #[test]
    fn one_hour_cache_writes_bill_at_twice_the_input_rate() {
        let text = include_str!("../../tests/fixtures/usage/claude-cache-1h.jsonl");
        let path = Path::new("/p/6f0b8c30-3f6e-4d2a-9a7c-6b2e8a1c4d55.jsonl");
        let records = parse_claude_transcript(text, &context(path));

        assert_eq!(records.len(), 1);
        let record = &records[0];
        assert_eq!(record.model_id, "claude-fable-5-1");
        assert_eq!(record.tokens.cache_write_1h, 46_720);
        assert_eq!(record.tokens.cache_write_5m, 0);

        // claude-fable-5-1: input 10.0/M, cache_read 0.25/M, cache_write (5 m)
        // 12.5/M, output 50.0/M. A 1 h write bills at 2x input, so 20.0/M.
        let cost = price_record(&record.tokens, &record.model_id).expect("priced");
        let expected = (2.0 * 10.0 + 32_916.0 * 0.25 + 46_720.0 * 20.0 + 497.0 * 50.0) / 1e6;
        assert!(
            (cost - expected).abs() < 1e-9,
            "cost {cost} expected {expected}"
        );

        // The same write on the 5 m TTL costs 12.5/M instead, which is the
        // whole reason the two are carried apart.
        let five_minute = UsageRecordTokens {
            cache_write_5m: record.tokens.cache_write_1h,
            cache_write_1h: 0,
            ..record.tokens
        };
        let cheaper = price_record(&five_minute, &record.model_id).expect("priced");
        assert!(
            (cost - cheaper - 46_720.0 * (20.0 - 12.5) / 1e6).abs() < 1e-9,
            "1 h premium wrong: {cost} vs {cheaper}"
        );
    }

    #[test]
    fn subagent_transcript_is_attributed_to_the_parent_session() {
        let text = include_str!("../../tests/fixtures/usage/claude-subagent.jsonl");
        let path = Path::new(
            "/p/818d4b32-5f7d-4e68-af8e-c6871600c1a3/subagents/9c1f2a44-77b0-4a1e-8f1d-2b3c4d5e6f70.jsonl",
        );
        let records = parse_claude_transcript(text, &context(path));

        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].session_id,
            "818d4b32-5f7d-4e68-af8e-c6871600c1a3",
            "the child's own sessionId must not win over the parent directory"
        );
    }

    #[test]
    fn skips_synthetic_and_all_zero_usage_lines() {
        let text = include_str!("../../tests/fixtures/usage/claude-skipped.jsonl");
        let path = Path::new("/p/1f8916d9-20a7-4226-85b6-94e0cc7f7c0b.jsonl");
        let records = parse_claude_transcript(text, &context(path));

        assert_eq!(records.len(), 1, "only the real call survives");
        assert_eq!(records[0].model_id, "claude-opus-5");
        assert_eq!(records[0].tokens.output, 1465);
        assert_eq!(
            records[0].session_id, "1f8916d9-20a7-4226-85b6-94e0cc7f7c0b",
            "the file's own name names the session, not the line"
        );
    }

    #[test]
    fn session_id_hint_wins_over_the_path() {
        let text = include_str!("../../tests/fixtures/usage/claude-subagent.jsonl");
        let path = Path::new("/p/818d4b32-5f7d-4e68-af8e-c6871600c1a3/subagents/child.jsonl");
        let records = parse_claude_transcript(
            text,
            &TranscriptContext {
                source_path: path,
                session_id_hint: Some("hinted-session"),
            },
        );
        assert_eq!(records[0].session_id, "hinted-session");
    }

    #[test]
    fn malformed_lines_are_skipped_without_panicking() {
        let path = Path::new("/p/abc.jsonl");
        let text = "{\"type\":\"assistant\",\"message\":{\"usage\":\n\nnot json at all\n{\"type\":\"assistant\",\"message\":{\"usage\":{}}}\n";
        assert!(parse_claude_transcript(text, &context(path)).is_empty());
    }
}
