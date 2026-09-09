// Cross-cutting helpers that don't belong to any single subsystem.

pub mod app_nap;
pub mod data_dir;
pub mod gh_runner;
pub mod instance_lock;
pub mod ipc_latency;
pub mod keep_awake;
pub mod log_buffer;
pub mod login_shell;
pub mod process_control;
pub mod protocol_url;
pub mod startup_timer;
pub mod stream_reader;
pub mod sync;
pub mod tracing_init;
pub mod workspace_paths;

// Temporary CI measurement probe, removed after testing a source-changing
// cache restore. Its result also confirms that the new test binary was run.
#[test]
fn ci_source_rebuild_probe() {
    assert_eq!(std::hint::black_box(21) * 2, 42);
}
