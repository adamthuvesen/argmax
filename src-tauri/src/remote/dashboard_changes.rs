// `dashboard:changes`: the dashboard as a diff against a snapshot the client
// already holds.
//
// A phone re-reads the dashboard on every `dashboardChanged` hint, and the
// hint names nothing, so each one cost the whole `dashboard:list` — ~700 KB
// for a two-hundred-chat Mac, over cellular — to learn that one row moved.
// This channel reads the same snapshot, remembers the last few by digest, and
// answers a client that names one of them with only what differs from it.
// Anything else — a first read, a Mac restarted since, a base that has aged
// out — gets the full snapshot, so a client can never be left holding rows
// this read did not confirm.
//
// Remote-only, and advertised at authentication (`dashboardChanges: true`)
// so a phone falls back to `dashboard:list` against an older Mac.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// Snapshots kept to diff against. A phone's base is the last answer it
/// merged, so one is enough per client; a few cover a phone and a browser
/// reading between each other's hints.
const BASELINE_CAPACITY: usize = 4;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardChangesInput {
    /// The `digest` of the last answer the client merged.
    #[serde(default)]
    pub base_digest: Option<String>,
}

#[derive(Default)]
pub struct DashboardBaselines {
    recent: Mutex<VecDeque<(String, Map<String, Value>)>>,
}

impl DashboardBaselines {
    /// Answer with `snapshot` as a diff against `base_digest` when that
    /// snapshot is still held, or in full when it is not.
    ///
    /// Full: `{ digest, snapshot }`. Diff: `{ digest, base, collections,
    /// replace, remove }`, where `collections` holds, per array of
    /// id-keyed rows, the rows that are new or changed (`upsert`), the ids
    /// that are gone (`remove`), and the full id order when it changed
    /// (`order`); `replace` holds every other top-level value that changed
    /// and `remove` the top-level keys that are gone.
    pub fn changes(&self, snapshot: Value, base_digest: Option<&str>) -> Value {
        let Value::Object(snapshot) = snapshot else {
            return json!({ "digest": Value::Null, "snapshot": snapshot });
        };
        let digest = digest(&snapshot);
        let mut recent = self
            .recent
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let answer = match base_digest.and_then(|base| recent.iter().find(|(held, _)| held == base))
        {
            Some((base, previous)) => diff(base, previous, &digest, &snapshot),
            None => json!({ "digest": digest, "snapshot": Value::Object(snapshot.clone()) }),
        };
        recent.retain(|(held, _)| held != &digest);
        recent.push_back((digest, snapshot));
        while recent.len() > BASELINE_CAPACITY {
            recent.pop_front();
        }
        answer
    }
}

/// `serde_json`'s map is ordered by key, so equal snapshots serialize, and
/// digest, identically.
fn digest(snapshot: &Map<String, Value>) -> String {
    let bytes = serde_json::to_vec(snapshot).unwrap_or_default();
    Sha256::digest(&bytes)
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn diff(
    base_digest: &str,
    previous: &Map<String, Value>,
    digest: &str,
    snapshot: &Map<String, Value>,
) -> Value {
    let mut collections = Map::new();
    let mut replace = Map::new();
    for (key, value) in snapshot {
        let before = previous.get(key);
        if before == Some(value) {
            continue;
        }
        match (keyed_rows(value), before.and_then(keyed_rows)) {
            (Some(rows), Some(before_rows)) => {
                collections.insert(key.clone(), diff_rows(&rows, &before_rows));
            }
            _ => {
                replace.insert(key.clone(), value.clone());
            }
        }
    }
    let removed: Vec<&String> = previous
        .keys()
        .filter(|key| !snapshot.contains_key(*key))
        .collect();
    json!({
        "digest": digest,
        "base": base_digest,
        "collections": collections,
        "replace": replace,
        "remove": removed,
    })
}

/// An array whose every element is an object with a unique string `id`.
fn keyed_rows(value: &Value) -> Option<Vec<(&str, &Value)>> {
    let rows = value.as_array()?;
    let mut seen = HashSet::with_capacity(rows.len());
    rows.iter()
        .map(|row| {
            let id = row.get("id")?.as_str()?;
            seen.insert(id).then_some((id, row))
        })
        .collect()
}

fn diff_rows(rows: &[(&str, &Value)], before: &[(&str, &Value)]) -> Value {
    let previous: HashMap<&str, &Value> = before.iter().copied().collect();
    let current: HashSet<&str> = rows.iter().map(|(id, _)| *id).collect();
    let upsert: Vec<&Value> = rows
        .iter()
        .filter(|(id, row)| previous.get(id) != Some(row))
        .map(|(_, row)| *row)
        .collect();
    let remove: Vec<&str> = before
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| !current.contains(id))
        .collect();
    let mut changes = json!({ "upsert": upsert, "remove": remove });
    // Surviving rows keep their places and new ones would have none, so the
    // order goes along whenever it is anything other than the old one.
    let kept: Vec<&str> = before
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| current.contains(id))
        .collect();
    let order: Vec<&str> = rows.iter().map(|(id, _)| *id).collect();
    if order != kept {
        changes["order"] = json!(order);
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The client's side of the contract, as the phone implements it.
    fn apply(base: &Map<String, Value>, answer: &Value) -> Map<String, Value> {
        if let Some(Value::Object(snapshot)) = answer.get("snapshot") {
            return snapshot.clone();
        }
        let mut next = base.clone();
        for key in answer["remove"].as_array().unwrap() {
            next.remove(key.as_str().unwrap());
        }
        for (key, value) in answer["replace"].as_object().unwrap() {
            next.insert(key.clone(), value.clone());
        }
        for (key, changes) in answer["collections"].as_object().unwrap() {
            let rows = next[key].as_array().unwrap();
            let removed: HashSet<&str> = changes["remove"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect();
            let mut by_id: HashMap<String, Value> = rows
                .iter()
                .map(|row| (row["id"].as_str().unwrap().to_string(), row.clone()))
                .collect();
            let mut order: Vec<String> = rows
                .iter()
                .map(|row| row["id"].as_str().unwrap().to_string())
                .filter(|id| !removed.contains(id.as_str()))
                .collect();
            for row in changes["upsert"].as_array().unwrap() {
                by_id.insert(row["id"].as_str().unwrap().to_string(), row.clone());
            }
            if let Some(ids) = changes.get("order") {
                order = ids
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_string())
                    .collect();
            }
            next.insert(
                key.clone(),
                Value::Array(order.iter().map(|id| by_id[id].clone()).collect()),
            );
        }
        next
    }

    #[test]
    fn a_client_merging_each_answer_holds_exactly_the_latest_snapshot() {
        let baselines = DashboardBaselines::default();
        let states = [
            json!({
                "sessions": [{"id": "a", "state": "idle"}, {"id": "b", "state": "idle"}],
                "workspaces": [{"id": "w", "title": "one"}],
                "pendingMessages": {},
                "arcs": [],
            }),
            // One row changes.
            json!({
                "sessions": [{"id": "a", "state": "running"}, {"id": "b", "state": "idle"}],
                "workspaces": [{"id": "w", "title": "one"}],
                "pendingMessages": {},
                "arcs": [],
            }),
            // A row arrives at the front, one leaves, a map changes.
            json!({
                "sessions": [{"id": "c", "state": "idle"}, {"id": "a", "state": "running"}],
                "workspaces": [{"id": "w", "title": "one"}],
                "pendingMessages": {"a": [{"id": "m", "text": "next"}]},
                "arcs": [],
            }),
            // Reordered only; a key disappears; an unkeyed array changes.
            json!({
                "sessions": [{"id": "a", "state": "running"}, {"id": "c", "state": "idle"}],
                "workspaces": [{"id": "w", "title": "one"}],
                "arcs": [1, 2],
            }),
        ];
        let mut held = Map::new();
        let mut digest: Option<String> = None;
        for state in states {
            let answer = baselines.changes(state.clone(), digest.as_deref());
            held = apply(&held, &answer);
            assert_eq!(Value::Object(held.clone()), state);
            digest = answer["digest"].as_str().map(str::to_string);
        }
    }

    #[test]
    fn an_answer_carries_only_the_rows_that_changed() {
        let baselines = DashboardBaselines::default();
        let rows = |state: &str| {
            json!({ "sessions": (0..200).map(|index| json!({
                "id": format!("s{index}"),
                "state": if index == 7 { state } else { "idle" },
                "prompt": "x".repeat(1_000),
            })).collect::<Vec<_>>() })
        };
        let first = baselines.changes(rows("idle"), None);
        assert!(first.get("snapshot").is_some());
        let second = baselines.changes(rows("running"), first["digest"].as_str());
        let sessions = &second["collections"]["sessions"];
        assert_eq!(sessions["upsert"].as_array().unwrap().len(), 1);
        assert_eq!(sessions["upsert"][0]["id"], "s7");
        assert!(sessions.get("order").is_none());
        assert!(serde_json::to_vec(&second).unwrap().len() < 2_000);
    }

    #[test]
    fn a_base_the_host_no_longer_holds_gets_the_full_snapshot() {
        let baselines = DashboardBaselines::default();
        let unknown = baselines.changes(json!({"sessions": []}), Some("not-a-digest"));
        assert_eq!(unknown["snapshot"], json!({"sessions": []}));
        let first = baselines.changes(json!({"sessions": [{"id": "0"}]}), None);
        for index in 1..=BASELINE_CAPACITY {
            baselines.changes(json!({"sessions": [{"id": index.to_string()}]}), None);
        }
        let aged_out = baselines.changes(json!({"sessions": []}), first["digest"].as_str());
        assert!(aged_out.get("snapshot").is_some());
    }

    #[test]
    fn rows_without_unique_ids_are_replaced_whole() {
        let baselines = DashboardBaselines::default();
        let first = baselines.changes(json!({"checks": [{"id": "x"}, {"id": "x"}]}), None);
        let second = baselines.changes(
            json!({"checks": [{"id": "x", "n": 1}, {"id": "x"}]}),
            first["digest"].as_str(),
        );
        assert_eq!(
            second["replace"]["checks"],
            json!([{"id": "x", "n": 1}, {"id": "x"}])
        );
        assert_eq!(second["collections"], json!({}));
    }
}
