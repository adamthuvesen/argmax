# Rust owns SQLite and PTYs

Argmax began with `better-sqlite3` and Node-side PTYs, and every Node or Electron upgrade turned into a native rebuild against the right ABI — a recurring tax on a single-user local app that gains nothing from it. Persistence moved to `rusqlite` (bundled-full, which ships the FTS5 used by the `events_fts` and `learnings_fts` sidecars) and process handling to `portable-pty`, so the only compiled artifact is the Tauri binary the app already builds.

The cost is that database and process work cannot be done in the renderer or in a quick Node script: it goes through a `#[tauri::command]` and across the bridge. That is deliberate. Do not reintroduce `better-sqlite3`, `node-pty`, or native builder scripts to shortcut it.
