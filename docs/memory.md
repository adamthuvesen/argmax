# Project Learnings

Argmax stores project-scoped learnings in SQLite so they can be reviewed and reused across sessions.

- [src-tauri/src/persistence/learnings.rs](../src-tauri/src/persistence/learnings.rs) owns reads/writes and FTS-backed search.
- `learnings:list`, `learnings:update`, and `learnings:delete` expose the UI surface.

Write durable repo behavior into docs/skills; use learnings for project-local facts discovered by sessions.
