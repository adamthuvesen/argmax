use super::inputs::QuestionsResolveInput;
use crate::error::{ArgmaxError, ArgmaxResult};
use crate::questions::service::{QuestionResolveResult, QuestionService};
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command(rename = "questions:resolve")]
#[specta::specta]
pub async fn questions_resolve(
    state: State<'_, AppState>,
    input: QuestionsResolveInput,
) -> ArgmaxResult<QuestionResolveResult> {
    questions_resolve_impl(&state, input).await
}

pub(crate) async fn questions_resolve_impl(
    state: &AppState,
    input: QuestionsResolveInput,
) -> ArgmaxResult<QuestionResolveResult> {
    // `resolve` takes the pending-question lock and runs a SQLite
    // transaction, which can block on writer contention; keep it off the
    // async runtime's workers, the way `workspaces:mark-viewed` does.
    let questions = live_questions(state)?;
    tauri::async_runtime::spawn_blocking(move || {
        questions.resolve(
            input.session_id.as_str(),
            input.request_id.as_str(),
            input.answers,
            input.dismissed,
        )
    })
    .await
    .map_err(|error| ArgmaxError::service("QUESTION_RESOLVE_FAILED", error.to_string()))?
}

fn live_questions(state: &AppState) -> ArgmaxResult<Arc<QuestionService>> {
    state.questions.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "QUESTION_SERVICE_NOT_READY",
            "question service is not initialized",
        )
    })
}
