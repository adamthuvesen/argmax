//! Every integration test lives in this one binary.
//!
//! Each `tests/*.rs` file is its own crate, and each one links the whole
//! `argmax_lib` staticlib again — ten of those dominated the CI Rust lane.
//! Declaring them as modules here keeps the files (and their names) intact
//! while paying the link cost once.

mod support;

mod git_exec;
mod git_review;
mod health_smoke;
mod ipc_inventory;
mod multitask;
mod provider_real_cli;
mod provider_session;
#[cfg(unix)]
mod session_control;
mod session_sync;
mod workspace_orchestration;
