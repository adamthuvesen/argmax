# Project Learnings

Argmax stores project-scoped learnings in SQLite for review across sessions.

- [src-tauri/src/persistence/learnings.rs](../src-tauri/src/persistence/learnings.rs): Persistence and FTS5 full-text search.
- IPC channels: `learnings:list`, `learnings:update`, `learnings:delete`.

Use docs or skills for persistent repository instructions; use learnings for project-specific facts discovered during agent execution.
