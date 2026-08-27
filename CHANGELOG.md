# Changelog

Notable changes to Argmax. There are no git tags yet, so each section lists
the changes made while `package.json` carried that version, and the date
marks the commit that set it. "Unreleased" covers work not yet on `main`.

## Unreleased

### Changed

- Provider catalog: Claude default is Opus 5; Codex offers GPT-5.6 Sol/Terra/Luna
  (default Sol · Medium); Cursor offers Grok 4.6, Gemini 3.7 Flash, the GPT-5.6
  family, and Opus 5 Thinking (replacing GPT-5.5 / Opus 4.8 / Gemini 3.5).
- Launcher and Settings default to GPT-5.6 Sol at Medium effort.

### Fixed

- Cursor usage is priced from the launched model instead of falling through
  to `cursor-unknown`.
- Startup watcher restore skips a missing checkout instead of first claiming
  recursive watches are unavailable.
- Follow-ups show the agent starting work right away instead of leaving the
  chat blank for the seconds a provider takes to resume: the chat treats a send
  from the composer or a card as the start of a turn rather than waiting for the
  session state flip, and a new turn no longer inherits the previous gap's
  Thinking delay.
- In dev and test builds, one session's panic no longer takes down parallel
  sessions: shared runtime mutexes recover from poisoning instead of
  cascading panics, with a containment test. Release builds compile with
  `panic = "abort"`, where any panic still ends the whole process.

## 0.3.0 — 2026-07-03

### Added

- Subagent activity: side pane and tabbed panes with codenames for agents a
  session spawns (#63, #64).
- Composer effort slider, context-window usage ring, and model picker polish
  (#60).
- Animated pixel field in the new-session composer.

### Changed

- Simplified runtime, IPC, and settings after the architecture refactor (#65).
- Stripped the reasoning-effort control out of the model picker; effort lives
  in the composer (#62).
- Settings and diagnostics pages polished; purple theme removed in favor of
  the accent tint.
- Routine dependency refresh across cargo and npm lockfiles (#61).

### Fixed

- Codex sessions load the user's Codex config (#66).
- Launcher context sizing is responsive.
- File tree preserves scroll position; tail thinking indicator no longer
  flashes early.

## 0.2.0 — 2026-05-29

### Added

- Ported the whole runtime from Electron/Node to Rust + Tauri: SQLite via
  `rusqlite`, PTYs via `portable-pty`, IPC via `tauri-specta` bindings (#3).
- Per-launch Worktree toggle: run in the current checkout or an isolated
  worktree (#12).
- Generated session titles (#52) and a flat date-grouped session view in the
  sidebar (#10).
- Sidebar status/PR markers and a session cap (#53).
- Configurable accent tint (#38).
- Provider setup detection and chat UI polish (#5).
- Gemini 3.5 Flash as a Cursor model; Codex default moved to GPT-5.5.
- CI hardening: job timeouts, bundle gate, dependency audit, coverage report
  (#19), parallelized required checks (#50).

### Changed

- Split provider and renderer responsibilities (#34) and the session
  conversation surface (#49).
- Friendlier out-of-box defaults for font, model, launcher, and chat detail
  (#15).
- Frontend toolchain upgraded to Vite 8 / Vitest 3 (#40).
- Launcher defaults to the live checked-out branch, default branch pinned
  atop the picker.

### Fixed

- Login-shell environment hydration for packaged-app launches.
- Chat scroll, streaming answer placement, thinking-state, and layout fixes
  across the transcript and sidebar (#11, #35, #45, #46, #51, #58).
- Env-secret filtering generalized for checks; `argmax-asset` scheme
  registered (#17).
- Refresh/send error handling made loud instead of silent (#18).

## 0.1.0 — 2026-05-08

### Added

- Initial local command center: provider sessions for Claude Code, Codex, and
  Cursor with persistent transcripts, review tools, checks, and approvals.
- Dashboard deltas streamed to the renderer over SQLite-backed cursors.
- Model picker, session switching, conversation resume, slash-command
  discovery for Claude and Codex.
- Tool-call timeline, project folder picker, launcher pickers, and the first
  Electron-based packaging (later replaced by Tauri in 0.2.0).
- Renamed the app from Maestro to Argmax.
