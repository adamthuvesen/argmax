// GitHub PR status subsystem: `service.rs` performs live `gh pr view` reads
// and persistence; `poller.rs` refreshes open PR rows and publishes deltas.

pub mod poller;
pub mod service;
