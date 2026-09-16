use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{live_database, publish_dashboard_changed, read_off_main, validation::NonEmptyString};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    persistence::{
        arc_events::{list_arc_timeline, ArcTimelineCursor, ArcTimelinePage},
        arcs::{self, ArcCreateInput, ArcDetail, ArcRecord, ArcState, ArcUpdateInput},
        events::goal_transcript_tail,
        sessions::find_session_by_id,
    },
    providers::{ProviderId, ReasoningEffort},
    state::AppState,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcListInput {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcGetInput {
    pub id: NonEmptyString,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcUpdateFieldsInput {
    pub id: NonEmptyString,
    pub name: Option<String>,
    pub brief: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcSetStateInput {
    pub id: NonEmptyString,
    pub state: ArcState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcLaunchCoordinatorInput {
    pub arc_id: NonEmptyString,
    pub provider: ProviderId,
    /// Both default to that provider's own default model when omitted.
    pub model_label: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
}

#[tauri::command(rename = "arc:create")]
#[specta::specta]
pub async fn arc_create(
    state: State<'_, AppState>,
    input: ArcCreateInput,
) -> ArgmaxResult<ArcRecord> {
    arc_create_impl(&state, input).await
}

pub(crate) async fn arc_create_impl(
    state: &AppState,
    input: ArcCreateInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let app_data_dir = state.require_app_data_dir()?.to_path_buf();
    let created =
        read_off_main(move || arcs::create_arc(&database.connection(), &app_data_dir, &input))
            .await?;
    publish_dashboard_changed(state);
    Ok(created)
}

#[tauri::command(rename = "arc:list")]
#[specta::specta]
pub async fn arc_list(
    state: State<'_, AppState>,
    input: ArcListInput,
) -> ArgmaxResult<Vec<ArcRecord>> {
    arc_list_impl(&state, input).await
}

pub(crate) async fn arc_list_impl(
    state: &AppState,
    _input: ArcListInput,
) -> ArgmaxResult<Vec<ArcRecord>> {
    let database = live_database(state)?;
    read_off_main(move || arcs::list_arcs(&database.read_connection())).await
}

#[tauri::command(rename = "arc:get")]
#[specta::specta]
pub async fn arc_get(state: State<'_, AppState>, input: ArcGetInput) -> ArgmaxResult<ArcDetail> {
    arc_get_impl(&state, input).await
}

pub(crate) async fn arc_get_impl(state: &AppState, input: ArcGetInput) -> ArgmaxResult<ArcDetail> {
    let database = live_database(state)?;
    read_off_main(move || arcs::get_arc_detail(&database.read_connection(), input.id.as_str()))
        .await
}

#[tauri::command(rename = "arc:update")]
#[specta::specta]
pub async fn arc_update(
    state: State<'_, AppState>,
    input: ArcUpdateFieldsInput,
) -> ArgmaxResult<ArcRecord> {
    arc_update_impl(&state, input).await
}

pub(crate) async fn arc_update_impl(
    state: &AppState,
    input: ArcUpdateFieldsInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let updated = read_off_main(move || {
        arcs::update_arc(
            &database.connection(),
            input.id.as_str(),
            &ArcUpdateInput {
                name: input.name,
                brief: input.brief,
            },
        )
    })
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}

#[tauri::command(rename = "arc:set-state")]
#[specta::specta]
pub async fn arc_set_state(
    state: State<'_, AppState>,
    input: ArcSetStateInput,
) -> ArgmaxResult<ArcRecord> {
    arc_set_state_impl(&state, input).await
}

pub(crate) async fn arc_set_state_impl(
    state: &AppState,
    input: ArcSetStateInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let updated = read_off_main(move || {
        arcs::set_arc_state(&database.connection(), input.id.as_str(), input.state)
    })
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}

#[tauri::command(rename = "arc:launch-coordinator")]
#[specta::specta]
pub async fn arc_launch_coordinator(
    state: State<'_, AppState>,
    input: ArcLaunchCoordinatorInput,
) -> ArgmaxResult<ArcRecord> {
    arc_launch_coordinator_impl(&state, input).await
}

pub(crate) async fn arc_launch_coordinator_impl(
    state: &AppState,
    input: ArcLaunchCoordinatorInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let workspaces = state.workspaces.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "WORKSPACE_SERVICE_NOT_READY",
            "workspace service is not initialized",
        )
    })?;
    let providers = state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })?;
    // Resolved the same way every other launch path resolves it: the user's
    // default-agent permission choice for this provider, not a hardcoded
    // fallback that ignores it.
    let app_data_dir = state.require_app_data_dir()?.to_path_buf();
    let default_agent = crate::default_agent::read_default_agent(&app_data_dir);
    let permission_mode = default_agent.permission_mode_for(input.provider);
    let updated = crate::arcs::launch_coordinator(
        crate::arcs::LaunchCoordinatorRequest {
            arc_id: input.arc_id.into_string(),
            provider: input.provider,
            model_label: input.model_label,
            model_id: input.model_id,
            reasoning_effort: input.reasoning_effort,
            permission_mode,
        },
        database,
        workspaces,
        providers,
    )
    .await?;
    publish_dashboard_changed(state);
    Ok(updated)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcTimelineInput {
    pub arc_id: NonEmptyString,
    /// The previous page's `nextCursor`, or null for the newest page.
    pub before: Option<ArcTimelineCursor>,
    pub limit: Option<i64>,
}

const TIMELINE_DEFAULT_PAGE: i64 = 60;

#[tauri::command(rename = "arc:timeline")]
#[specta::specta]
pub async fn arc_timeline(
    state: State<'_, AppState>,
    input: ArcTimelineInput,
) -> ArgmaxResult<ArcTimelinePage> {
    arc_timeline_impl(&state, input).await
}

pub(crate) async fn arc_timeline_impl(
    state: &AppState,
    input: ArcTimelineInput,
) -> ArgmaxResult<ArcTimelinePage> {
    let database = live_database(state)?;
    read_off_main(move || {
        list_arc_timeline(
            &database.read_connection(),
            input.arc_id.as_str(),
            input.before.as_ref(),
            input.limit.unwrap_or(TIMELINE_DEFAULT_PAGE),
        )
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcDraftFromSessionInput {
    pub session_id: NonEmptyString,
}

/// A drafted name and brief, or nulls when the helper call failed and the
/// person fills the form in themselves.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArcDraft {
    pub name: Option<String>,
    pub brief: Option<String>,
}

/// How much of the chat the draft reads. Enough for the goal and the
/// decisions around it without paying for the whole conversation.
const DRAFT_TRANSCRIPT_CHARS: usize = 16 * 1024;

#[tauri::command(rename = "arc:draft-from-session")]
#[specta::specta]
pub async fn arc_draft_from_session(
    state: State<'_, AppState>,
    input: ArcDraftFromSessionInput,
) -> ArgmaxResult<ArcDraft> {
    arc_draft_from_session_impl(&state, input).await
}

pub(crate) async fn arc_draft_from_session_impl(
    state: &AppState,
    input: ArcDraftFromSessionInput,
) -> ArgmaxResult<ArcDraft> {
    let database = live_database(state)?;
    let session_id = input.session_id.into_string();
    let (provider, transcript) = read_off_main(move || {
        let connection = database.read_connection();
        let session = find_session_by_id(&connection, &session_id)?;
        let tail = goal_transcript_tail(&connection, &session_id, DRAFT_TRANSCRIPT_CHARS)?;
        Ok((session.provider, tail.text))
    })
    .await?;
    let Ok(provider) = crate::providers::runtime::parse_provider(&provider) else {
        return Ok(ArcDraft {
            name: None,
            brief: None,
        });
    };
    if transcript.trim().is_empty() {
        return Ok(ArcDraft {
            name: None,
            brief: None,
        });
    }
    let draft = crate::providers::one_shot::draft_arc(
        provider,
        crate::providers::one_shot::helper_model(provider),
        &transcript,
    )
    .await;
    Ok(ArcDraft {
        name: draft.as_ref().map(|draft| draft.name.clone()),
        brief: draft.map(|draft| draft.brief),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArcPromoteInput {
    pub session_id: NonEmptyString,
    pub name: String,
    pub brief: String,
    pub dir: Option<String>,
}

#[tauri::command(rename = "arc:promote")]
#[specta::specta]
pub async fn arc_promote(
    state: State<'_, AppState>,
    input: ArcPromoteInput,
) -> ArgmaxResult<ArcRecord> {
    arc_promote_impl(&state, input).await
}

pub(crate) async fn arc_promote_impl(
    state: &AppState,
    input: ArcPromoteInput,
) -> ArgmaxResult<ArcRecord> {
    let database = live_database(state)?;
    let providers = state.providers.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "PROVIDER_SERVICE_NOT_READY",
            "provider service is not initialized",
        )
    })?;
    let app_data_dir = state.require_app_data_dir()?.to_path_buf();
    let result = crate::arcs::promote_session(
        crate::arcs::PromoteSessionRequest {
            session_id: input.session_id.into_string(),
            name: input.name,
            brief: input.brief,
            dir: input.dir,
        },
        &app_data_dir,
        database,
        providers,
    )
    .await;
    // The Arc may exist even when telling the chat failed, so the sidebar
    // refreshes either way.
    publish_dashboard_changed(state);
    result
}
