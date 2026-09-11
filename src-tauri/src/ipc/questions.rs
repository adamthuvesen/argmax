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
    live_questions(state)?.resolve(
        input.session_id.as_str(),
        input.request_id.as_str(),
        input.answers,
        input.dismissed,
    )
}

fn live_questions(state: &AppState) -> ArgmaxResult<Arc<QuestionService>> {
    state.questions.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "QUESTION_SERVICE_NOT_READY",
            "question service is not initialized",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_requires_initialized_question_service() {
        let input: QuestionsResolveInput = serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "requestId": "request-1",
            "answers": {"choice": ["One"]}
        }))
        .unwrap();
        let error = tauri::async_runtime::block_on(questions_resolve_impl(&AppState::new(), input))
            .expect_err("expected missing question service error");
        assert!(
            matches!(error, ArgmaxError::ServiceError { sub_code, .. } if sub_code == "QUESTION_SERVICE_NOT_READY")
        );
    }
}
