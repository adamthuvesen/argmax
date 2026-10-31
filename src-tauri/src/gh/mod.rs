// GitHub PR status subsystem: `service.rs` performs live `gh pr view` reads
// and persistence; `poller.rs` refreshes open PR rows and publishes deltas.

pub(crate) use argmax_store::workspaces::workspaces_for_pr_refresh;
pub mod poller;
pub mod service;
pub mod watch;
