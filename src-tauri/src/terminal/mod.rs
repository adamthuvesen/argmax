// Section 8 of the rust port — integrated terminal panel subsystem.
//
// Owns user-spawned PTYs that back the renderer's integrated terminal
// (⌘J). Mirrors `src/main/terminal/terminalService.ts`. See
// `agents/docs/terminal.md` for the runtime expectations.

pub mod service;
