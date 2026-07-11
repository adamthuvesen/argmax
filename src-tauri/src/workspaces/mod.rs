// Workspace orchestration + fs watcher.
//
// `orchestration.rs` owns lifecycle (create_isolated, create_current,
// keep, archive, refresh_status, open_in_ide, set_pinned). `watcher.rs`
// owns the per-workspace `notify::RecommendedWatcher` + 200 ms
// trailing-edge debouncer that fires `refresh_status` and publishes a
// `dashboard:delta` carrying the updated `WorkspaceSummary`.

use serde::{Deserialize, Serialize};
use specta::Type;

pub mod orchestration;
pub mod watcher;

pub use orchestration::{WorkspaceService, WorkspaceServiceError};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceTargetKind {
    Workspace,
    Project,
}
