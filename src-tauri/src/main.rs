// Argmax — Rust/Tauri entrypoint.
//
// The lib crate holds the actual app construction so that tests under
// `src-tauri/tests/` can drive the same builder without spawning a window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    argmax_lib::run();
}
