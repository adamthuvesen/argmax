use super::inputs::*;

#[tauri::command(rename = "mcp:list")]
#[specta::specta]
pub fn mcp_list(_input: McpListInput) {
    super::unported("mcp:list")
}

#[tauri::command(rename = "mcp:auth:start")]
#[specta::specta]
pub fn mcp_auth_start(_input: McpAuthStartInput) {
    super::unported("mcp:auth:start")
}

#[tauri::command(rename = "mcp:auth:write")]
#[specta::specta]
pub fn mcp_auth_write(_input: McpAuthWriteInput) {
    super::unported("mcp:auth:write")
}

#[tauri::command(rename = "mcp:auth:resize")]
#[specta::specta]
pub fn mcp_auth_resize(_input: McpAuthResizeInput) {
    super::unported("mcp:auth:resize")
}

#[tauri::command(rename = "mcp:auth:terminate")]
#[specta::specta]
pub fn mcp_auth_terminate(_input: McpAuthTerminateInput) {
    super::unported("mcp:auth:terminate")
}
