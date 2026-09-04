use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};

#[test]
fn health_ping_round_trips_through_tauri_ipc() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            argmax_lib::ipc::health::health_ping
        ])
        .build(mock_context(noop_assets()))
        .expect("build mock app");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("build mock webview");

    let response = get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "health:ping".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().expect("valid tauri url"),
            body: InvokeBody::Json(serde_json::json!({ "input": {} })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .expect("health ping succeeds")
    .deserialize::<serde_json::Value>()
    .expect("health ping response shape");

    assert_eq!(response["ok"], true);
    chrono::DateTime::parse_from_rfc3339(response["timestamp"].as_str().expect("timestamp string"))
        .expect("rfc3339 timestamp");
}
