use super::session_tools::ArgmaxTools;
use crate::{
    session_control::{SessionControlAction, SessionControlResult, VisualizationPublishAction},
    visualizations::tools::VisualizationSource,
};
use rmcp::schemars;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock},
    tool, tool_router, ErrorData,
};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishParams {
    /// Immutable draft ID returned by visualization_preview.
    pub draft_id: String,
}

#[tool_router(router=visualization_tool_router,vis="pub(super)")]
impl ArgmaxTools {
    #[tool(
        name = "visualization_preview",
        description = "Save an immutable HTML or image draft and preview it in an isolated browser. Accepts html or an absolute path in this session's checkout or ~/.argmax/visualizations. Returns draftId, screenshot, layout diagnostics and external dependencies. Capture failure still returns a publishable draft. HTML is at most 1 MB. Publish that exact draft with visualization_publish."
    )]
    async fn visualization_preview(
        &self,
        Parameters(input): Parameters<VisualizationSource>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::VisualizationPreview(input)).await
    }
    #[tool(
        name = "visualization_publish",
        description = "Show a saved visualization draft inline in this chat on desktop and iOS. Pass draftId from visualization_preview. Retrying the same draft publishes one card. Source and local images survive checkout removal. The artifact belongs to this chat and is removed only when the chat is deleted."
    )]
    async fn visualization_publish(
        &self,
        Parameters(input): Parameters<PublishParams>,
    ) -> Result<CallToolResult, ErrorData> {
        call(SessionControlAction::VisualizationPublish(
            VisualizationPublishAction {
                draft_id: input.draft_id,
            },
        ))
        .await
    }
}
#[cfg(unix)]
async fn call(action: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    let response =
        tokio::task::spawn_blocking(move || crate::session_control::send_session_control(action))
            .await
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    match response {
        Ok(response) => {
            let mut blocks = match response.result {
                SessionControlResult::VisualizationPreview(mut result) => {
                    let mut blocks = Vec::new();
                    if let Some(png) = result.png_base64.take() {
                        blocks.push(ContentBlock::image(png, "image/png"));
                    }
                    blocks
                        .push(ContentBlock::text(serde_json::to_string(&result).map_err(
                            |e| ErrorData::internal_error(e.to_string(), None),
                        )?));
                    blocks
                }
                SessionControlResult::VisualizationPublished(artifact) => vec![ContentBlock::text(
                    serde_json::to_string(&artifact)
                        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?,
                )],
                other => {
                    return Err(ErrorData::internal_error(
                        format!("Unexpected visualization result: {other:?}"),
                        None,
                    ))
                }
            };
            if let Some(count) = response.unread_inbox.filter(|count| *count > 0) {
                blocks.push(ContentBlock::text(super::session_tools::inbox_notice(
                    count,
                )));
            }
            Ok(CallToolResult::success(blocks))
        }
        Err(error) => Ok(CallToolResult::error(vec![ContentBlock::text(format!(
            "{}: {}",
            error.code, error.message
        ))])),
    }
}
#[cfg(not(unix))]
async fn call(_: SessionControlAction) -> Result<CallToolResult, ErrorData> {
    Err(ErrorData::internal_error(
        "Visualization tools are unavailable on this platform",
        None,
    ))
}
