// Serves on-disk image bytes referenced from rendered workspace files (e.g.
// relative `<img src>` in a previewed README.md) over the `argmax-asset://`
// scheme. The path-validation + bytes-fetching logic lives in
// `protocol::serve_workspace_asset` as a pure function; the Tauri protocol
// hook is wired in `lib.rs::run`.

pub mod protocol;
