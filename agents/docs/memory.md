# Project Learnings

Argmax stores project-scoped learnings in SQLite and injects verified facts into future provider sessions.

- [src-tauri/src/memory/extractor.rs](../../src-tauri/src/memory/extractor.rs) extracts candidates from session events.
- [src-tauri/src/memory/injector.rs](../../src-tauri/src/memory/injector.rs) composes the session-start memory preamble.
- [src-tauri/src/persistence/learnings.rs](../../src-tauri/src/persistence/learnings.rs) owns reads/writes and FTS-backed search.
- `learnings:list`, `learnings:update`, and `learnings:delete` expose the UI surface.

Write durable repo behavior into docs/skills; use learnings for project-local facts discovered by sessions.
