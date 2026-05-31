// Tracing subscriber bootstrap.
//
// Called exactly once from `tauri::Builder::setup`, where the user-data
// directory is finally resolvable via `app.path().app_data_dir()`.
// Pre-setup boot code (the `mark("boot")` instant in `lib.rs::run`) runs
// before tracing is up — that's intentional, the alternative is two
// inits which `tracing::subscriber::set_global_default` does not allow.
//
// Debug builds: pretty stderr layer + IPC-latency layer.
// Release builds: JSON stderr layer + IPC-latency layer + optional JSON
// rolling-file layer under `${user_data}/logs/argmax.log` when a
// user-data directory is supplied.
//
// The TracingHandles struct owns the rolling-file `WorkerGuard`; storing
// it in the process-lifetime static `HANDLES` keeps the appender flushing
// for the lifetime of the program.

use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Layer};

use crate::util::ipc_latency::IpcLatencyRegistry;

/// Default filter when `RUST_LOG` is unset. Argmax modules at debug,
/// everything else at info.
const DEFAULT_FILTER: &str = "info,argmax_lib=debug";

pub struct TracingHandles {
    pub ipc_latency: Arc<IpcLatencyRegistry>,
    // Holds the rolling-file appender's flush guard alive. Dropping it
    // would flush pending writes and detach the worker.
    _file_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

static HANDLES: OnceLock<TracingHandles> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("tracing init called twice")]
    AlreadyInitialized,
}

/// Initializes the global tracing subscriber. Must be called exactly
/// once per process; returns `Err(AlreadyInitialized)` on subsequent
/// calls instead of panicking.
pub fn init(user_data_dir: Option<&Path>) -> Result<&'static TracingHandles, InitError> {
    if HANDLES.get().is_some() {
        return Err(InitError::AlreadyInitialized);
    }

    let handles = build_subscriber(user_data_dir);
    HANDLES
        .set(handles)
        .map_err(|_| InitError::AlreadyInitialized)?;
    Ok(HANDLES.get().expect("just set"))
}

/// Returns the global IPC latency registry. Panics if `init` has not run.
/// Commands that record latency should call this once and cache the Arc.
pub fn ipc_latency() -> Arc<IpcLatencyRegistry> {
    HANDLES
        .get()
        .expect("tracing not initialized")
        .ipc_latency
        .clone()
}

fn build_subscriber(user_data_dir: Option<&Path>) -> TracingHandles {
    let ipc_latency = Arc::new(IpcLatencyRegistry::new());
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let latency_layer = IpcLatencyLayer {
        registry: ipc_latency.clone(),
    };

    if cfg!(debug_assertions) {
        let stderr_layer = fmt::layer()
            .with_writer(std::io::stderr)
            .with_target(true)
            .pretty();
        tracing_subscriber::registry()
            .with(env_filter)
            .with(stderr_layer)
            .with(latency_layer)
            .init();
        return TracingHandles {
            ipc_latency,
            _file_guard: None,
        };
    }

    // Release: JSON stderr always; JSON file when a user_data_dir is
    // available and the log directory can be created. `Option<L: Layer<S>>`
    // itself impls `Layer<S>`, so the chain compiles whether the file
    // layer is present or not. The file layer is built inline so type
    // inference picks the correct subscriber `S` at each `.with()` call.
    let (non_blocking, file_guard): (
        Option<tracing_appender::non_blocking::NonBlocking>,
        Option<tracing_appender::non_blocking::WorkerGuard>,
    ) = match user_data_dir {
        Some(dir) => match std::fs::create_dir_all(dir.join("logs")) {
            Ok(()) => {
                let appender = tracing_appender::rolling::daily(dir.join("logs"), "argmax.log");
                let (writer, guard) = tracing_appender::non_blocking(appender);
                (Some(writer), Some(guard))
            }
            Err(e) => {
                eprintln!("argmax: rolling file log init failed: {e}");
                (None, None)
            }
        },
        None => (None, None),
    };

    let stderr_layer = fmt::layer().with_writer(std::io::stderr).json();
    let file_layer = non_blocking.map(|writer| fmt::layer().with_writer(writer).json());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .with(file_layer)
        .with(latency_layer)
        .init();

    TracingHandles {
        ipc_latency,
        _file_guard: file_guard,
    }
}

/// Tracing layer that pulls `channel` (string) + `latency_ms` (u64) fields
/// out of any event and records the pair into the IPC latency registry.
struct IpcLatencyLayer {
    registry: Arc<IpcLatencyRegistry>,
}

impl<S> Layer<S> for IpcLatencyLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = LatencyVisitor::default();
        event.record(&mut visitor);
        if let (Some(channel), Some(latency_ms)) = (visitor.channel, visitor.latency_ms) {
            self.registry
                .record(&channel, Duration::from_millis(latency_ms));
        }
    }
}

#[derive(Default)]
struct LatencyVisitor {
    channel: Option<String>,
    latency_ms: Option<u64>,
}

impl tracing::field::Visit for LatencyVisitor {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "channel" {
            self.channel = Some(value.to_owned());
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        if field.name() == "latency_ms" {
            self.latency_ms = Some(value);
        }
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        if field.name() == "latency_ms" && value >= 0 {
            self.latency_ms = Some(value as u64);
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "channel" {
            let s = format!("{value:?}");
            self.channel = Some(s.trim_matches('"').to_owned());
        }
    }
}
