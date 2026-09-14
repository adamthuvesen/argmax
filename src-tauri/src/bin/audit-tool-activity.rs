//! Read-only coverage report over a bounded sample of recorded tool starts.
use std::{collections::BTreeMap, env, path::PathBuf, process};

use argmax_lib::providers::tool_activity::enrich_tool_activity;
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Coverage {
    sampled_starts: usize,
    kinds: BTreeMap<String, usize>,
    evidence: BTreeMap<String, usize>,
    generic_tool_names: BTreeMap<String, usize>,
}

fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let path = args
        .next()
        .map(PathBuf::from)
        .ok_or("usage: audit-tool-activity <argmax.sqlite> [sample-per-provider, 1..100000]")?;
    let sample = args
        .next()
        .map(|arg| arg.to_string_lossy().parse::<u32>())
        .transpose()
        .map_err(|_| "sample must be an integer between 1 and 100000")?
        .unwrap_or(1000);
    if args.next().is_some() || !(1..=100_000).contains(&sample) {
        return Err(
            "usage: audit-tool-activity <argmax.sqlite> [sample-per-provider, 1..100000]".into(),
        );
    }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("could not open database read-only: {error}"))?;
    connection
        .execute_batch("PRAGMA query_only = ON; BEGIN")
        .map_err(|error| format!("could not start read snapshot: {error}"))?;
    let mut query = connection
        .prepare(
            "SELECT e.payload_json FROM sessions s JOIN events e ON e.session_id = s.id \
         WHERE s.provider = ?1 AND e.type = ?2 ORDER BY e.rowid DESC LIMIT ?3",
        )
        .map_err(|error| format!("could not prepare activity sample: {error}"))?;
    let mut report = BTreeMap::new();
    for provider in ["claude", "codex", "cursor", "grok", "opencode"] {
        let mut coverage = Coverage::default();
        let rows = query
            .query_map(params![provider, "command.started", sample], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| format!("could not sample {provider}: {error}"))?;
        for row in rows {
            let raw = row.map_err(|error| format!("could not read {provider} sample: {error}"))?;
            let mut payload: Value = serde_json::from_str(&raw)
                .map_err(|_| format!("invalid JSON in {provider} tool-start sample"))?;
            enrich_tool_activity("command.started", &mut payload);
            let kind = payload
                .pointer("/activity/kind")
                .and_then(Value::as_str)
                .unwrap_or("unclassified");
            let evidence = payload
                .pointer("/activity/evidence")
                .and_then(Value::as_str)
                .unwrap_or("unclassified");
            coverage.sampled_starts += 1;
            *coverage.kinds.entry(kind.to_string()).or_default() += 1;
            *coverage.evidence.entry(evidence.to_string()).or_default() += 1;
            if matches!(kind, "tool" | "unclassified") {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unnamed");
                *coverage
                    .generic_tool_names
                    .entry(name.to_string())
                    .or_default() += 1;
            }
        }
        report.insert(provider, coverage);
    }
    let output = serde_json::to_string_pretty(&report)
        .map_err(|error| format!("could not encode report: {error}"))?;
    println!("{output}");
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("argmax activity audit: {error}");
        process::exit(1);
    }
}
