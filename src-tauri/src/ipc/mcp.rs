use super::inputs::*;
use crate::mcp::registry::{list_mcp_servers, McpClientListing};
use crate::{
    error::{ArgmaxError, ArgmaxResult},
    ipc::system::SystemOk,
    mcp::auth::{McpAuthService, StartAuthInput as ServiceStartAuthInput, StartAuthOutput},
    state::AppState,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[tauri::command(rename = "mcp:list")]
#[specta::specta]
pub async fn mcp_list(_input: McpListInput) -> Vec<McpClientListing> {
    list_mcp_servers(None).await
}

#[tauri::command(rename = "mcp:auth:start")]
#[specta::specta]
pub async fn mcp_auth_start(
    app: AppHandle,
    state: State<'_, AppState>,
    input: McpAuthStartInput,
) -> ArgmaxResult<StartAuthOutput> {
    let app_handle = app.clone();
    let on_output = Arc::new(move |chunk| {
        if let Err(error) = app_handle.emit("mcp:auth:data", chunk) {
            tracing::warn!(?error, "failed to emit mcp auth data");
        }
    });
    let on_exit = Arc::new(move |info| {
        if let Err(error) = app.emit("mcp:auth:exit", info) {
            tracing::warn!(?error, "failed to emit mcp auth exit");
        }
    });

    live_mcp_auth(&state)?
        .start(
            ServiceStartAuthInput {
                cols: input.cols.get(),
                rows: input.rows.get(),
            },
            on_output,
            on_exit,
        )
        .await
}

#[tauri::command(rename = "mcp:auth:write")]
#[specta::specta]
pub fn mcp_auth_write(
    state: State<'_, AppState>,
    input: McpAuthWriteInput,
) -> ArgmaxResult<SystemOk> {
    live_mcp_auth(&state)?.write(input.session_id.as_str(), input.data.as_str().as_bytes());
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "mcp:auth:resize")]
#[specta::specta]
pub fn mcp_auth_resize(
    state: State<'_, AppState>,
    input: McpAuthResizeInput,
) -> ArgmaxResult<SystemOk> {
    live_mcp_auth(&state)?.resize(
        input.session_id.as_str(),
        input.cols.get(),
        input.rows.get(),
    );
    Ok(SystemOk { ok: true })
}

#[tauri::command(rename = "mcp:auth:terminate")]
#[specta::specta]
pub async fn mcp_auth_terminate(
    state: State<'_, AppState>,
    input: McpAuthTerminateInput,
) -> ArgmaxResult<SystemOk> {
    live_mcp_auth(&state)?
        .terminate(input.session_id.as_str())
        .await;
    Ok(SystemOk { ok: true })
}

fn live_mcp_auth(state: &AppState) -> ArgmaxResult<Arc<McpAuthService>> {
    state.mcp_auth.get().cloned().ok_or_else(|| {
        ArgmaxError::service(
            "MCP_AUTH_SERVICE_NOT_READY",
            "MCP auth service is not initialized",
        )
    })
}
