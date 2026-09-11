use std::collections::HashSet;

use serde_json::{json, Map, Value};

const PATH_KEYS: &[&str] = &[
    "path",
    "file_path",
    "filePath",
    "filename",
    "target",
    "target_file",
    "targetFile",
    "paths",
    "files",
    "locations",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivityKind {
    Read,
    Edit,
    Image,
    Search,
    List,
    WebSearch,
    WebFetch,
    Discovery,
    Command,
    Tool,
    Agent,
    Skill,
    ImageCapture,
    ImageGenerate,
    Computer,
}

impl ActivityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Edit => "edit",
            Self::Image => "image",
            Self::Search => "search",
            Self::List => "list",
            Self::WebSearch => "web-search",
            Self::WebFetch => "web-fetch",
            Self::Discovery => "discovery",
            Self::Command => "command",
            Self::Tool => "tool",
            Self::Agent => "agent",
            Self::Skill => "skill",
            Self::ImageCapture => "image-capture",
            Self::ImageGenerate => "image-generate",
            Self::Computer => "computer",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Evidence {
    Native,
    Tool,
    Command,
}

impl Evidence {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Tool => "tool",
            Self::Command => "command",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Activity {
    kind: ActivityKind,
    evidence: Evidence,
    targets: Vec<String>,
    operation: Option<&'static str>,
    tool_count: Option<usize>,
}

/// Adds the stable, provider-independent description consumed by transcript UIs.
///
/// This intentionally classifies only command lifecycle events. Exact native or
/// tool identity wins. Shell commands are interpreted only when their syntax is
/// simple enough to establish the operation without executing or evaluating it.
pub fn enrich_tool_activity(event_type: &str, payload: &mut Value) {
    if !event_type.starts_with("command.") {
        return;
    }
    let Some(fields) = payload.as_object_mut() else {
        return;
    };
    // Grok routes discovered integrations through use_tool. Keep the wrapper
    // for inspection while exposing the invoked tool to both clients.
    if let Some(name) = tool_name(fields).filter(|name| folded_leaf(name) == "usetool") {
        let input = tool_input(fields);
        let (resolved_name, resolved_input) = resolve_use_tool(name, input);
        if resolved_name != name {
            let resolved_name =
                if resolved_name.contains("__") && !resolved_name.starts_with("mcp__") {
                    format!("mcp__{resolved_name}")
                } else {
                    resolved_name.to_owned()
                };
            let resolved_input = resolved_input.cloned().unwrap_or_else(|| json!({}));
            let wrapper = json!({"name":name,"input":input});
            fields.insert("toolWrapper".to_owned(), wrapper);
            fields.insert("name".to_owned(), json!(resolved_name));
            fields.insert("input".to_owned(), resolved_input);
        }
    }
    // Refresh historical classifications whose recognition has improved:
    // metadata artwork is not a viewed image, and safe read sequences no
    // longer need the generic command fallback.
    let refresh_activity = fields.get("activity").is_some_and(|activity| {
        activity.get("version").and_then(Value::as_u64) == Some(1)
            && matches!(
                activity.get("kind").and_then(Value::as_str),
                Some("image" | "command")
            )
    });
    if !fields.contains_key("activity") || refresh_activity {
        if let Some(activity) = classify(fields) {
            let mut value = json!({
                "version": 1,
                "kind": activity.kind.as_str(),
                "evidence": activity.evidence.as_str(),
                "targets": activity.targets,
            });
            let activity_fields = value
                .as_object_mut()
                .expect("tool activity is constructed as an object");
            if let Some(operation) = activity.operation {
                activity_fields.insert(
                    "operation".to_string(),
                    Value::String(operation.to_string()),
                );
            }
            if let Some(tool_count) = activity.tool_count {
                activity_fields.insert("toolCount".to_string(), json!(tool_count));
            }
            fields.insert("activity".to_string(), value);
        }
    }
    enrich_command_outcome(event_type, fields);
}

fn enrich_command_outcome(event_type: &str, payload: &mut Map<String, Value>) {
    if event_type != "command.completed" {
        return;
    }
    let Some(exit_code) = numeric_exit_code(payload) else {
        return;
    };
    if exit_code == 0 {
        return;
    }

    let activity_kind = payload
        .get("activity")
        .and_then(Value::as_object)
        .and_then(|activity| activity.get("kind"))
        .and_then(Value::as_str);
    let recognized_search_command = activity_kind == Some("search")
        && payload
            .get("activity")
            .and_then(|activity| activity.get("evidence"))
            .and_then(Value::as_str)
            == Some("command")
        && command_value(tool_input(payload)).is_some_and(is_single_search_command);
    let explicit_failure = payload
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || payload.get("isError").and_then(Value::as_bool) == Some(true)
        || payload.get("error").is_some_and(|error| {
            error.is_object() || error.as_str().is_some_and(|message| !message.is_empty())
        })
        || matches!(
            payload.get("status").and_then(Value::as_str),
            Some("failed" | "error" | "errored" | "cancelled" | "canceled" | "interrupted")
        );
    if exit_code == 1 && recognized_search_command && !explicit_failure {
        payload.insert("status".to_string(), Value::String("completed".to_string()));
        payload.insert("noMatches".to_string(), Value::Bool(true));
        return;
    }

    payload.insert("is_error".to_string(), Value::Bool(true));
    if !matches!(
        payload.get("status").and_then(Value::as_str),
        Some("cancelled" | "canceled" | "interrupted")
    ) {
        payload.insert("status".to_string(), Value::String("failed".to_string()));
    }
}

fn numeric_exit_code(payload: &Map<String, Value>) -> Option<i64> {
    fn find(fields: &Map<String, Value>, depth: usize) -> Option<i64> {
        if depth > 4 {
            return None;
        }
        if let Some(code) = fields
            .get("exit_code")
            .or_else(|| fields.get("exitCode"))
            .and_then(Value::as_i64)
        {
            return Some(code);
        }
        ["result", "rawOutput", "output", "raw", "item"]
            .into_iter()
            .find_map(|key| {
                fields
                    .get(key)
                    .and_then(Value::as_object)
                    .and_then(|fields| find(fields, depth + 1))
            })
    }

    find(payload, 0)
}

fn classify(payload: &Map<String, Value>) -> Option<Activity> {
    let name = tool_name(payload)?;
    let input = tool_input(payload);
    let (name, input) = resolve_use_tool(name, input);
    let folded = folded_name(name);
    let leaf = match name {
        "shunt_shunt_read" => "shuntread".to_owned(),
        "shunt_shunt_write" => "shuntwrite".to_owned(),
        _ => folded_leaf(name),
    };

    if matches!(name, "mcp__cua_repl__js" | "mcp__cua_repl__js_reset")
        || (payload.get("server").and_then(Value::as_str) == Some("cua_repl")
            && matches!(leaf.as_str(), "js" | "jsreset"))
    {
        return Some(activity(
            ActivityKind::Computer,
            Evidence::Tool,
            payload,
            None,
        ));
    }
    if is_argmax_browser_tool(name, payload) {
        return Some(activity(ActivityKind::Tool, Evidence::Tool, payload, None));
    }

    if leaf == "run" && name.contains("__web__") {
        return classify_web_run(input, payload);
    }

    if leaf == "shuntwrite" && !has_non_empty_string(input, "target") {
        return Some(activity(ActivityKind::Tool, Evidence::Tool, payload, None));
    }

    // Namespaced MCP tools describe their own domain, not local filesystem
    // operations. Only shunt's two explicit file tools have that contract.
    // A memory server's `read` and Linear's `create` must stay integration
    // calls even though their leaf names happen to resemble file actions.
    if name.starts_with("mcp__")
        && !(name.starts_with("mcp__shunt__")
            && matches!(leaf.as_str(), "shuntread" | "shuntwrite"))
    {
        if image_result(payload) {
            return Some(activity(
                ActivityKind::Image,
                Evidence::Native,
                payload,
                None,
            ));
        }
        return Some(activity(ActivityKind::Tool, Evidence::Tool, payload, None));
    }

    if matches!(
        leaf.as_str(),
        "screenshot" | "takescreenshot" | "capturescreenshot"
    ) {
        return Some(activity(
            ActivityKind::ImageCapture,
            Evidence::Native,
            payload,
            None,
        ));
    }
    if matches!(
        leaf.as_str(),
        "imagegen" | "imagegenerate" | "generateimage" | "imagegeneration"
    ) {
        return Some(activity(
            ActivityKind::ImageGenerate,
            Evidence::Native,
            payload,
            None,
        ));
    }
    if image_result(payload) {
        return Some(activity(
            ActivityKind::Image,
            Evidence::Native,
            payload,
            None,
        ));
    }

    let (kind, evidence, operation) = match leaf.as_str() {
        "filechange" => (
            ActivityKind::Edit,
            Evidence::Native,
            explicit_operation(input),
        ),
        "imageview" => (ActivityKind::Image, Evidence::Native, None),
        "read" | "readfile" | "readtoolcall" | "shuntread" | "viewimage" => {
            let kind = if leaf == "viewimage" {
                ActivityKind::Image
            } else {
                ActivityKind::Read
            };
            (kind, Evidence::Tool, None)
        }
        "edit" | "write" | "writefile" | "editfile" | "applypatch" | "searchreplace"
        | "shuntwrite" => (
            ActivityKind::Edit,
            Evidence::Tool,
            explicit_operation(input).or(Some("edit")),
        ),
        "delete" | "deletefile" | "removefile" => {
            (ActivityKind::Edit, Evidence::Tool, Some("delete"))
        }
        "move" | "movefile" | "rename" | "renamefile" => {
            (ActivityKind::Edit, Evidence::Tool, Some("move"))
        }
        "create" | "createfile" => (ActivityKind::Edit, Evidence::Tool, Some("create")),
        "grep" | "ripgrep" | "search" | "searchfiles" | "codesearch" => {
            (ActivityKind::Search, Evidence::Tool, None)
        }
        "glob" | "find" | "findfiles" | "list" | "listfiles" | "listdir" | "listdirectory" => {
            (ActivityKind::List, Evidence::Tool, None)
        }
        "websearch" | "searchquery" => (ActivityKind::WebSearch, Evidence::Tool, None),
        "webfetch" | "fetchurl" | "openurl" => (ActivityKind::WebFetch, Evidence::Tool, None),
        "toolsearch" | "searchtool" | "getmcptools" | "getmcptoolstoolcall" => {
            (ActivityKind::Discovery, Evidence::Tool, None)
        }
        "skill" | "loadskill" => (ActivityKind::Skill, Evidence::Tool, None),
        "task" | "agent" | "spawnsubagent" | "tasktoolcall" | "spawnagent" => {
            (ActivityKind::Agent, Evidence::Tool, None)
        }
        "bash" | "shell" | "commandexecution" | "runterminalcommand" | "execcommand" => {
            if let Some(command) = command_value(input) {
                let explicit_write = match &command {
                    CommandValue::Text(text) => super::heredoc_activity::file_write_targets(text)
                        .map(|targets| (ActivityKind::Edit, targets)),
                    _ => None,
                };
                if let Some((kind, targets)) =
                    explicit_write.or_else(|| classify_simple_command(command))
                {
                    return Some(Activity {
                        kind,
                        evidence: Evidence::Command,
                        targets,
                        operation: None,
                        tool_count: None,
                    });
                }
            }
            (ActivityKind::Command, Evidence::Tool, None)
        }
        // A generic MCP call is still a real tool invocation, but its domain
        // verb is not evidence that it read or changed a local file.
        _ if name.starts_with("mcp__") || name.starts_with("mcp.") => {
            (ActivityKind::Tool, Evidence::Tool, None)
        }
        _ if folded == "tool" || folded == "tooluse" || folded == "toolcall" => {
            (ActivityKind::Tool, Evidence::Tool, None)
        }
        _ => (ActivityKind::Tool, Evidence::Tool, None),
    };

    let mut result = activity_from_input(kind, evidence, input, operation);
    if kind == ActivityKind::Discovery || leaf == "toolresult" {
        result.tool_count = discovery_tool_count(payload);
    }
    Some(result)
}

fn activity(
    kind: ActivityKind,
    evidence: Evidence,
    payload: &Map<String, Value>,
    operation: Option<&'static str>,
) -> Activity {
    activity_from_input(kind, evidence, tool_input(payload), operation)
}

fn activity_from_input(
    kind: ActivityKind,
    evidence: Evidence,
    input: Option<&Value>,
    operation: Option<&'static str>,
) -> Activity {
    let mut targets = Vec::new();
    if let Some(input) = input {
        match kind {
            ActivityKind::WebSearch | ActivityKind::Discovery => {
                collect_named_strings(input, &["query", "queries", "search_query"], &mut targets)
            }
            ActivityKind::WebFetch => collect_named_strings(input, &["url", "urls"], &mut targets),
            ActivityKind::Read
            | ActivityKind::Edit
            | ActivityKind::Image
            | ActivityKind::Search
            | ActivityKind::List
            | ActivityKind::ImageCapture => collect_named_strings(input, PATH_KEYS, &mut targets),
            ActivityKind::Command
            | ActivityKind::Tool
            | ActivityKind::Agent
            | ActivityKind::Skill
            | ActivityKind::Computer
            | ActivityKind::ImageGenerate => {}
        }
    }
    deduplicate(&mut targets);
    Activity {
        kind,
        evidence,
        targets,
        operation,
        tool_count: None,
    }
}

fn classify_web_run(input: Option<&Value>, payload: &Map<String, Value>) -> Option<Activity> {
    let input = input?;
    let fields = input.as_object()?;
    let kind = if fields.contains_key("search_query") || fields.contains_key("image_query") {
        ActivityKind::WebSearch
    } else if fields.contains_key("screenshot") {
        ActivityKind::ImageCapture
    } else if fields.contains_key("open")
        || fields.contains_key("click")
        || fields.contains_key("find")
    {
        ActivityKind::WebFetch
    } else {
        ActivityKind::Tool
    };
    Some(activity(kind, Evidence::Tool, payload, None))
}

fn is_argmax_browser_tool(name: &str, payload: &Map<String, Value>) -> bool {
    let tool = name
        .strip_prefix("mcp__argmax__")
        .or_else(|| name.strip_prefix("argmax__"))
        .or_else(|| name.strip_prefix("argmax_"))
        .or_else(|| {
            (payload.get("server").and_then(Value::as_str) == Some("argmax")).then_some(name)
        });
    matches!(
        tool,
        Some(
            "browser_open"
                | "browser_activate"
                | "browser_duplicate"
                | "browser_group_tabs"
                | "browser_open_link"
                | "browser_navigate"
                | "browser_back"
                | "browser_reload"
                | "browser_tabs"
                | "browser_close"
                | "browser_snapshot"
                | "browser_find"
                | "browser_get_text"
                | "browser_extract"
                | "browser_click"
                | "browser_type"
                | "browser_select"
                | "browser_hover"
                | "browser_press_key"
                | "browser_scroll"
                | "browser_drag"
                | "browser_wait_for"
                | "browser_screenshot"
                | "browser_evaluate"
                | "browser_console"
                | "browser_network"
                | "browser_handle_dialog"
        )
    )
}

fn resolve_use_tool<'a>(name: &'a str, input: Option<&'a Value>) -> (&'a str, Option<&'a Value>) {
    if folded_leaf(name) != "usetool" {
        return (name, input);
    }
    let Some(fields) = input.and_then(Value::as_object) else {
        return (name, input);
    };
    let resolved_name = fields
        .get("tool_name")
        .or_else(|| fields.get("toolName"))
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(name);
    let resolved_input = fields
        .get("tool_input")
        .or_else(|| fields.get("toolInput"))
        .or(input);
    (resolved_name, resolved_input)
}

fn tool_name(payload: &Map<String, Value>) -> Option<&str> {
    ["name", "tool", "tool_name", "toolName", "type"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
        .filter(|name| !name.is_empty())
}

fn tool_input(payload: &Map<String, Value>) -> Option<&Value> {
    ["input", "arguments", "args", "parameters"]
        .into_iter()
        .find_map(|key| payload.get(key))
}

fn has_non_empty_string(input: Option<&Value>, key: &str) -> bool {
    input
        .and_then(Value::as_object)
        .and_then(|fields| fields.get(key))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

fn folded_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

fn folded_leaf(name: &str) -> String {
    let leaf = name
        .rsplit("__")
        .next()
        .unwrap_or(name)
        .rsplit(['.', ':', '/'])
        .next()
        .unwrap_or(name);
    folded_name(leaf)
}

fn explicit_operation(input: Option<&Value>) -> Option<&'static str> {
    fn normalized(value: &Value) -> Option<&'static str> {
        match value.as_str()?.to_ascii_lowercase().as_str() {
            "create" | "add" => Some("create"),
            "edit" | "update" | "write" => Some("edit"),
            "delete" | "remove" => Some("delete"),
            "move" | "rename" => Some("move"),
            _ => None,
        }
    }

    let fields = input?.as_object()?;
    if let Some(operation) = fields.get("operation").and_then(normalized) {
        return Some(operation);
    }

    let changes = fields.get("changes")?.as_array()?;
    let operations = changes
        .iter()
        .map(|change| {
            let fields = change.as_object()?;
            fields
                .get("kind")
                .or_else(|| fields.get("operation"))
                .and_then(normalized)
        })
        .collect::<Option<Vec<_>>>()?;
    let first = *operations.first()?;
    operations
        .iter()
        .all(|operation| *operation == first)
        .then_some(first)
}

fn image_result(payload: &Map<String, Value>) -> bool {
    fn contains_image(value: &Value, depth: usize) -> bool {
        if depth > 4 {
            return false;
        }
        match value {
            Value::Array(values) => values.iter().any(|value| contains_image(value, depth + 1)),
            Value::Object(fields) => {
                let block_type = fields.get("type").and_then(Value::as_str);
                matches!(block_type, Some("image" | "image_url"))
                    || fields
                        .get("content")
                        .is_some_and(|value| contains_image(value, depth + 1))
            }
            _ => false,
        }
    }

    payload
        .get("content")
        .or_else(|| payload.get("result"))
        .is_some_and(|value| contains_image(value, 0))
}

fn discovery_tool_count(payload: &Map<String, Value>) -> Option<usize> {
    fn count(value: &Value, depth: usize) -> Option<usize> {
        if depth > 3 {
            return None;
        }
        if let Some(values) = value.as_array() {
            let tools = values
                .iter()
                .filter(|value| {
                    matches!(
                        value.get("type").and_then(Value::as_str),
                        Some("tool" | "tool_reference" | "toolReference")
                    )
                })
                .count();
            return (tools > 0).then_some(tools);
        }
        let fields = value.as_object()?;
        if let Some(count) = fields
            .get("toolCount")
            .or_else(|| fields.get("tool_count"))
            .and_then(Value::as_u64)
        {
            return usize::try_from(count).ok();
        }
        if let Some(tools) = fields.get("tools").and_then(Value::as_array) {
            return Some(tools.len());
        }
        fields.values().find_map(|value| count(value, depth + 1))
    }

    payload
        .get("result")
        .or_else(|| payload.get("content"))
        .and_then(|value| count(value, 0))
}

fn collect_named_strings(value: &Value, keys: &[&str], out: &mut Vec<String>) {
    fn visit(value: &Value, keys: &[&str], out: &mut Vec<String>, depth: usize) {
        if depth > 4 {
            return;
        }
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if keys.contains(&key.as_str()) {
                        collect_strings(value, out);
                    } else if matches!(
                        key.as_str(),
                        "action" | "input" | "args" | "parameters" | "changes"
                    ) {
                        visit(value, keys, out, depth + 1);
                    }
                }
            }
            Value::Array(values) => {
                for value in values {
                    visit(value, keys, out, depth + 1);
                }
            }
            _ => {}
        }
    }
    visit(value, keys, out, 0);
}

fn collect_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(value) if !value.is_empty() => out.push(value.clone()),
        Value::Array(values) => {
            for value in values {
                collect_strings(value, out);
            }
        }
        Value::Object(fields) => {
            if let Some(path) = fields.get("path").and_then(Value::as_str) {
                if !path.is_empty() {
                    out.push(path.to_string());
                }
            }
        }
        _ => {}
    }
}

fn deduplicate(values: &mut Vec<String>) {
    let mut seen = HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

enum CommandValue<'a> {
    Text(&'a str),
    Argv(&'a [Value]),
}

fn command_value(input: Option<&Value>) -> Option<CommandValue<'_>> {
    let input = input?;
    if let Some(command) = input.as_str() {
        return Some(CommandValue::Text(command));
    }
    let fields = input.as_object()?;
    let command = fields.get("command").or_else(|| fields.get("cmd"))?;
    if let Some(command) = command.as_str() {
        Some(CommandValue::Text(command))
    } else {
        command.as_array().map(|values| CommandValue::Argv(values))
    }
}

fn classify_simple_command(command: CommandValue<'_>) -> Option<(ActivityKind, Vec<String>)> {
    let parsed = command_stages(command)?;
    let mut activities = Vec::new();
    let mut working_directory = None;
    for (pipeline_index, pipeline) in parsed.pipelines.into_iter().enumerate() {
        if pipeline_index == 0 && pipeline.len() == 1 {
            if let Some(directory) = literal_cd_target(&pipeline[0]) {
                if parsed.separators.first() != Some(&SequenceSeparator::OnSuccess) {
                    return None;
                }
                working_directory = Some(directory.to_string());
                continue;
            }
        }
        for (index, words) in pipeline.into_iter().enumerate() {
            if let Some(mut activity) = classify_command_stage(&words, index > 0)? {
                if let Some(directory) = working_directory.as_deref() {
                    prefix_relative_targets(&mut activity.targets, directory)?;
                }
                activities.push(activity);
            }
        }
    }

    if let Some(edit) = activities
        .iter()
        .find(|activity| activity.kind == ActivityKind::Edit)
    {
        let mut targets = activities
            .iter()
            .filter(|activity| activity.kind == ActivityKind::Edit)
            .flat_map(|activity| activity.targets.iter().cloned())
            .collect::<Vec<_>>();
        deduplicate(&mut targets);
        return Some((edit.kind, targets));
    }

    // Keep the first content operation as the row's identity. A search-led
    // command may also print excerpts, while preparatory listings stay secondary.
    let winning_kind = activities
        .iter()
        .find(|activity| matches!(activity.kind, ActivityKind::Read | ActivityKind::Search))
        .or_else(|| activities.first())?
        .kind;
    let mut targets = activities
        .into_iter()
        .filter(|activity| activity.kind == winning_kind)
        .flat_map(|activity| activity.targets)
        .collect::<Vec<_>>();
    deduplicate(&mut targets);
    Some((winning_kind, targets))
}

fn is_single_search_command(command: CommandValue<'_>) -> bool {
    let Some(parsed) = command_stages(command) else {
        return false;
    };
    if parsed.pipelines.len() != 1 || parsed.pipelines[0].len() != 1 {
        return false;
    }

    let words = &parsed.pipelines[0][0];
    matches!(
        words.first().and_then(|word| word.rsplit('/').next()),
        Some("rg" | "ripgrep" | "grep")
    ) && classify_command_stage(words, false).is_some_and(|activity| {
        activity.is_some_and(|activity| activity.kind == ActivityKind::Search)
    })
}

#[derive(Debug, PartialEq, Eq)]
struct CommandStageActivity {
    kind: ActivityKind,
    targets: Vec<String>,
}

fn classify_command_stage(
    words: &[String],
    accepts_stdin: bool,
) -> Option<Option<CommandStageActivity>> {
    let executable = words.first()?;
    let executable = executable
        .strip_prefix("/usr/bin/")
        .or_else(|| executable.strip_prefix("/bin/"))
        .unwrap_or(executable);
    if executable.contains('/') {
        return None;
    }
    let args = &words[1..];
    let (kind, targets) = match executable {
        "cat" => (ActivityKind::Read, cat_targets(args)?),
        "head" | "tail" => {
            let targets = head_tail_targets(args, executable == "tail")?;
            if targets.is_empty() {
                return accepts_stdin.then_some(None);
            }
            (ActivityKind::Read, targets)
        }
        "sed" if args.first().map(String::as_str) == Some("-n") => {
            let targets = sed_targets(args)?;
            if targets.is_empty() {
                return accepts_stdin.then_some(None);
            }
            (ActivityKind::Read, targets)
        }
        "sed" => (ActivityKind::Edit, sed_in_place_targets(args)?),
        "perl" => (ActivityKind::Edit, perl_in_place_targets(args)?),
        "rg" | "ripgrep" => rg_targets(args)?,
        "grep" => (ActivityKind::Search, grep_targets(args)?),
        "ls" => (ActivityKind::List, ls_targets(args)?),
        "find" => (ActivityKind::List, find_targets(args)?),
        "fd" => (ActivityKind::List, fd_targets(args)?),
        "wc" => {
            wc_targets(args)?;
            return Some(None);
        }
        "echo" if args.is_empty() => return Some(None),
        "xcrun" if args == ["simctl", "list", "devices", "available"] => return Some(None),
        _ => return None,
    };
    Some(Some(CommandStageActivity { kind, targets }))
}

fn literal_cd_target(words: &[String]) -> Option<&str> {
    if words.len() != 2
        || words[0] != "cd"
        || words[1].is_empty()
        || words[1].starts_with('-')
        || words[1].starts_with('~')
    {
        return None;
    }
    Some(&words[1])
}

fn prefix_relative_targets(targets: &mut [String], directory: &str) -> Option<()> {
    for target in targets {
        if target.starts_with('~') {
            return None;
        }
        if !target.starts_with('/') {
            *target = format!("{}/{target}", directory.trim_end_matches('/'));
        }
    }
    Some(())
}

struct ParsedShellCommand {
    pipelines: Vec<Vec<Vec<String>>>,
    separators: Vec<SequenceSeparator>,
}

fn command_stages(command: CommandValue<'_>) -> Option<ParsedShellCommand> {
    match command {
        CommandValue::Text(command) => stages_from_tokens(simple_shell_words(command)?),
        CommandValue::Argv(values) => {
            let words = values
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()?
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            (!words.is_empty()).then_some(ParsedShellCommand {
                pipelines: vec![vec![words]],
                separators: Vec::new(),
            })
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ShellToken {
    Word(String),
    Pipe,
    And,
    Sequence,
    StderrToNull,
}

fn simple_shell_words(command: &str) -> Option<Vec<ShellToken>> {
    if command.trim().is_empty() {
        return None;
    }

    let mut words = Vec::new();
    let mut current = String::new();
    let mut word_started = false;
    let mut quote = None;
    let mut index = 0;
    while index < command.len() {
        let remaining = &command[index..];
        let character = remaining.chars().next()?;
        let width = character.len_utf8();
        match (quote, character) {
            (Some(active), character) if character == active => {
                quote = None;
                index += width;
            }
            (Some('\''), character) => {
                current.push(character);
                word_started = true;
                index += width;
            }
            (Some('"'), '$' | '`' | '\r' | '\n') => return None,
            (Some('"'), '\\') => {
                let escaped = remaining[width..].chars().next()?;
                if matches!(escaped, '$' | '`' | '"' | '\\') {
                    current.push(escaped);
                    word_started = true;
                    index += width + escaped.len_utf8();
                } else {
                    current.push(character);
                    index += width;
                }
            }
            (Some(_), character) => {
                current.push(character);
                word_started = true;
                index += width;
            }
            (None, '\'' | '"') => {
                quote = Some(character);
                word_started = true;
                index += width;
            }
            (None, '$' | '`' | '\r') => return None,
            (None, '\\') => {
                let escaped = remaining[width..].chars().next()?;
                if matches!(escaped, '\r' | '\n') {
                    return None;
                }
                current.push(escaped);
                word_started = true;
                index += width + escaped.len_utf8();
                continue;
            }
            (None, _) if remaining.starts_with("2>/dev/null") && current.is_empty() => {
                let after = &remaining[11..];
                if !after.is_empty()
                    && !after
                        .chars()
                        .next()
                        .is_some_and(|next| next.is_whitespace() || matches!(next, ';' | '&' | '|'))
                {
                    return None;
                }
                words.push(ShellToken::StderrToNull);
                index += 11;
                continue;
            }
            (None, '>' | '<') => return None,
            (None, '&') => {
                if !remaining.starts_with("&&") {
                    return None;
                }
                push_shell_word(&mut words, &mut current, &mut word_started);
                words.push(ShellToken::And);
                index += 2;
                continue;
            }
            (None, '|') => {
                if remaining.starts_with("||") {
                    return None;
                }
                push_shell_word(&mut words, &mut current, &mut word_started);
                words.push(ShellToken::Pipe);
                index += width;
                continue;
            }
            (None, ';' | '\n') => {
                push_shell_word(&mut words, &mut current, &mut word_started);
                words.push(ShellToken::Sequence);
                index += width;
                continue;
            }
            (None, character) if character.is_whitespace() => {
                push_shell_word(&mut words, &mut current, &mut word_started);
                index += width;
                continue;
            }
            (None, character) => {
                current.push(character);
                word_started = true;
                index += width;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    push_shell_word(&mut words, &mut current, &mut word_started);
    (!words.is_empty()).then_some(words)
}

fn push_shell_word(tokens: &mut Vec<ShellToken>, current: &mut String, word_started: &mut bool) {
    if *word_started {
        tokens.push(ShellToken::Word(std::mem::take(current)));
        *word_started = false;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SequenceSeparator {
    OnSuccess,
    Always,
}

fn stages_from_tokens(tokens: Vec<ShellToken>) -> Option<ParsedShellCommand> {
    let mut sequences = Vec::new();
    let mut separators = Vec::new();
    let mut pipeline = Vec::new();
    let mut stage = Vec::new();
    let mut redirected_stderr = false;

    for token in tokens {
        match token {
            ShellToken::Word(word) if !redirected_stderr => stage.push(word),
            ShellToken::Word(_) => return None,
            ShellToken::StderrToNull if !stage.is_empty() && !redirected_stderr => {
                redirected_stderr = true;
            }
            ShellToken::StderrToNull => return None,
            ShellToken::Pipe => {
                if stage.is_empty() {
                    return None;
                }
                pipeline.push(std::mem::take(&mut stage));
                redirected_stderr = false;
            }
            separator @ (ShellToken::And | ShellToken::Sequence) => {
                if stage.is_empty() {
                    return None;
                }
                pipeline.push(std::mem::take(&mut stage));
                sequences.push(std::mem::take(&mut pipeline));
                separators.push(match separator {
                    ShellToken::And => SequenceSeparator::OnSuccess,
                    ShellToken::Sequence => SequenceSeparator::Always,
                    _ => unreachable!(),
                });
                redirected_stderr = false;
            }
        }
    }
    if stage.is_empty() {
        return None;
    }
    pipeline.push(stage);
    sequences.push(pipeline);
    Some(ParsedShellCommand {
        pipelines: sequences,
        separators,
    })
}

fn cat_targets(args: &[String]) -> Option<Vec<String>> {
    operands_after_boolean_flags(args, &["-n", "-b", "-s", "-T", "-E", "-v"])
}

fn head_tail_targets(args: &[String], is_tail: bool) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            targets.extend_from_slice(&args[index + 1..]);
            break;
        }
        if matches!(arg.as_str(), "-q" | "-v" | "--quiet" | "--verbose")
            || (is_tail
                && matches!(
                    arg.as_str(),
                    "-f" | "-F"
                        | "-r"
                        | "--follow"
                        | "--follow=name"
                        | "--follow=descriptor"
                        | "--retry"
                ))
            || (arg.starts_with('-')
                && arg[1..].chars().all(|character| character.is_ascii_digit()))
            || arg.starts_with("--lines=")
            || arg.starts_with("--bytes=")
        {
            index += 1;
            continue;
        }
        if matches!(arg.as_str(), "-n" | "-c" | "--lines" | "--bytes") {
            index += 2;
            if index > args.len() {
                return None;
            }
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        targets.push(arg.clone());
        index += 1;
    }
    Some(targets)
}

fn sed_targets(args: &[String]) -> Option<Vec<String>> {
    if args.len() < 2 || args.first().map(String::as_str) != Some("-n") {
        return None;
    }
    let address = args[1].strip_suffix('p')?;
    if !address.is_empty()
        && (address.split(',').count() > 2
            || !address.split(',').all(|part| {
                part == "$" || (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            }))
    {
        return None;
    }
    let targets = args[2..].to_vec();
    targets
        .iter()
        .all(|arg| !arg.starts_with('-'))
        .then_some(targets)
}

fn sed_in_place_targets(args: &[String]) -> Option<Vec<String>> {
    if args.first().map(String::as_str) != Some("-i") || args.get(1).map(String::as_str) != Some("")
    {
        return None;
    }
    let index = 2;
    let script = args.get(index)?;
    if !is_simple_substitution(script, &['g', 'i', 'I', 'p']) {
        return None;
    }
    let targets = args.get(index + 1..)?.to_vec();
    (!targets.is_empty() && targets.iter().all(|target| !target.starts_with('-')))
        .then_some(targets)
}

fn perl_in_place_targets(args: &[String]) -> Option<Vec<String>> {
    if args.len() < 4 || args[0] != "-pi" || args[1] != "-e" {
        return None;
    }
    if !is_simple_substitution(&args[2], &['g', 'i', 'm', 's', 'x']) {
        return None;
    }
    let targets = args[3..].to_vec();
    (!targets.is_empty() && targets.iter().all(|target| !target.starts_with('-')))
        .then_some(targets)
}

fn is_simple_substitution(script: &str, allowed_flags: &[char]) -> bool {
    if script
        .chars()
        .any(|character| matches!(character, '\n' | '\r' | '`'))
        || script.contains("${")
        || script.contains("@{")
        || script.contains("(?{")
        || script.contains("(??{")
    {
        return false;
    }
    let mut characters = script.char_indices();
    if characters.next().map(|(_, character)| character) != Some('s') {
        return false;
    }
    let Some((_, delimiter)) = characters.next() else {
        return false;
    };
    if delimiter.is_ascii_alphanumeric() || delimiter.is_whitespace() || delimiter == '\\' {
        return false;
    }

    let mut separators = 0;
    let mut escaped = false;
    let mut flags_start = None;
    for (index, character) in characters {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == delimiter {
            separators += 1;
            if separators == 2 {
                flags_start = Some(index + character.len_utf8());
                break;
            }
        }
    }
    let Some(flags_start) = flags_start else {
        return false;
    };
    let flags = &script[flags_start..];
    flags
        .chars()
        .all(|flag| flag.is_ascii_digit() || allowed_flags.contains(&flag))
}

fn rg_targets(args: &[String]) -> Option<(ActivityKind, Vec<String>)> {
    let files_mode = args.iter().any(|arg| arg == "--files");
    let mut operands = Vec::new();
    let mut index = 0;
    let mut has_explicit_pattern = false;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            operands.extend_from_slice(&args[index + 1..]);
            break;
        }
        if arg == "--files"
            || matches!(
                arg.as_str(),
                "-n" | "-l"
                    | "-L"
                    | "-i"
                    | "-s"
                    | "-S"
                    | "-w"
                    | "-x"
                    | "-F"
                    | "-U"
                    | "-u"
                    | "-v"
                    | "--hidden"
                    | "--no-ignore"
            )
            || (arg.starts_with('-')
                && arg.len() > 1
                && arg[1..]
                    .chars()
                    .all(|character| "nliLsSswxFUuv".contains(character)))
            || arg.starts_with("--glob=")
            || arg.starts_with("--type=")
        {
            index += 1;
            continue;
        }
        if matches!(arg.as_str(), "-g" | "--glob" | "-t" | "--type") {
            index += 2;
            if index > args.len() {
                return None;
            }
            continue;
        }
        if matches!(arg.as_str(), "-e" | "--regexp") {
            index += 1;
            args.get(index)?;
            has_explicit_pattern = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        operands.push(arg.clone());
        index += 1;
    }
    if files_mode {
        return Some((ActivityKind::List, operands));
    }
    if !has_explicit_pattern {
        if operands.is_empty() {
            return None;
        }
        operands.remove(0);
    }
    Some((ActivityKind::Search, operands))
}

fn grep_targets(args: &[String]) -> Option<Vec<String>> {
    let mut operands = Vec::new();
    let mut index = 0;
    let mut has_explicit_pattern = false;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            operands.extend_from_slice(&args[index + 1..]);
            break;
        }
        if matches!(arg.as_str(), "--include" | "--exclude" | "--exclude-dir") {
            index += 1;
            args.get(index)?;
            index += 1;
            continue;
        }
        if ["--include=", "--exclude=", "--exclude-dir="]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
        {
            index += 1;
            continue;
        }
        if matches!(
            arg.as_str(),
            "-A" | "-B" | "-C" | "--after-context" | "--before-context" | "--context"
        ) {
            index += 1;
            if !args
                .get(index)
                .is_some_and(|value| value.bytes().all(|byte| byte.is_ascii_digit()))
            {
                return None;
            }
            index += 1;
            continue;
        }
        if matches!(
            arg.as_str(),
            "-r" | "-R"
                | "-n"
                | "-l"
                | "-L"
                | "-i"
                | "-s"
                | "-w"
                | "-x"
                | "-F"
                | "-v"
                | "--recursive"
                | "--line-number"
                | "--ignore-case"
                | "--fixed-strings"
        ) || ((arg.starts_with("-A") || arg.starts_with("-B") || arg.starts_with("-C"))
            && arg.len() > 2
            && arg[2..].bytes().all(|byte| byte.is_ascii_digit()))
            || arg.starts_with("--after-context=")
            || arg.starts_with("--before-context=")
            || arg.starts_with("--context=")
            || (arg.starts_with('-')
                && arg.len() > 1
                && arg[1..]
                    .chars()
                    .all(|character| "rRnliLsSwxFv".contains(character)))
        {
            index += 1;
            continue;
        }
        if matches!(arg.as_str(), "-e" | "--regexp") {
            index += 1;
            args.get(index)?;
            has_explicit_pattern = true;
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        operands.push(arg.clone());
        index += 1;
    }
    if !has_explicit_pattern {
        if operands.is_empty() {
            return None;
        }
        operands.remove(0);
    }
    Some(operands)
}

fn ls_targets(args: &[String]) -> Option<Vec<String>> {
    let mut targets = Vec::new();
    for arg in args {
        if arg == "--" {
            continue;
        }
        if arg.starts_with("--color=")
            || matches!(
                arg.as_str(),
                "--all"
                    | "--almost-all"
                    | "--recursive"
                    | "--directory"
                    | "--classify"
                    | "--human-readable"
            )
            || (arg.starts_with('-')
                && arg.len() > 1
                && arg[1..]
                    .chars()
                    .all(|character| "alAhR1Fpd".contains(character)))
        {
            continue;
        }
        if arg.starts_with('-') {
            return None;
        }
        targets.push(arg.clone());
    }
    Some(targets)
}

fn find_targets(args: &[String]) -> Option<Vec<String>> {
    let targets = args
        .iter()
        .take_while(|arg| !arg.starts_with('-') && arg.as_str() != "(" && arg.as_str() != "!")
        .cloned()
        .collect::<Vec<_>>();
    if targets.is_empty() {
        return None;
    }
    let mut predicates = args[targets.len()..].iter();
    while let Some(predicate) = predicates.next() {
        match predicate.as_str() {
            "-name" | "-iname" | "-path" | "-ipath" | "-type" | "-maxdepth" | "-mindepth"
            | "-size" | "-mtime" | "-mmin" => {
                predicates.next()?;
            }
            "-print" | "-print0" | "-ls" | "-empty" | "-prune" | "-depth" | "-o" | "-or" | "-a"
            | "-and" | "-not" | "!" | "(" | ")" => {}
            _ => return None,
        }
    }
    Some(targets)
}

fn fd_targets(args: &[String]) -> Option<Vec<String>> {
    if args.iter().any(|arg| arg.starts_with('-')) {
        return None;
    }
    // fd's first operand is the pattern and the rest are roots.
    Some(args.iter().skip(1).cloned().collect())
}

fn wc_targets(args: &[String]) -> Option<Vec<String>> {
    let targets = operands_after_boolean_flags(args, &["-l", "-w", "-c", "-m", "-L"])?;
    (!targets.is_empty()).then_some(targets)
}

fn operands_after_boolean_flags(args: &[String], allowed: &[&str]) -> Option<Vec<String>> {
    let mut operands = Vec::new();
    let mut options_done = false;
    for arg in args {
        if !options_done && arg == "--" {
            options_done = true;
        } else if !options_done && arg.starts_with('-') {
            if !allowed.contains(&arg.as_str()) {
                return None;
            }
        } else {
            operands.push(arg.clone());
        }
    }
    (!operands.is_empty()).then_some(operands)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::enrich_tool_activity;

    fn activity(mut payload: serde_json::Value) -> serde_json::Value {
        enrich_tool_activity("command.started", &mut payload);
        payload["activity"].clone()
    }

    fn completed(mut payload: serde_json::Value) -> serde_json::Value {
        enrich_tool_activity("command.completed", &mut payload);
        payload
    }

    #[test]
    fn exact_provider_tools_cover_all_five_providers() {
        let cases = [
            (
                json!({"name":"Read","input":{"file_path":"a.rs"}}),
                "read",
                "a.rs",
            ),
            (
                json!({"name":"file_change","input":{"path":"b.rs","operation":"create"}}),
                "edit",
                "b.rs",
            ),
            (
                json!({"name":"readToolCall","input":{"target_file":"c.rs"}}),
                "read",
                "c.rs",
            ),
            (
                json!({"name":"grep","input":{"path":"src"}}),
                "search",
                "src",
            ),
            (
                json!({"name":"search_replace","input":{"file_path":"d.rs"}}),
                "edit",
                "d.rs",
            ),
        ];
        for (payload, kind, target) in cases {
            let activity = activity(payload);
            assert_eq!(activity["kind"], kind);
            assert_eq!(activity["targets"], json!([target]));
        }
    }

    #[test]
    fn codex_change_arrays_supply_targets_and_only_homogeneous_operations() {
        let update = activity(json!({
            "name":"file_change",
            "input":{"changes":[{"kind":"update","path":"src/app.rs"}]}
        }));
        assert_eq!(update["targets"], json!(["src/app.rs"]));
        assert_eq!(update["operation"], "edit");

        let create = activity(json!({
            "name":"file_change",
            "input":{"changes":[
                {"kind":"add","path":"src/new.rs"},
                {"kind":"create","path":"src/other.rs"}
            ]}
        }));
        assert_eq!(create["targets"], json!(["src/new.rs", "src/other.rs"]));
        assert_eq!(create["operation"], "create");

        let mixed = activity(json!({
            "name":"file_change",
            "input":{"changes":[
                {"kind":"add","path":"src/new.rs"},
                {"kind":"update","path":"src/app.rs"}
            ]}
        }));
        assert_eq!(mixed["targets"], json!(["src/new.rs", "src/app.rs"]));
        assert!(mixed.get("operation").is_none());
    }

    #[test]
    fn mcp_wrappers_and_tool_discovery_keep_their_real_semantics() {
        let mut wrapped = json!({"name":"use_tool","input":{
            "tool_name":"linear__list_issues", "tool_input":{"query":"activity"}
        }});
        enrich_tool_activity("command.started", &mut wrapped);
        assert_eq!(wrapped["name"], "mcp__linear__list_issues");
        assert_eq!(wrapped["input"]["query"], "activity");
        assert_eq!(wrapped["activity"]["kind"], "tool");
        assert_eq!(wrapped["toolWrapper"]["name"], "use_tool");
        for (name, expected) in [
            ("shunt_shunt_read", "read"),
            ("list_dir", "list"),
            ("Agent", "agent"),
            ("spawn_subagent", "agent"),
        ] {
            assert_eq!(activity(json!({"name":name}))["kind"], expected, "{name}");
        }
        assert_eq!(
            activity(json!({"name":"shunt_shunt_write"}))["kind"],
            "tool"
        );
        let read = activity(json!({
            "name":"mcp__shunt__shunt_read",
            "input":{"paths":["one.rs","two.rs"]}
        }));
        assert_eq!(read["kind"], "read");
        assert_eq!(read["targets"], json!(["one.rs", "two.rs"]));

        let edit = activity(json!({
            "name":"use_tool",
            "input":{"tool_name":"shunt_write","tool_input":{"target":"out.rs"}}
        }));
        assert_eq!(edit["kind"], "edit");
        assert_eq!(edit["targets"], json!(["out.rs"]));

        let generated = activity(json!({
            "name":"mcp__shunt__shunt_write",
            "input":{"reference":"example.rs","spec":"Return code only"}
        }));
        assert_eq!(generated["kind"], "tool");
        assert_eq!(generated["targets"], json!([]));

        let discovery = activity(json!({"name":"ToolSearch","input":{"query":"select:mcp"}}));
        assert_eq!(discovery["kind"], "discovery");
        assert_eq!(discovery["targets"], json!(["select:mcp"]));

        let anonymous_result = activity(json!({
            "type":"tool_result",
            "content":[{"type":"tool_reference","name":"one"},{"type":"tool_reference","name":"two"}]
        }));
        assert_eq!(anonymous_result["kind"], "tool");
        assert_eq!(anonymous_result["toolCount"], 2);
    }

    #[test]
    fn images_require_native_or_result_evidence() {
        let path_only = activity(json!({"name":"Read","input":{"path":"photo.png"}}));
        assert_eq!(path_only["kind"], "read");

        let dedicated = activity(json!({"name":"image_view","input":{"path":"photo.png"}}));
        assert_eq!(dedicated["kind"], "image");

        let result = activity(json!({
            "name":"tool_result",
            "content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"omitted"}}]
        }));
        assert_eq!(result["kind"], "image");
        assert_eq!(result["evidence"], "native");

        for (name, expected) in [
            ("screenshot", "image-capture"),
            ("imagegen", "image-generate"),
        ] {
            let result = activity(json!({
                "name": name,
                "result": {"type":"image","mimeType":"image/png","data":"omitted"}
            }));
            assert_eq!(result["kind"], expected, "{name}");
        }
    }

    #[test]
    fn integration_artwork_is_not_viewed_image_content_and_old_labels_are_repaired() {
        // Shape observed on Codex's linear.list_issues result. The SVG is the
        // server logo, not image content returned for the model to inspect.
        let payload = json!({
            "name":"linear.list_issues", "server":"codex_apps", "tool":"linear.list_issues",
            "result":{
                "_meta":{"io.modelcontextprotocol/serverInfo":{"icons":[
                    {"mimeType":"image/svg+xml","src":"https://example.test/logo.svg"}
                ]}},
                "content":[{"type":"text","text":"Issue data"}],
                "structured_content":{"type":"image","description":"ordinary domain data"}
            },
            "activity":{"version":1,"kind":"image","evidence":"native","targets":[]}
        });
        let repaired = completed(payload.clone());
        assert_eq!(repaired["activity"]["kind"], "tool");
        assert_eq!(repaired["activity"]["evidence"], "tool");
        assert_eq!(repaired["result"], payload["result"]);

        let mut actual_image = payload;
        actual_image["result"]["content"] = json!([
            {"type":"image","mimeType":"image/png","data":"omitted"}
        ]);
        assert_eq!(completed(actual_image)["activity"]["kind"], "image");
    }

    #[test]
    fn historical_command_fallbacks_refresh_to_file_reads() {
        let repaired = completed(json!({
            "name":"Bash",
            "input":{"command":"cat docs/design/pickers/README.md | head -60; sed -n 1,40p docs/design/pickers/index.html"},
            "activity":{"version":1,"kind":"command","evidence":"tool","targets":[]},
            "exitCode":0
        }));
        assert_eq!(repaired["activity"]["kind"], "read");
        assert_eq!(
            repaired["activity"]["targets"],
            json!([
                "docs/design/pickers/README.md",
                "docs/design/pickers/index.html"
            ])
        );
    }

    #[test]
    fn tail_reads_and_live_log_following_are_file_activity() {
        for command in [
            "tail -40 app.log",
            "tail -n 40 app.log",
            "tail -c 600 app.log",
            "tail -f app.log",
            "tail -F app.log",
            "tail --follow=name --retry app.log",
            "cat app.log | tail -5",
        ] {
            let result = activity(json!({"name":"Bash","input":{"command":command}}));
            assert_eq!(result["kind"], "read", "{command}");
            assert_eq!(result["targets"], json!(["app.log"]), "{command}");
        }
        assert_eq!(
            activity(json!({"name":"Bash","input":{"command":"tail -f app.log > copy.log"}}))
                ["kind"],
            "command"
        );
    }

    #[test]
    fn explicit_heredoc_writes_override_generic_script_activity() {
        let command = "cd ios/Argmax && python3 - <<'PY'\np='source.swift'\nopen(p, 'w').write('updated')\nPY\ncat > Tests/Scratch.swift <<'EOF'\n// example: cat > unrelated.swift\nEOF\nxcodebuild > /tmp/build.log 2>&1; tail -5 /tmp/build.log";
        let classified = activity(json!({"name":"Bash","input":{"command":command}}));
        assert_eq!(classified["kind"], "edit");
        assert_eq!(
            classified["targets"],
            json!(["ios/Argmax/Tests/Scratch.swift"])
        );
    }

    #[test]
    fn search_led_sequences_keep_search_identity_even_when_printing_excerpts() {
        for command in [
            r#"grep -rn "glyphColumn\|ChatRowGlyphView\|ChatRowGlyph(" ios/Argmax/Sources --include=*.swift | grep -v "^ios/Argmax/Sources/Chats/ChatRowGlyph.swift"; grep -rn "ChatRowGlyph" ios/Argmax/Tests 2>/dev/null | head -3; sed -n 640,700p ios/Argmax/Sources/Chats/ChatListView.swift; grep -n "appearance\|Chat icons\|Provider marks" ios/Argmax/Sources/Settings/SettingsScreen.swift | head; grep -rn "chat icons\|glyph column\|leading column" docs/*.md ios/Argmax/README.md | head"#,
            r#"grep -rn "glyphColumn\|ChatRowGlyphView" ios/Argmax/Sources | grep -v "Chats/ChatRowGlyph.swift"; sed -n 132,150p ios/Argmax/README.md; sed -n 84,100p ios/Argmax/Sources/Settings/SettingsScreen.swift; grep -n "plainRow\|HairlineDivider(inset" ios/Argmax/Sources/Design/Controls.swift | head -4"#,
        ] {
            assert_eq!(
                activity(json!({"name":"Bash","input":{"command":command}}))["kind"],
                "search"
            );
        }
        for command in [
            "./cat file.rs",
            "/tmp/sed -n 1p file.rs",
            "/tmp/grep needle file.rs",
        ] {
            assert_eq!(
                activity(json!({"name":"Bash","input":{"command":command}}))["kind"],
                "command"
            );
        }
    }

    #[test]
    fn computer_tools_keep_their_identity_when_returning_screenshots() {
        for payload in [
            json!({"name":"mcp__cua_repl__js","input":{"code":"await cua.getState()"}}),
            json!({"name":"js","server":"cua_repl","tool":"js","input":{"code":"await cua.getState()"}}),
            json!({"name":"mcp__cua_repl__js_reset"}),
            json!({"name":"mcp__cua_repl__js","result":{"type":"image","mimeType":"image/png","data":"omitted"}}),
        ] {
            assert_eq!(activity(payload)["kind"], "computer");
        }
        assert_eq!(activity(json!({"name":"js"}))["kind"], "tool");
        for payload in [
            json!({"name":"mcp__argmax__browser_click","input":{"tab":"tab-1","ref":"button-3"}}),
            json!({"name":"browser_screenshot","server":"argmax","tool":"browser_screenshot","result":{"type":"image","data":"omitted"}}),
            json!({"name":"argmax_browser_snapshot","input":{"tab":"tab-1"}}),
        ] {
            assert_eq!(activity(payload)["kind"], "tool");
        }
        assert_eq!(
            activity(json!({"name":"js","server":"node_repl","tool":"js"}))["kind"],
            "tool"
        );
        assert_eq!(
            activity(json!({"name":"mcp__unrelated__browser_click"}))["kind"],
            "tool"
        );
    }

    #[test]
    fn simple_commands_are_precise_and_complex_commands_fall_back() {
        let read =
            activity(json!({"name":"Bash","input":{"command":"sed -n '1,40p' src/main.rs"}}));
        assert_eq!(read["kind"], "read");
        assert_eq!(read["evidence"], "command");
        assert_eq!(read["targets"], json!(["src/main.rs"]));

        let search = activity(
            json!({"name":"command_execution","input":{"command":["rg","-n","needle","src"]}}),
        );
        assert_eq!(search["kind"], "search");
        assert_eq!(search["targets"], json!(["src"]));

        let list = activity(json!({"name":"shell","input":{"command":"rg --files src"}}));
        assert_eq!(list["kind"], "list");
        assert_eq!(list["targets"], json!(["src"]));

        let piped_read = activity(json!({
            "name":"Bash",
            "input":{"command":"cat a.rs | sed -n 1p; echo; sed -n 2,4p b.rs"}
        }));
        assert_eq!(piped_read["kind"], "read");
        assert_eq!(piped_read["targets"], json!(["a.rs", "b.rs"]));

        for command in [
            "python -c 'open(\"a.rs\").read()'",
            "cat $(find . -name a.rs)",
            "sed -i s/a/b/ a.rs",
            "sed -n '/p/w /tmp/copied' input.txt",
            "find . -fprint0 out.txt",
            "find . -fprintf out.txt %p",
            "find . -unknown",
            "cat a.rs > copied.rs",
            "cat a.rs 2>/tmp/errors",
            "cat a.rs || cat b.rs",
            "cat a.rs & cat b.rs",
            "cat 'unterminated",
            "cat a.rs; tee copied.rs",
            "./cat a.rs",
            "/tmp/sed -n 1p a.rs",
            "/usr/local/bin/grep needle a.rs",
        ] {
            let fallback = activity(json!({"name":"Bash","input":{"command":command}}));
            assert_eq!(fallback["kind"], "command", "{command}");
            assert_eq!(fallback["evidence"], "tool", "{command}");
        }

        let system_path = activity(json!({
            "name":"Bash", "input":{"command":"/bin/cat a.rs; /usr/bin/sed -n 1p b.rs"}
        }));
        assert_eq!(system_path["kind"], "read");
        assert_eq!(system_path["targets"], json!(["a.rs", "b.rs"]));
    }

    #[test]
    fn read_only_shell_sequences_and_pipelines_use_the_strongest_real_activity() {
        let fixture_commands = [
            r#"wc -l ios/Argmax/Sources/Chats/ChatRowGlyph.swift ios/Argmax/Sources/Chats/ChatListView.swift && cat ios/Argmax/Sources/Chats/ChatRowGlyph.swift && grep -n "Glyph\|gutter\|leading\|HStack\|ProviderMark\|provider" ios/Argmax/Sources/Chats/ChatListView.swift | head -80 && ls ios/Argmax/Sources/Design/ && ls docs/design 2>/dev/null | head"#,
            r#"sed -n 555,640p ios/Argmax/Sources/Chats/ChatListView.swift; grep -n "glyphColumn\|gutter" ios/Argmax/Sources/Design/Metrics.swift; ls docs/design/pickers docs/design/agent-emblems | head -20; grep -rn "canvas\|ink\b\|muted\|line\b" ios/Argmax/Sources/Design/Theme.swift | head -20"#,
            r#"cat docs/design/pickers/README.md | head -60; sed -n 1,40p docs/design/pickers/index.html; sed -n 1,60p ios/Argmax/Sources/Design/Theme.swift; grep -n "rowTitle\|meta\b\|caption" ios/Argmax/Sources/Design/Typography.swift | head; ls ios/Argmax/Sources/Design/ProviderMark.swift && sed -n 1,60p ios/Argmax/Sources/Design/ProviderMark.swift"#,
            r#"sed -n 60,120p docs/design/pickers/README.md; ls ios/Argmax/Sources/Assets.xcassets/Providers/ 2>/dev/null; ls ios/Argmax/Sources/Assets.xcassets/Providers/*.imageset 2>/dev/null | head; grep -rln "providerMark\|ProviderMark" src/renderer/components | head -5; ls scripts | grep -i "shot\|screen\|capture"; sed -n 1,40p ios/Argmax/Sources/Design/WorkingNest.swift; sed -n 1,30p ios/Argmax/Sources/Design/Metrics.swift; grep -n "AttentionCapsule" -A 20 ios/Argmax/Sources/Chats/ChatListView.swift | grep -n "struct AttentionCapsule" -A 18 | head -30"#,
            r#"cat ios/Argmax/Sources/Assets.xcassets/Providers/claude.imageset/claude.svg | head -c 600; echo; cat ios/Argmax/Sources/Assets.xcassets/Providers/codex.imageset/codex.svg | head -c 400; echo; ls ios/Argmax/Sources/Assets.xcassets/Providers/cursor.imageset ios/Argmax/Sources/Assets.xcassets/Providers/grok.imageset ios/Argmax/Sources/Assets.xcassets/Providers/opencode.imageset; sed -n 1,40p scripts/ui-screenshot.mjs; grep -n "chatIcons\|providerMarks" ios/Argmax/Sources/Design/Appearance.swift | head; grep -n "struct AttentionCapsule" -A 16 ios/Argmax/Sources/Chats/ChatListView.swift; grep -n "typeRowTitle\|func typeMeta" -A 4 ios/Argmax/Sources/Design/Typography.swift | head -20"#,
            r#"cat src/renderer/styles/working-nest.css | head -60; grep -n "session-icon\|--accent:" src/renderer/styles/tokens.css | head -20; grep -n "pr-open\|pr-merged" src/renderer/styles/tokens.css | head; grep -n "font-ui\|--bg:\|--text:\|--muted:\|--line:" src/renderer/styles/tokens.css | head -12"#,
        ];

        for command in fixture_commands {
            let result = activity(json!({"name":"Bash","input":{"command":command}}));
            assert_eq!(result["kind"], "read", "{command}");
            assert_eq!(result["evidence"], "command", "{command}");
        }

        let strongest = activity(json!({
            "name":"Bash",
            "input":{"command":"sed -n 1,20p read.rs; grep -n 'a;b|c' searched.rs; ls listed"}
        }));
        assert_eq!(strongest["kind"], "read");
        assert_eq!(strongest["targets"], json!(["read.rs"]));

        let list_filter = activity(json!({
            "name":"Bash", "input":{"command":"ls scripts | head -5"}
        }));
        assert_eq!(list_filter["kind"], "list");
        assert_eq!(list_filter["targets"], json!(["scripts"]));

        let search_filter = activity(json!({
            "name":"Bash", "input":{"command":"ls scripts | grep -i 'shot|screen|capture'"}
        }));
        assert_eq!(search_filter["kind"], "search");
        assert_eq!(search_filter["targets"], json!([]));

        let count_only = activity(json!({
            "name":"Bash", "input":{"command":"wc -l read.rs"}
        }));
        assert_eq!(count_only["kind"], "command");
        assert_eq!(count_only["evidence"], "tool");
    }

    #[test]
    fn literal_in_place_substitutions_are_file_edits() {
        let fixture_commands = [
            r#"cd ios/Argmax && sed -i '' 's/    var size: CGFloat = 18$/    var size: CGFloat = 12/' Sources/Chats/ChatRowGlyph.swift && sed -i '' 's/ChatRowGlyphView(glyph: glyph, size: 12)/ChatRowGlyphView(glyph: glyph)/' Sources/Chats/ChatListView.swift && grep -n "var size\|ChatRowGlyphView(" Sources/Chats/*.swift; grep -n "ios\|xcodebuild\|simctl" ../../package.json | head; ls; grep -n "xcodebuild\|xcodegen\|just\|build" README.md | head -12"#,
            r#"perl -pi -e 's/^    var size: CGFloat = 18$/    var size: CGFloat = 12/' Sources/Chats/ChatRowGlyph.swift && perl -pi -e 's/ChatRowGlyphView\(glyph: glyph, size: 12\)/ChatRowGlyphView(glyph: glyph)/' Sources/Chats/ChatListView.swift && grep -n "var size\|ChatRowGlyphView(" Sources/Chats/*.swift; sed -n 196,240p README.md; ls *.xcodeproj 2>/dev/null; xcrun simctl list devices available | grep -i "iphone" | head -3"#,
        ];

        let sed_edit = activity(json!({"name":"Bash","input":{"command":fixture_commands[0]}}));
        assert_eq!(sed_edit["kind"], "edit");
        assert_eq!(sed_edit["evidence"], "command");
        assert_eq!(
            sed_edit["targets"],
            json!([
                "ios/Argmax/Sources/Chats/ChatRowGlyph.swift",
                "ios/Argmax/Sources/Chats/ChatListView.swift"
            ])
        );

        let perl_edit = activity(json!({"name":"Bash","input":{"command":fixture_commands[1]}}));
        assert_eq!(perl_edit["kind"], "edit");
        assert_eq!(perl_edit["evidence"], "command");
        assert_eq!(
            perl_edit["targets"],
            json!([
                "Sources/Chats/ChatRowGlyph.swift",
                "Sources/Chats/ChatListView.swift"
            ])
        );

        for command in [
            "perl -e 'print 1' file.txt",
            "perl -pi -e 'unlink q(file)' file.txt",
            "perl -pi -e 's/a/b/e' file.txt",
            "perl -pi -e 's/a/${\\system(q(id))}/' file.txt",
            "sed -i.bak 's/a/b/' file.txt",
            "sed -i '' '1w copied.txt' file.txt",
            "sed -i '' 's/a/b/w copied.txt' file.txt",
            "xcrun simctl erase all",
            "cd ios/Argmax && sed -i '' 's/a/b/' file.txt; unknown-command",
            "cd ios/Argmax; sed -i '' 's/a/b/' file.txt",
            "cd ios/Argmax\nsed -i '' 's/a/b/' file.txt",
            "cd ios/Argmax && sed -i '' 's/a/b/' ~/file.txt",
            "cd ~/Argmax && sed -i '' 's/a/b/' file.txt",
        ] {
            let fallback = activity(json!({"name":"Bash","input":{"command":command}}));
            assert_eq!(fallback["kind"], "command", "{command}");
            assert_eq!(fallback["evidence"], "tool", "{command}");
        }
    }

    #[test]
    fn shell_exit_codes_distinguish_errors_from_empty_searches() {
        let missing = completed(json!({
            "name":"Bash",
            "input":{"command":"cat missing.txt"},
            "result":{"exitCode":1}
        }));
        assert_eq!(missing["activity"]["kind"], "read");
        assert_eq!(missing["status"], "failed");
        assert_eq!(missing["is_error"], true);

        let no_matches = completed(json!({
            "name":"shell",
            "input":{"command":"rg needle src"},
            "result":{"exit_code":1}
        }));
        assert_eq!(no_matches["activity"]["kind"], "search");
        assert_eq!(no_matches["status"], "completed");
        assert_eq!(no_matches["noMatches"], true);
        assert!(no_matches.get("is_error").is_none());

        let search_error = completed(json!({
            "name":"command_execution",
            "input":{"command":["grep","needle","src"]},
            "exitCode":2
        }));
        assert_eq!(search_error["activity"]["kind"], "search");
        assert_eq!(search_error["status"], "failed");
        assert_eq!(search_error["is_error"], true);

        let compound = completed(json!({
            "name":"Bash",
            "input":{"command":"grep needle first.rs; grep needle second.rs"},
            "exitCode":1
        }));
        assert_eq!(compound["status"], "failed");
        assert!(compound.get("noMatches").is_none());
    }

    #[test]
    fn arbitrary_tool_verbs_do_not_claim_file_access() {
        for (server, name) in [
            ("linear", "create_issue"),
            ("linear", "view_dashboard"),
            ("memory", "read"),
            ("linear", "create"),
            ("crm", "search_contacts"),
        ] {
            let result = activity(
                json!({"name":format!("mcp__{server}__{name}"),"input":{"path":"not-a-file"}}),
            );
            assert_eq!(result["kind"], "tool", "{name}");
            assert_eq!(result["targets"], json!([]), "{name}");
        }
    }

    #[test]
    fn unrelated_events_and_existing_activity_are_untouched() {
        let mut message = json!({"name":"Read","input":{"path":"a.rs"}});
        enrich_tool_activity("message.completed", &mut message);
        assert!(message.get("activity").is_none());

        let mut existing = json!({"name":"Read","activity":{"version":99}});
        enrich_tool_activity("command.started", &mut existing);
        assert_eq!(existing["activity"]["version"], 99);
    }
}
