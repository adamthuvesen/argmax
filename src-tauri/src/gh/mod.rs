// Section 8 of the rust port — GhService + GhPoller subsystem.
//
// `service.rs` is Stage 1 (live `gh pr view` + persist).
// `poller.rs` is Stage 2 (interval refresh + state-transition delta).
// See `src/main/gh/ghService.ts` and `src/main/gh/ghPoller.ts` for the
// TS originals that drive the design.

pub mod poller;
pub mod service;
