use serde::Serialize;
use serde_json::Value;
use specta::Type;

/// Provider-independent meaning of a timeline row. The original type and
/// payload remain available for diagnostics and presentation details.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSemantics {
    pub version: u8,
    pub context: TimelineContext,
    pub event: SemanticEvent,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineContext {
    pub parent_tool_use_id: Option<String>,
    pub provider_thread_id: Option<String>,
    pub provider_invocation_id: Option<String>,
    pub provider_child_session_id: Option<String>,
    pub provider_parent_conversation_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub agent_root_tool_use_id: Option<String>,
    pub agent_codename: Option<String>,
    pub agent_model_id: Option<String>,
    pub agent_reasoning_effort: Option<String>,
    pub is_raw: bool,
    pub trace_superseded: bool,
    pub trace_imported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SemanticEvent {
    #[specta(rename_all = "camelCase")]
    Message {
        role: MessageRole,
        phase: MessagePhase,
        content: MessageContent,
        delivery: Option<MessageDelivery>,
        raw_stream: bool,
        cumulative_text: Option<String>,
    },
    #[specta(rename_all = "camelCase")]
    Tool {
        phase: ToolPhase,
        tool_use_id: Option<String>,
        name: String,
        provider_name: Option<String>,
        outcome: Option<ToolOutcome>,
        running: bool,
        surface: Option<String>,
        trace_synthetic_launch: bool,
    },
    #[specta(rename_all = "camelCase")]
    Approval {
        phase: ApprovalPhase,
        approval_id: Option<String>,
        provider: Option<String>,
        provider_request_id: Option<String>,
        tool_use_id: Option<String>,
        resolution: Option<String>,
    },
    Agent {
        phase: AgentPhase,
        status: Option<String>,
    },
    Lifecycle {
        name: LifecycleName,
    },
    #[specta(rename_all = "camelCase")]
    Multitask {
        phase: MultitaskPhase,
        child_session_id: Option<String>,
        state: Option<String>,
        task_label: Option<String>,
        prompt: Option<String>,
        worktree: bool,
        answer: Option<String>,
    },
    #[specta(rename_all = "camelCase")]
    Visualization {
        artifact_id: String,
        title: String,
        format: crate::visualizations::VisualizationFormat,
        summary: String,
        mode: Option<crate::visualizations::VisualizationMode>,
    },
    Error {
        code: Option<String>,
        operation: Option<String>,
    },
    Unknown {
        reason: UnknownReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MessagePhase {
    Delta,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MessageContent {
    Answer,
    Thinking,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MessageDelivery {
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolPhase {
    Started,
    Output,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ToolOutcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalPhase {
    Requested,
    Resolved,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentPhase {
    Started,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MultitaskPhase {
    Launched,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleName {
    Started,
    Streaming,
    Completed,
    Cancelled,
    Cleared,
    RecoveredFromCrash,
    Compacting,
    Compacted,
    ProviderChanged,
    MoveRequested,
    ArchiveRequested,
    Moved,
    Note,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum UnknownReason {
    InvalidPayload,
    UnsupportedType,
}

fn field<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str().filter(|value| !value.is_empty())
}

fn first_field<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| field(payload, key))
}

fn provider_thread_id(payload: &Value) -> Option<String> {
    let item = payload.get("item");
    let agent_message = field(payload, "item_type") == Some("agent_message")
        || item.and_then(|item| field(item, "type")) == Some("agent_message");
    agent_message
        .then(|| {
            first_field(payload, &["thread_id", "sender_thread_id"])
                .or_else(|| {
                    item.and_then(|item| first_field(item, &["thread_id", "sender_thread_id"]))
                })
                .map(str::to_owned)
        })
        .flatten()
}

fn context(payload: &Value) -> TimelineContext {
    TimelineContext {
        parent_tool_use_id: first_field(payload, &["parent_tool_use_id", "parentToolUseId"])
            .map(str::to_owned),
        provider_thread_id: provider_thread_id(payload),
        provider_invocation_id: field(payload, "providerInvocationId").map(str::to_owned),
        provider_child_session_id: field(payload, "providerChildSessionId").map(str::to_owned),
        provider_parent_conversation_id: field(payload, "providerParentConversationId")
            .map(str::to_owned),
        agent_run_id: field(payload, "agentRunId").map(str::to_owned),
        agent_root_tool_use_id: first_field(payload, &["agentRootToolUseId", "parentToolUseId"])
            .map(str::to_owned),
        agent_codename: first_field(payload, &["agentCodename", "agentNickname"])
            .map(str::to_owned),
        agent_model_id: field(payload, "agentModelId").map(str::to_owned),
        agent_reasoning_effort: field(payload, "agentReasoningEffort").map(str::to_owned),
        is_raw: payload.get("raw").and_then(Value::as_bool) == Some(true),
        trace_superseded: payload
            .get("traceSyntheticSuperseded")
            .and_then(Value::as_bool)
            == Some(true),
        trace_imported: payload.get("traceImported").and_then(Value::as_bool) == Some(true),
    }
}

fn lifecycle_name(event_type: &str) -> Option<LifecycleName> {
    Some(match event_type {
        "session.started" => LifecycleName::Started,
        "session.streaming" => LifecycleName::Streaming,
        "session.completed" => LifecycleName::Completed,
        "session.cancelled" => LifecycleName::Cancelled,
        "session.cleared" => LifecycleName::Cleared,
        "session.recovered-from-crash" => LifecycleName::RecoveredFromCrash,
        "session.compacting" => LifecycleName::Compacting,
        "session.compacted" => LifecycleName::Compacted,
        "session.provider-changed" => LifecycleName::ProviderChanged,
        "session.move-requested" => LifecycleName::MoveRequested,
        "session.archive-requested" => LifecycleName::ArchiveRequested,
        "session.moved" => LifecycleName::Moved,
        "session.note" => LifecycleName::Note,
        _ => return None,
    })
}

fn cumulative_text(payload: &Value) -> Option<String> {
    if field(payload, "type") != Some("assistant") {
        return None;
    }
    let content = payload.get("message")?.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(|part| field(part, "text"))
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

pub fn derive(event_type: &str, event_id: &str, payload: &Value) -> TimelineSemantics {
    let context = context(payload);
    let event = if !payload.is_object()
        || payload.get("parseError").and_then(Value::as_bool) == Some(true)
    {
        SemanticEvent::Unknown {
            reason: UnknownReason::InvalidPayload,
        }
    } else if matches!(
        event_type,
        "user.message" | "message.delta" | "message.completed"
    ) {
        let phase = if event_type == "message.delta" {
            MessagePhase::Delta
        } else {
            MessagePhase::Completed
        };
        SemanticEvent::Message {
            role: if event_type == "user.message" {
                MessageRole::User
            } else {
                MessageRole::Assistant
            },
            phase,
            content: if event_type == "message.delta"
                && payload.get("thinking").and_then(Value::as_bool) == Some(true)
            {
                MessageContent::Thinking
            } else {
                MessageContent::Answer
            },
            delivery: (event_type == "user.message" && field(payload, "delivery") == Some("steer"))
                .then_some(MessageDelivery::Steer),
            raw_stream: matches!(field(payload, "stream"), Some("stdout" | "stderr" | "pty")),
            cumulative_text: cumulative_text(payload),
        }
    } else if matches!(
        event_type,
        "command.started" | "command.output" | "command.completed"
    ) {
        let phase = match event_type {
            "command.started" => ToolPhase::Started,
            "command.output" => ToolPhase::Output,
            _ => ToolPhase::Completed,
        };
        let status = field(payload, "status").map(str::to_ascii_lowercase);
        let outcome = if phase != ToolPhase::Completed {
            None
        } else if payload.get("cancelled").and_then(Value::as_bool) == Some(true)
            || payload.get("canceled").and_then(Value::as_bool) == Some(true)
            || matches!(
                status.as_deref(),
                Some("cancelled" | "canceled" | "interrupted")
            )
        {
            Some(ToolOutcome::Cancelled)
        } else if crate::providers::tool_activity::semantic_tool_failed(payload) {
            Some(ToolOutcome::Failed)
        } else {
            Some(ToolOutcome::Succeeded)
        };
        SemanticEvent::Tool {
            phase,
            tool_use_id: (if phase == ToolPhase::Started {
                first_field(payload, &["id", "call_id"]).or(Some(event_id))
            } else {
                first_field(payload, &["tool_use_id", "id", "call_id"])
            })
            .map(str::to_owned),
            name: crate::providers::tool_activity::semantic_tool_name(payload),
            provider_name: field(payload, "name").map(str::to_owned),
            outcome,
            running: phase != ToolPhase::Completed
                || matches!(
                    status.as_deref(),
                    Some("running" | "started" | "in_progress")
                ),
            surface: field(payload, "surface").map(str::to_owned),
            trace_synthetic_launch: payload.get("traceSyntheticLaunch").and_then(Value::as_bool)
                == Some(true),
        }
    } else if matches!(
        event_type,
        "approval.requested" | "approval.resolved" | "permission.blocked"
    ) {
        SemanticEvent::Approval {
            phase: match event_type {
                "approval.requested" => ApprovalPhase::Requested,
                "approval.resolved" => ApprovalPhase::Resolved,
                _ => ApprovalPhase::Blocked,
            },
            approval_id: field(payload, "approvalId").map(str::to_owned),
            provider: field(payload, "provider").map(str::to_owned),
            provider_request_id: field(payload, "providerRequestId").map(str::to_owned),
            tool_use_id: first_field(payload, &["toolUseId", "tool_use_id"]).map(str::to_owned),
            resolution: first_field(payload, &["status", "resolution"]).map(str::to_owned),
        }
    } else if matches!(event_type, "agent.started" | "agent.completed") {
        SemanticEvent::Agent {
            phase: if event_type == "agent.started" {
                AgentPhase::Started
            } else {
                AgentPhase::Completed
            },
            status: field(payload, "status").map(str::to_owned),
        }
    } else if event_type == "visualization.published" {
        match (
            field(payload, "artifactId"),
            field(payload, "title"),
            field(payload, "summary"),
            field(payload, "format"),
        ) {
            (Some(id), Some(title), Some(summary), Some(format @ ("html" | "image")))
                if uuid::Uuid::parse_str(id).is_ok() =>
            {
                SemanticEvent::Visualization {
                    artifact_id: id.into(),
                    title: title.into(),
                    summary: summary.into(),
                    format: if format == "html" {
                        crate::visualizations::VisualizationFormat::Html
                    } else {
                        crate::visualizations::VisualizationFormat::Image
                    },
                    mode: (field(payload, "mode") == Some("wide"))
                        .then_some(crate::visualizations::VisualizationMode::Wide),
                }
            }
            _ => SemanticEvent::Unknown {
                reason: UnknownReason::InvalidPayload,
            },
        }
    } else if let Some(name) = lifecycle_name(event_type) {
        SemanticEvent::Lifecycle { name }
    } else if matches!(event_type, "multitask.launched" | "multitask.finished") {
        SemanticEvent::Multitask {
            phase: if event_type == "multitask.launched" {
                MultitaskPhase::Launched
            } else {
                MultitaskPhase::Finished
            },
            child_session_id: field(payload, "childSessionId").map(str::to_owned),
            state: field(payload, "state").map(str::to_owned),
            task_label: field(payload, "taskLabel").map(str::to_owned),
            prompt: field(payload, "prompt").map(str::to_owned),
            worktree: payload.get("worktree").and_then(Value::as_bool) == Some(true),
            answer: field(payload, "answer").map(str::to_owned),
        }
    } else if event_type == "error" {
        SemanticEvent::Error {
            code: field(payload, "code").map(str::to_owned),
            operation: field(payload, "operation").map(str::to_owned),
        }
    } else {
        SemanticEvent::Unknown {
            reason: UnknownReason::UnsupportedType,
        }
    };
    TimelineSemantics {
        version: 1,
        context,
        event,
    }
}

#[cfg(test)]
mod tests {
    use super::{derive, SemanticEvent, ToolOutcome};
    use serde_json::{json, Value};

    #[test]
    fn tools_correlate_across_provider_payloads_and_keep_cancelled_distinct() {
        let claude = derive(
            "command.completed",
            "result-1",
            &json!({"tool_use_id":"toolu_1", "id":"different", "name":"Bash", "is_error":true}),
        );
        let codex = derive(
            "command.started",
            "start-1",
            &json!({"id":"item-1", "server":"argmax", "tool":"session_list", "name":"item.tool"}),
        );
        let cursor = derive(
            "command.started",
            "start-2",
            &json!({"call_id":"call-1", "name":"other", "input":{"_toolName":"taskToolCall"}}),
        );
        let cancelled = derive(
            "command.completed",
            "end-2",
            &json!({"call_id":"call-1", "status":"interrupted", "is_error":true}),
        );
        assert!(
            matches!(claude.event, SemanticEvent::Tool { tool_use_id: Some(ref id), outcome: Some(ToolOutcome::Failed), .. } if id == "toolu_1")
        );
        assert!(
            matches!(codex.event, SemanticEvent::Tool { name, .. } if name == "mcp__argmax__session_list")
        );
        assert!(matches!(cursor.event, SemanticEvent::Tool { name, .. } if name == "taskToolCall"));
        assert!(matches!(
            cancelled.event,
            SemanticEvent::Tool {
                outcome: Some(ToolOutcome::Cancelled),
                ..
            }
        ));
    }

    #[test]
    fn messages_identify_child_threads_and_reject_malformed_rows() {
        let child = derive(
            "message.delta",
            "m1",
            &json!({"item_type":"agent_message", "sender_thread_id":"thread-child"}),
        );
        assert_eq!(
            child.context.provider_thread_id.as_deref(),
            Some("thread-child")
        );
        let malformed = derive("message.completed", "m2", &json!(null));
        assert!(matches!(malformed.event, SemanticEvent::Unknown { .. }));
    }

    #[test]
    fn shared_client_fixtures_match_the_host_contract() {
        let rows: Value = serde_json::from_str(include_str!(
            "../../../src/shared/timelineSemanticFixtures.json"
        ))
        .expect("shared semantic fixtures");
        for row in rows.as_array().expect("fixture rows") {
            let event_type = row["type"].as_str().expect("event type");
            let id = row["id"].as_str().expect("event id");
            let actual = serde_json::to_value(derive(event_type, id, &row["payload"]))
                .expect("serialize semantics");
            assert_eq!(actual, row["semantic"], "semantic fixture {id}");
        }
    }
}
