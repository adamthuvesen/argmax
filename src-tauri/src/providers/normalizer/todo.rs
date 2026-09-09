//! One canonical todo list out of five provider dialects.
//!
//! Every provider Argmax drives can publish a plan, and each publishes it
//! differently: Codex sends a whole snapshot, OpenCode sends a whole snapshot
//! with no ids, Grok and Cursor send either a snapshot or a status-only delta,
//! and Claude sends one task per call with the id buried in a result string.
//! This module reduces all of that to `todo.updated`, so the renderer folds a
//! single shape and never learns which CLI produced it.
//!
//! Two rules the emitters must hold, both load-bearing:
//!
//! 1. **No list in the payload means no event.** Cursor's ACP `updateTodos`
//!    arrives as `args: {"_toolName":"updateTodos"}` with the list stripped
//!    out; emitting an empty snapshot for it would wipe a list the user is
//!    reading. Returning `None` leaves the last good list standing.
//! 2. **Status arrives resolved.** The fold is provider-blind, so
//!    `TODO_STATUS_IN_PROGRESS`, `in_progress` and Codex's `completed: false`
//!    all become the same canonical word here rather than in the renderer.
//!
//! The list of tool names below is the *only* place a todo tool is recognised.
//! The renderer hides and buckets these rows by the `surface` stamp this module
//! writes, not by name, because the names move: Claude renamed `TodoWrite` to
//! `TaskCreate`/`TaskUpdate`, and Cursor's name depends on the model behind ACP
//! — `composer-2.5` alone emitted `updateTodos`, `todo_write` and `todowrite`
//! across two days.

use serde_json::{json, Map, Value};

use super::{array_value, object_value, string_value, timeline_event, ProviderOutputEvent};
use crate::persistence::events::PersistTimelineEventInput;

/// The payload key every todo-carrying tool row is stamped with, and the value
/// the renderer hides and buckets on.
pub const TODO_SURFACE: &str = "todo";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoStatus {
    Pending,
    /// The one item the agent says it is working on right now.
    Active,
    Done,
    Cancelled,
    /// Claude's `deleted`: the item leaves the list rather than being struck
    /// through.
    Removed,
}

impl TodoStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
            Self::Removed => "removed",
        }
    }

    /// Every spelling seen in the wild. Cursor sends the protobuf enum name,
    /// everyone else sends the bare word.
    fn parse(raw: &str) -> Option<Self> {
        let lower = raw.to_ascii_lowercase();
        let bare = lower.strip_prefix("todo_status_").unwrap_or(&lower);
        match bare {
            "pending" | "not_started" | "todo" | "queued" => Some(Self::Pending),
            // `inprogress` is the app-server's `inProgress`, lowercased above.
            "in_progress" | "inprogress" | "active" | "running" => Some(Self::Active),
            "completed" | "complete" | "done" => Some(Self::Done),
            "cancelled" | "canceled" | "skipped" | "deferred" => Some(Self::Cancelled),
            "deleted" | "removed" => Some(Self::Removed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    /// Absent for OpenCode, which numbers nothing; the fold falls back to
    /// position for those.
    pub id: Option<String>,
    /// Absent on a status-only delta. 33 of Grok's 69 local calls are exactly
    /// this: an id and a status against a list sent earlier.
    pub text: Option<String>,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TodoMode {
    /// The whole list, replacing whatever came before.
    Snapshot,
    /// Only what changed, patched onto what the fold already holds.
    Merge,
}

impl TodoMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Snapshot => "snapshot",
            Self::Merge => "merge",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoUpdate {
    pub mode: TodoMode,
    pub items: Vec<TodoItem>,
}

/// Tool names that carry a todo list. Kept in one place so the `surface` stamp
/// and the parser can never disagree about what counts.
const TODO_TOOL_NAMES: &[&str] = &[
    // Claude, since 2.1.x. `TodoWrite` is gone and no local session has one.
    "taskcreate",
    "taskupdate",
    // Grok, OpenCode, and two of Cursor's four spellings.
    "todo_write",
    "todowrite",
    // Cursor's ACP names. `updatetodos` carries nothing but is listed so its
    // row is still hidden rather than rendered as an unlabelled tool call.
    "updatetodostoolcall",
    "updatetodos",
];

pub fn is_todo_tool(tool_name: &str) -> bool {
    let normalized: String = tool_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_ascii_lowercase();
    TODO_TOOL_NAMES.contains(&normalized.as_str())
}

/// Mark a tool row as belonging to the todo surface. The renderer reads this
/// instead of matching names, so a provider renaming its tool costs one line
/// here rather than a stale card plus an unlabelled row plus a wrong edit count.
pub fn stamp_todo_surface(payload: &mut Map<String, Value>) {
    payload.insert(
        "surface".to_string(),
        Value::String(TODO_SURFACE.to_string()),
    );
}

pub fn todo_event(
    event: &ProviderOutputEvent,
    update: &TodoUpdate,
    tool_use_id: Option<&str>,
) -> PersistTimelineEventInput {
    let items: Vec<Value> = update
        .items
        .iter()
        .map(|item| {
            json!({
                "id": item.id,
                "text": item.text,
                "status": item.status.as_str(),
            })
        })
        .collect();
    timeline_event(
        event,
        "todo.updated",
        "todo",
        json!({
            "mode": update.mode.as_str(),
            "items": items,
            "toolUseId": tool_use_id,
        }),
    )
}

/// The `{todos: [...]}` dialect: Grok, OpenCode, and Cursor's `todo_write` /
/// `todowrite` / `updateTodosToolCall`. Read by shape rather than by name,
/// because the name is the part that moves.
pub fn todos_array_update(input: &Map<String, Value>) -> Option<TodoUpdate> {
    let raw_items = array_value(input.get("todos"))?;
    if raw_items.is_empty() {
        return None;
    }
    let mut items = Vec::with_capacity(raw_items.len());
    for raw in raw_items {
        let entry = object_value(Some(raw))?;
        let status = string_value(entry.get("status"))
            .and_then(TodoStatus::parse)
            .unwrap_or(TodoStatus::Pending);
        items.push(TodoItem {
            id: string_value(entry.get("id")).map(str::to_string),
            text: string_value(entry.get("content"))
                .or_else(|| string_value(entry.get("text")))
                .or_else(|| string_value(entry.get("title")))
                .map(str::to_string),
            status,
        });
    }
    // Grok and Cursor flag a partial write; OpenCode always sends the lot.
    let merging = input.get("merge").and_then(Value::as_bool).unwrap_or(false);
    Some(TodoUpdate {
        mode: if merging {
            TodoMode::Merge
        } else {
            TodoMode::Snapshot
        },
        items,
    })
}

/// Codex's plan, in either of the two shapes it comes in.
///
/// The app-server — which is how Argmax launches Codex — sends
/// `turn/plan/updated` with `{plan: [{step, status}]}` and a real
/// `inProgress`. `codex exec --json` sends a `todo_list` item flattened to
/// `{items: [{text, completed}]}`, with the in-progress state thrown away.
pub fn codex_todo_update(item: &Map<String, Value>) -> Option<TodoUpdate> {
    if let Some(plan) = array_value(item.get("plan")) {
        return codex_plan_update(plan);
    }
    codex_exec_todo_update(item)
}

/// The app-server shape, which names the running step itself.
fn codex_plan_update(plan: &[Value]) -> Option<TodoUpdate> {
    if plan.is_empty() {
        return None;
    }
    let mut items = Vec::with_capacity(plan.len());
    for raw in plan {
        let entry = object_value(Some(raw))?;
        items.push(TodoItem {
            id: None,
            text: string_value(entry.get("step")).map(str::to_string),
            status: string_value(entry.get("status"))
                .and_then(TodoStatus::parse)
                .unwrap_or(TodoStatus::Pending),
        });
    }
    Some(TodoUpdate {
        mode: TodoMode::Snapshot,
        items,
    })
}

/// The exec shape, which does not.
///
/// Codex is told to keep exactly one item in progress and never to jump an item
/// from pending to completed, so the first unfinished item is the one being
/// worked on. That is a promise made by Codex's prompt, not enforced by its
/// protocol: if the model completes out of order the mark lands on the wrong
/// row, which is a cosmetic miss on a row that is genuinely pending.
fn codex_exec_todo_update(item: &Map<String, Value>) -> Option<TodoUpdate> {
    let raw_items = array_value(item.get("items"))?;
    if raw_items.is_empty() {
        return None;
    }
    let mut items = Vec::with_capacity(raw_items.len());
    let mut active_taken = false;
    for raw in raw_items {
        let entry = object_value(Some(raw))?;
        let text = string_value(entry.get("text")).map(str::to_string);
        let completed = entry
            .get("completed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = if completed {
            TodoStatus::Done
        } else if active_taken {
            TodoStatus::Pending
        } else {
            active_taken = true;
            TodoStatus::Active
        };
        items.push(TodoItem {
            id: None,
            text,
            status,
        });
    }
    Some(TodoUpdate {
        mode: TodoMode::Snapshot,
        items,
    })
}

/// Grok's ACP transport does not publish a plan the way its CLI does. Instead
/// of a `todo_write` call with a `todos` array, the list comes back inside a
/// tool *result* whose content is a JSON string:
///
/// ```json
/// {"TodosUpdated":{"state":{"todos":{"1":{"content":"…","status":"pending"}}}}}
/// ```
///
/// `todos` is a map keyed by id, not an array, so the order has to be recovered
/// from the keys — numerically where they are numbers, which they are, or the
/// tenth step would sort between the first and the second.
pub fn grok_todos_updated_result(result: &str) -> Option<TodoUpdate> {
    if !result.contains("TodosUpdated") {
        return None;
    }
    let parsed: Value = serde_json::from_str(result).ok()?;
    let todos = parsed.pointer("/TodosUpdated/state/todos")?.as_object()?;
    if todos.is_empty() {
        return None;
    }
    let mut keyed: Vec<(&String, &Value)> = todos.iter().collect();
    keyed.sort_by_key(|(key, _)| {
        (
            key.parse::<u64>().unwrap_or(u64::MAX),
            key.parse::<u64>().is_err(),
        )
    });
    let mut items = Vec::with_capacity(keyed.len());
    for (id, raw) in keyed {
        let entry = object_value(Some(raw))?;
        items.push(TodoItem {
            id: Some(id.clone()),
            text: string_value(entry.get("content")).map(str::to_string),
            status: string_value(entry.get("status"))
                .and_then(TodoStatus::parse)
                .unwrap_or(TodoStatus::Pending),
        });
    }
    Some(TodoUpdate {
        mode: TodoMode::Snapshot,
        items,
    })
}

/// `TaskUpdate` args: `{taskId, status}`, where status is one of
/// pending / in_progress / completed / deleted.
pub fn claude_task_update(input: &Map<String, Value>) -> Option<TodoUpdate> {
    let task_id = string_value(input.get("taskId"))?;
    let status = string_value(input.get("status")).and_then(TodoStatus::parse)?;
    Some(TodoUpdate {
        mode: TodoMode::Merge,
        items: vec![TodoItem {
            id: Some(task_id.to_string()),
            text: None,
            status,
        }],
    })
}

/// `TaskCreate` hands back the id only inside its result prose:
/// `Task #5 created successfully: Wire up the projection`.
///
/// This is the one place the surface depends on an undocumented string. A miss
/// is deliberately loud rather than silent: the caller keeps the item, keyed by
/// the tool-use id instead of the task id, so the card still shows the task and
/// the following `TaskUpdate` arrives as an id-only row the fold cannot match.
/// A stale row in the transcript within one turn beats a card that quietly
/// stops updating for two months.
pub fn parse_task_create_result(result: &str) -> Option<(String, String)> {
    let rest = result.split("Task #").nth(1)?;
    let (id, tail) = rest.split_once(" created successfully")?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let subject = tail.trim_start_matches(':').trim();
    Some((id.to_string(), subject.to_string()))
}

/// A task Claude has just created is pending until a `TaskUpdate` says
/// otherwise.
pub fn claude_task_create(id: &str, subject: &str) -> TodoUpdate {
    TodoUpdate {
        mode: TodoMode::Merge,
        items: vec![TodoItem {
            id: Some(id.to_string()),
            text: (!subject.is_empty()).then(|| subject.to_string()),
            status: TodoStatus::Pending,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().expect("object fixture").clone()
    }

    // Captured from a real OpenCode `todowrite` call: a whole list, no ids.
    #[test]
    fn opencode_snapshot_has_no_ids_and_one_active_row() {
        let input = object(json!({
            "todos": [
                {"content": "Reproduce the stale flag", "priority": "high", "status": "completed"},
                {"content": "Implement the exemption", "priority": "high", "status": "in_progress"},
                {"content": "Run the suite", "priority": "medium", "status": "pending"}
            ]
        }));
        let update = todos_array_update(&input).expect("todos array");
        assert_eq!(update.mode, TodoMode::Snapshot);
        assert_eq!(update.items.len(), 3);
        assert!(update.items.iter().all(|item| item.id.is_none()));
        assert_eq!(update.items[1].status, TodoStatus::Active);
        assert_eq!(
            update.items[0].text.as_deref(),
            Some("Reproduce the stale flag")
        );
    }

    // Captured from a real Grok `todo_write`: status-only, against ids sent
    // in an earlier snapshot.
    #[test]
    fn grok_merge_delta_carries_ids_without_text() {
        let input = object(json!({
            "merge": true,
            "todos": [{"id": "2", "status": "completed"}, {"id": "3", "status": "completed"}]
        }));
        let update = todos_array_update(&input).expect("todos array");
        assert_eq!(update.mode, TodoMode::Merge);
        assert_eq!(update.items.len(), 2);
        assert_eq!(update.items[0].id.as_deref(), Some("2"));
        assert!(update.items[0].text.is_none());
        assert_eq!(update.items[0].status, TodoStatus::Done);
    }

    // Captured from a real Cursor `updateTodosToolCall`: protobuf enum names,
    // and text present even on a merge.
    #[test]
    fn cursor_protobuf_status_names_resolve() {
        let input = object(json!({
            "merge": true,
            "todos": [
                {"content": "Verify the gate", "id": "5-verify", "status": "TODO_STATUS_COMPLETED"},
                {"content": "Summarize", "id": "6-summary", "status": "TODO_STATUS_IN_PROGRESS"}
            ]
        }));
        let update = todos_array_update(&input).expect("todos array");
        assert_eq!(update.items[0].status, TodoStatus::Done);
        assert_eq!(update.items[1].status, TodoStatus::Active);
        assert_eq!(update.items[1].text.as_deref(), Some("Summarize"));
    }

    // Cursor's ACP path strips the list. Emitting an empty snapshot here would
    // erase a list the user is reading, so there must be no update at all.
    #[test]
    fn cursor_stripped_acp_args_produce_no_update() {
        let input = object(json!({"_toolName": "updateTodos"}));
        assert!(todos_array_update(&input).is_none());
    }

    #[test]
    fn empty_todos_array_produces_no_update() {
        let input = object(json!({"todos": []}));
        assert!(todos_array_update(&input).is_none());
    }

    // Captured from a live `codex exec --json -c tools.update_plan.enabled=true`
    // run on codex-cli 0.153.4.
    #[test]
    fn codex_snapshot_derives_active_from_first_incomplete() {
        let item = object(json!({
            "id": "item_1",
            "type": "todo_list",
            "items": [
                {"text": "Create step1.txt", "completed": true},
                {"text": "Create step2.txt", "completed": false},
                {"text": "Create step3.txt", "completed": false}
            ]
        }));
        let update = codex_todo_update(&item).expect("codex items");
        assert_eq!(update.mode, TodoMode::Snapshot);
        let statuses: Vec<_> = update.items.iter().map(|i| i.status).collect();
        assert_eq!(
            statuses,
            vec![TodoStatus::Done, TodoStatus::Active, TodoStatus::Pending]
        );
    }

    // Captured from the app-server schema shipped by codex-cli 0.153.4:
    // TurnPlanUpdatedNotification carries a real in-progress status, so nothing
    // has to be derived on the path Argmax actually launches.
    #[test]
    fn codex_app_server_plan_uses_the_status_it_is_given() {
        let item = object(json!({
            "id": "turn_1",
            "type": "todo_list",
            "plan": [
                { "step": "Read the normalizers", "status": "completed" },
                { "step": "Write the projection", "status": "inProgress" },
                { "step": "Verify with checks", "status": "pending" }
            ]
        }));
        let update = codex_todo_update(&item).expect("codex plan");
        let statuses: Vec<_> = update.items.iter().map(|i| i.status).collect();
        assert_eq!(
            statuses,
            vec![TodoStatus::Done, TodoStatus::Active, TodoStatus::Pending]
        );
        assert_eq!(
            update.items[1].text.as_deref(),
            Some("Write the projection")
        );
    }

    #[test]
    fn codex_all_complete_has_no_active_row() {
        let item = object(json!({
            "items": [{"text": "one", "completed": true}, {"text": "two", "completed": true}]
        }));
        let update = codex_todo_update(&item).expect("codex items");
        assert!(update
            .items
            .iter()
            .all(|item| item.status == TodoStatus::Done));
    }

    // The literal template read out of the Claude CLI binary, version 2.1.263:
    // `Task #${r.id} created successfully: ${r.subject}`.
    #[test]
    fn claude_task_create_result_yields_id_and_subject() {
        let (id, subject) = parse_task_create_result(
            "Task #5 created successfully: Finalize index/log/sources.jsonl",
        )
        .expect("parsed");
        assert_eq!(id, "5");
        assert_eq!(subject, "Finalize index/log/sources.jsonl");
    }

    #[test]
    fn claude_task_create_result_rejects_a_changed_format() {
        assert!(parse_task_create_result("Created task 5: something").is_none());
        assert!(parse_task_create_result("Task #abc created successfully: x").is_none());
    }

    // Captured from a live Grok ACP session through the scratch app: the list
    // rides inside a tool result as a JSON string, keyed by id.
    #[test]
    fn grok_acp_todos_updated_result_is_a_snapshot_in_key_order() {
        let raw = r#"{"TodosUpdated":{"state":{"todos":{
            "10":{"content":"Tenth","priority":"medium","status":"pending"},
            "2":{"content":"Second","priority":"medium","status":"in_progress"},
            "1":{"content":"First","priority":"medium","status":"completed"}
        }},"summary_for_prompt":"…"}}"#;
        let update = grok_todos_updated_result(raw).expect("todos updated");
        assert_eq!(update.mode, TodoMode::Snapshot);
        assert_eq!(
            update
                .items
                .iter()
                .map(|i| i.id.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("1"), Some("2"), Some("10")],
            "numeric ids sort numerically, so step 10 comes last"
        );
        assert_eq!(update.items[0].status, TodoStatus::Done);
        assert_eq!(update.items[1].status, TodoStatus::Active);
        assert_eq!(update.items[2].text.as_deref(), Some("Tenth"));
    }

    #[test]
    fn a_tool_result_without_todos_is_not_a_plan() {
        assert!(grok_todos_updated_result("file written").is_none());
        assert!(grok_todos_updated_result(r#"{"TodosUpdated":{"state":{"todos":{}}}}"#).is_none());
    }

    #[test]
    fn claude_task_update_maps_deleted_to_removed() {
        let input = object(json!({"taskId": "5", "status": "deleted"}));
        let update = claude_task_update(&input).expect("task update");
        assert_eq!(update.mode, TodoMode::Merge);
        assert_eq!(update.items[0].status, TodoStatus::Removed);
        assert!(update.items[0].text.is_none());
    }

    #[test]
    fn todo_tool_names_match_every_provider_spelling() {
        for name in [
            "TaskCreate",
            "TaskUpdate",
            "todo_write",
            "todowrite",
            "updateTodosToolCall",
            "updateTodos",
        ] {
            assert!(is_todo_tool(name), "{name} should be a todo tool");
        }
        for name in ["TaskOutput", "TaskStop", "Bash", "read_file", "Task"] {
            assert!(!is_todo_tool(name), "{name} should not be a todo tool");
        }
    }
}
