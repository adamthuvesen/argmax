use super::{store::VisualizationStore, VisualizationArtifact, VisualizationMode};
use crate::providers::flush_queue::DashboardDelta;
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        events::{persist_timeline_event_if_absent, PersistTimelineEventInput},
        sessions::find_session_by_id,
        workspaces::find_workspace_by_id,
        Database,
    },
    state::AppState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Type, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualizationSource {
    /// HTML source, at most 1 MB. Provide exactly one of html or path.
    pub html: Option<String>,
    /// Absolute HTML or PNG/JPEG/GIF/WebP file in the owning checkout or visualization folder.
    pub path: Option<String>,
    pub title: Option<String>,
    pub summary: Option<String>,
    /// Optional wide presentation.
    pub mode: Option<VisualizationMode>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    #[serde(skip)]
    #[specta(skip)]
    #[schemars(skip)]
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VisualizationPreviewResult {
    pub draft_id: String,
    pub artifact: VisualizationArtifact,
    pub width: u32,
    pub height: u32,
    pub content_height: Option<f64>,
    pub diagnostics: Vec<String>,
    pub screenshot_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub png_base64: Option<String>,
}

pub fn store(state: &AppState) -> ArgmaxResult<VisualizationStore> {
    let dir = state.app_data_dir.get().ok_or_else(|| {
        ArgmaxError::service(
            "VISUALIZATION_NOT_READY",
            "Visualization storage is not initialized",
        )
    })?;
    Ok(VisualizationStore::from_data_dir(&dir.join("local-state")))
}

pub async fn ingest(
    state: &AppState,
    session: &str,
    input: VisualizationSource,
    stable: bool,
) -> ArgmaxResult<VisualizationArtifact> {
    let db = crate::ipc::live_database(state)?;
    let roots = allowed_roots(&db, session, state)?;
    let reference_id = input
        .source_event_id
        .as_deref()
        .map(|id| canonical_reference_id(&db.read_connection(), session, id))
        .transpose()?;
    let store = store(state)?;
    let session = session.to_string();
    crate::ipc::read_off_main(move || {
        store.ingest(
            &session,
            input.html.as_deref(),
            input.path.as_deref().map(Path::new),
            &roots,
            input.title,
            input.summary,
            input.mode,
            stable,
            reference_id.as_deref(),
        )
    })
    .await
}

fn canonical_reference_id(
    connection: &rusqlite::Connection,
    session: &str,
    event_id: &str,
) -> ArgmaxResult<String> {
    use rusqlite::OptionalExtension;
    let source_row: Option<i64> = connection
        .query_row(
            "SELECT rowid FROM events WHERE session_id = ?1 AND id = ?2",
            [session, event_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(crate::persistence::sqlite_error)?;
    let source_row = source_row.ok_or_else(|| {
        ArgmaxError::service(
            "VISUALIZATION_INVALID",
            "Visualization source event does not belong to this chat",
        )
    })?;
    let origin: Option<(String, String)> = connection.query_row(
        "SELECT id, payload_json FROM events WHERE session_id = ?1 AND rowid <= ?2 AND type = 'user.message' AND COALESCE(json_extract(payload_json, '$.delivery'), '') <> 'steer' AND json_extract(payload_json, '$.parent_tool_use_id') IS NULL ORDER BY rowid DESC LIMIT 1",
        rusqlite::params![session, source_row], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(crate::persistence::sqlite_error)?;
    let (id, payload) = match origin {
        Some(origin) => origin,
        None => connection.query_row(
            "SELECT id, payload_json FROM events WHERE session_id = ?1 AND rowid <= ?2 ORDER BY rowid ASC LIMIT 1",
            rusqlite::params![session, source_row], |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(crate::persistence::sqlite_error)?,
    };
    let payload: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| ArgmaxError::service("VISUALIZATION_INVALID", error.to_string()))?;
    Ok(payload
        .get("_argmaxOriginalEventId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(&id)
        .to_owned())
}

fn allowed_roots(
    db: &Arc<Database>,
    session: &str,
    state: &AppState,
) -> ArgmaxResult<Vec<PathBuf>> {
    let conn = db.read_connection();
    let session = find_session_by_id(&conn, session)?;
    let workspace = find_workspace_by_id(&conn, &session.workspace_id)?;
    let data = state.app_data_dir.get().ok_or_else(|| {
        ArgmaxError::service(
            "VISUALIZATION_NOT_READY",
            "Visualization storage is not initialized",
        )
    })?;
    Ok(vec![
        PathBuf::from(workspace.path),
        crate::sync::home_dir().join(".argmax/visualizations"),
        data.join("local-state/attachments").join(&session.id),
    ])
}

pub async fn preview(
    state: &AppState,
    app: Option<&tauri::AppHandle>,
    session: &str,
    input: VisualizationSource,
) -> ArgmaxResult<VisualizationPreviewResult> {
    let width = input.width.unwrap_or(728);
    let height = input.height.unwrap_or(480);
    if !(240..=1600).contains(&width) || !(80..=2000).contains(&height) {
        return Err(ArgmaxError::service(
            "VISUALIZATION_INVALID",
            "Preview width must be 240–1600 and height 80–2000",
        ));
    }
    let artifact = ingest(state, session, input, false).await?;
    let store = store(state)?;
    let owner = session.to_string();
    let id = artifact.id.clone();
    let read = crate::ipc::read_off_main(move || store.read(&owner, &id)).await?;
    let mut result = VisualizationPreviewResult {
        draft_id: artifact.id.clone(),
        artifact,
        width,
        height,
        content_height: None,
        diagnostics: Vec::new(),
        screenshot_path: None,
        png_base64: None,
    };
    match app {
        Some(app) => match super::preview::capture(app, &read.document, width, height).await {
            Ok(capture) => {
                result.width = capture.width;
                result.height = capture.height;
                result.content_height = Some(capture.content_height);
                result.diagnostics = capture.diagnostics;
                if let Some(attachments) = state.attachments.get() {
                    let session_id =
                        crate::ipc::validation::SessionId::try_from(session.to_string())
                            .map_err(ArgmaxError::invalid)?;
                    match attachments.save_bytes(
                        &session_id,
                        crate::ipc::validation::AttachmentMimeType::ImagePng,
                        &capture.png,
                    ) {
                        Ok(saved) => result.screenshot_path = Some(saved.file_path),
                        Err(error) => result
                            .diagnostics
                            .push(format!("Could not save preview screenshot: {error}")),
                    }
                }
                let png = STANDARD.encode(capture.png);
                if png.len() <= 900_000 {
                    result.png_base64 = Some(png)
                } else {
                    result.diagnostics.push(
                        "Preview image exceeds tool image limit. Inspect screenshotPath.".into(),
                    )
                }
            }
            Err(error) => result.diagnostics.push(format!(
                "Preview unavailable: {error}. The saved draft can still be published."
            )),
        },
        None => result.diagnostics.push(
            "Preview unavailable in this instance. The saved draft can still be published.".into(),
        ),
    }
    Ok(result)
}

pub async fn publish(
    state: &AppState,
    session: &str,
    id: &str,
) -> ArgmaxResult<VisualizationArtifact> {
    let db = crate::ipc::live_database(state)?;
    find_session_by_id(&db.read_connection(), session)?;
    let store = store(state)?;
    let owner = session.to_string();
    let artifact_id = id.to_string();
    let artifact = crate::ipc::read_off_main(move || store.artifact(&owner, &artifact_id)).await?;
    let event = {
        let conn = db.connection();
        let published:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM events WHERE session_id=?1 AND type='visualization.published' AND json_extract(payload_json,'$.artifactId')=?2)",(session,id),|row|row.get(0)).map_err(crate::persistence::sqlite_error)?;
        if published {
            None
        } else {
            persist_timeline_event_if_absent(
                &conn,
                &PersistTimelineEventInput {
                    id: format!("visualization:{session}:{id}"),
                    session_id: session.into(),
                    r#type: "visualization.published".into(),
                    message: artifact.summary.clone(),
                    payload: json!({"artifactId":artifact.id,"title":artifact.title,"summary":artifact.summary,"format":artifact.format,"mode":artifact.mode}),
                    created_at: None,
                },
            )?
        }
    };
    if let (Some(event), Some(providers)) = (event, state.providers.get()) {
        providers.publish(DashboardDelta {
            events: vec![event],
            ..DashboardDelta::default()
        });
    }
    Ok(artifact)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{
        projects::{persist_project, PersistProjectInput, ProjectSettings},
        sessions::{persist_session, PersistSessionInput},
        workspaces::{persist_workspace, PersistWorkspaceInput},
    };
    use crate::sessions::state::SessionState;
    fn state(root: &Path) -> AppState {
        let state = AppState::new();
        state.app_data_dir.set(root.to_path_buf()).unwrap();
        let db = Arc::new(Database::open_in_memory().unwrap());
        {
            let conn = db.connection();
            persist_project(
                &conn,
                &PersistProjectInput {
                    id: "p".into(),
                    name: "p".into(),
                    repo_path: root.to_string_lossy().into_owned(),
                    current_branch: "main".into(),
                    default_branch: Some("main".into()),
                    settings: ProjectSettings {
                        merge_cleanup: Default::default(),
                        worktree_location: "~/.argmax/worktrees".into(),
                        setup_command: String::new(),
                        check_commands: Vec::new(),
                    },
                },
            )
            .unwrap();
            persist_workspace(
                &conn,
                &PersistWorkspaceInput {
                    id: "w".into(),
                    project_id: "p".into(),
                    task_label: "chat".into(),
                    branch: "main".into(),
                    base_ref: "main".into(),
                    path: root.to_string_lossy().into_owned(),
                    state: "running".into(),
                    shared_workspace: true,
                    kind: "git".into(),
                    dirty: false,
                    changed_files: 0,
                },
            )
            .unwrap();
            persist_session(
                &conn,
                &PersistSessionInput {
                    id: "s".into(),
                    workspace_id: "w".into(),
                    provider: "codex".into(),
                    model_label: "model".into(),
                    model_id: "model".into(),
                    reasoning_effort: None,
                    permission_mode: None,
                    agent_mode: None,
                    prompt: "hello".into(),
                    state: SessionState::Running,
                },
            )
            .unwrap();
        }
        state.db.set(db).ok().unwrap();
        state
    }
    #[tokio::test]
    async fn preview_failure_keeps_publishable_draft_and_publication_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let preview = preview(
            &state,
            None,
            "s",
            VisualizationSource {
                html: Some("<p>durable</p>".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(preview.content_height.is_none());
        assert!(!preview.diagnostics.is_empty());
        publish(&state, "s", &preview.draft_id).await.unwrap();
        publish(&state, "s", &preview.draft_id).await.unwrap();
        let db = state.db.get().unwrap();
        let count:i64=db.read_connection().query_row("SELECT COUNT(*) FROM events WHERE session_id='s' AND type='visualization.published'",[],|row|row.get(0)).unwrap();
        assert_eq!(count, 1);
        let events = crate::persistence::events::list_session_events_since(
            &db.read_connection(),
            "s",
            None,
            None,
        )
        .unwrap();
        let event = events
            .events
            .iter()
            .find(|event| event.r#type == "visualization.published")
            .unwrap();
        assert!(
            matches!(&event.semantic.event,crate::persistence::timeline_semantics::SemanticEvent::Visualization{artifact_id,..} if artifact_id==&preview.draft_id)
        );
        assert!(publish(&state, "missing", &preview.draft_id).await.is_err());
    }
    #[tokio::test]
    async fn legacy_import_uses_saved_snapshot_after_original_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let path = dir.path().join("legacy.html");
        std::fs::write(&path, "<p>legacy</p>").unwrap();
        let source = VisualizationSource {
            path: Some(path.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let first = ingest(&state, "s", source.clone(), true).await.unwrap();
        std::fs::remove_file(&path).unwrap();
        let next = ingest(&state, "s", source, true).await.unwrap();
        assert_eq!(first.id, next.id);
        let count: i64 = state
            .db
            .get()
            .unwrap()
            .read_connection()
            .query_row(
                "SELECT COUNT(*) FROM events WHERE type='visualization.published'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    #[tokio::test]
    async fn legacy_identity_survives_cross_client_and_two_history_copies() {
        use crate::persistence::events::{persist_copied_event, persist_timeline_event};
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        let db = state.db.get().unwrap();
        {
            let conn = db.connection();
            for id in ["child", "grandchild"] {
                persist_session(
                    &conn,
                    &PersistSessionInput {
                        id: id.into(),
                        workspace_id: "w".into(),
                        provider: "codex".into(),
                        model_label: "model".into(),
                        model_id: "model".into(),
                        reasoning_effort: None,
                        permission_mode: None,
                        agent_mode: None,
                        prompt: "hello".into(),
                        state: SessionState::Complete,
                    },
                )
                .unwrap();
            }
            let user = PersistTimelineEventInput {
                id: "u1".into(),
                session_id: "s".into(),
                r#type: "user.message".into(),
                message: "hello".into(),
                payload: json!({}),
                created_at: Some("2026-10-07T10:00:00Z".into()),
            };
            persist_timeline_event(&conn, &user).unwrap();
            for id in ["desktop", "phone"] {
                persist_timeline_event(
                    &conn,
                    &PersistTimelineEventInput {
                        id: id.into(),
                        r#type: "message.completed".into(),
                        ..user.clone()
                    },
                )
                .unwrap();
            }
            let child = PersistTimelineEventInput {
                id: "child-user".into(),
                session_id: "child".into(),
                ..user.clone()
            };
            let copied = persist_copied_event(&conn, &child, "u1").unwrap();
            persist_copied_event(
                &conn,
                &PersistTimelineEventInput {
                    id: "grand-user".into(),
                    session_id: "grandchild".into(),
                    payload: copied.payload,
                    ..child
                },
                "child-user",
            )
            .unwrap();
            persist_timeline_event(
                &conn,
                &PersistTimelineEventInput {
                    id: "u2".into(),
                    ..user
                },
            )
            .unwrap();
        }
        let path = dir.path().join("shared.html");
        std::fs::write(&path, "<p>saved</p>").unwrap();
        let source = VisualizationSource {
            path: Some(path.to_string_lossy().into_owned()),
            source_event_id: Some("desktop".into()),
            ..Default::default()
        };
        let first = ingest(&state, "s", source.clone(), true).await.unwrap();
        store(&state)
            .unwrap()
            .set_state(
                "s",
                &first.id,
                super::super::VisualizationWidgetState {
                    model_content: json!({"selection": 7}),
                    private_content: json!("private"),
                },
            )
            .unwrap();
        std::fs::remove_file(&path).unwrap();
        let phone = ingest(
            &state,
            "s",
            VisualizationSource {
                source_event_id: Some("phone".into()),
                ..source.clone()
            },
            true,
        )
        .await
        .unwrap();
        assert_eq!(phone.id, first.id);
        for (session, event) in [("child", "child-user"), ("grandchild", "grand-user")] {
            store(&state).unwrap().clone_session("s", session).unwrap();
            let copied = ingest(
                &state,
                session,
                VisualizationSource {
                    source_event_id: Some(event.into()),
                    ..source.clone()
                },
                true,
            )
            .await
            .unwrap();
            assert_eq!(copied.id, first.id);
            assert_eq!(
                store(&state)
                    .unwrap()
                    .read(session, &copied.id)
                    .unwrap()
                    .state
                    .model_content,
                json!({"selection": 7})
            );
        }
        assert!(ingest(
            &state,
            "s",
            VisualizationSource {
                source_event_id: Some("child-user".into()),
                ..source.clone()
            },
            true
        )
        .await
        .is_err());
        std::fs::write(&path, "<p>new answer</p>").unwrap();
        let next = ingest(
            &state,
            "s",
            VisualizationSource {
                source_event_id: Some("u2".into()),
                ..source
            },
            true,
        )
        .await
        .unwrap();
        assert_ne!(next.id, first.id);
    }
    #[tokio::test]
    async fn empty_summary_cannot_publish_an_invisible_card() {
        let dir = tempfile::tempdir().unwrap();
        let state = state(dir.path());
        assert!(preview(
            &state,
            None,
            "s",
            VisualizationSource {
                html: Some("<p>chart</p>".into()),
                summary: Some(" ".into()),
                ..Default::default()
            }
        )
        .await
        .is_err());
    }
}
