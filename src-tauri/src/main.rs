// Argmax — Rust/Tauri entrypoint.
//
// The lib crate holds the actual app construction so that tests under
// `src-tauri/tests/` can drive the same builder without spawning a window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(exit_code) =
        argmax_lib::session_control::try_run_session_launch_cli(std::env::args_os())
    {
        std::process::exit(exit_code);
    }
    argmax_lib::run();
}
