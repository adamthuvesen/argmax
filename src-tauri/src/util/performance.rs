use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::state::AppState;
use crate::util::sync::LockOrRecover;
use chrono::Utc;
use serde::Serialize;
use specta::Type;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
const SAMPLE_CAPACITY: usize = 30 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroupMetrics {
    pub cpu_percent: f64,
    pub rss_bytes: u64,
    pub process_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTreeMetrics {
    pub total: ProcessGroupMetrics,
    pub host: ProcessGroupMetrics,
    pub webview: ProcessGroupMetrics,
    pub agents: ProcessGroupMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct RendererStallMetrics {
    pub count: u64,
    pub total_ms: f64,
    pub longest_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqlitePressureMetrics {
    pub active_readers: u64,
    pub waiting_reads: u64,
    pub wait_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceSample {
    pub captured_at: String,
    pub elapsed_ms: u64,
    pub sampler_overhead_ms: f64,
    pub processes: ProcessTreeMetrics,
    pub running_chats: u64,
    pub running_chats_by_provider: BTreeMap<String, u64>,
    pub provider_events: u64,
    pub provider_events_per_second: f64,
    pub ipc_calls: u64,
    pub ipc_calls_per_second: f64,
    pub pending_provider_items: u64,
    pub sqlite: SqlitePressureMetrics,
    pub renderer_stalls: RendererStallMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct NumericSummary {
    pub median: f64,
    pub p95: f64,
    pub peak: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCaptureSummary {
    pub cpu_percent: NumericSummary,
    pub rss_bytes: NumericSummary,
    pub cpu_percent_per_running_chat: NumericSummary,
    pub sampler_overhead_ms: NumericSummary,
    pub renderer_stall_count: u64,
    pub renderer_stall_ms: f64,
    pub sqlite_wait_count: u64,
    pub sqlite_wait_ms: f64,
    pub provider_events: u64,
    pub ipc_calls: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceEnvironment {
    pub app_version: String,
    pub platform: String,
    pub arch: String,
    pub build_profile: String,
    pub logical_cpu_count: u64,
    pub sample_interval_ms: u64,
    pub sample_capacity: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceCapture {
    pub started_at: Option<String>,
    pub stopped_at: Option<String>,
    pub recording: bool,
    pub dropped_samples: u64,
    pub environment: PerformanceEnvironment,
    pub summary: PerformanceCaptureSummary,
    pub samples: Vec<PerformanceSample>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceStatus {
    pub recording: bool,
    pub started_at: Option<String>,
    pub sample_count: u64,
    pub dropped_samples: u64,
    pub latest: Option<PerformanceSample>,
}

#[derive(Default)]
struct RecorderState {
    recording: bool,
    generation: u64,
    started_at: Option<String>,
    stopped_at: Option<String>,
    started_instant: Option<Instant>,
    dropped_samples: u64,
    samples: VecDeque<PerformanceSample>,
    pending_renderer_stalls: RendererStallMetrics,
}

#[derive(Default)]
pub struct PerformanceRecorder {
    state: Mutex<RecorderState>,
}

impl PerformanceRecorder {
    pub fn start(self: &Arc<Self>, app_state: &AppState) -> Result<PerformanceStatus, String> {
        let generation = {
            let mut state = self.state.lock_or_recover("performance recorder");
            if state.recording {
                return Ok(status_from(&state));
            }
            state.recording = true;
            state.generation = state.generation.wrapping_add(1);
            state.started_at = Some(Utc::now().to_rfc3339());
            state.stopped_at = None;
            state.started_instant = Some(Instant::now());
            state.dropped_samples = 0;
            state.samples.clear();
            state.pending_renderer_stalls = RendererStallMetrics::default();
            state.generation
        };

        let recorder = Arc::clone(self);
        let sources = PerformanceSources::from_state(app_state);
        if let Err(error) = std::thread::Builder::new()
            .name("argmax-performance".to_string())
            .spawn(move || sample_loop(sources, recorder, generation))
        {
            let mut state = self.state.lock_or_recover("performance recorder");
            if state.generation == generation {
                state.recording = false;
                state.stopped_at = Some(Utc::now().to_rfc3339());
            }
            return Err(error.to_string());
        }

        Ok(self.status())
    }

    pub fn stop(&self) -> PerformanceCapture {
        {
            let mut state = self.state.lock_or_recover("performance recorder");
            if state.recording {
                state.recording = false;
                state.stopped_at = Some(Utc::now().to_rfc3339());
            }
        }
        self.capture()
    }

    pub fn status(&self) -> PerformanceStatus {
        status_from(&self.state.lock_or_recover("performance recorder"))
    }

    pub fn capture(&self) -> PerformanceCapture {
        let state = self.state.lock_or_recover("performance recorder");
        let samples: Vec<_> = state.samples.iter().cloned().collect();
        PerformanceCapture {
            started_at: state.started_at.clone(),
            stopped_at: state.stopped_at.clone(),
            recording: state.recording,
            dropped_samples: state.dropped_samples,
            environment: PerformanceEnvironment {
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                platform: std::env::consts::OS.to_string(),
                arch: std::env::consts::ARCH.to_string(),
                build_profile: if cfg!(debug_assertions) {
                    "debug".to_string()
                } else {
                    "release".to_string()
                },
                logical_cpu_count: std::thread::available_parallelism()
                    .map(|count| count.get() as u64)
                    .unwrap_or(0),
                sample_interval_ms: SAMPLE_INTERVAL.as_millis() as u64,
                sample_capacity: SAMPLE_CAPACITY as u64,
            },
            summary: summarize(&samples),
            samples,
        }
    }

    pub fn report_renderer_stall(&self, duration_ms: f64) {
        if !duration_ms.is_finite() || duration_ms <= 0.0 {
            return;
        }
        let mut state = self.state.lock_or_recover("performance recorder");
        if !state.recording {
            return;
        }
        state.pending_renderer_stalls.count += 1;
        state.pending_renderer_stalls.total_ms += duration_ms;
        state.pending_renderer_stalls.longest_ms =
            state.pending_renderer_stalls.longest_ms.max(duration_ms);
    }

    fn is_generation_active(&self, generation: u64) -> bool {
        let state = self.state.lock_or_recover("performance recorder");
        state.recording && state.generation == generation
    }

    fn push(&self, generation: u64, mut sample: PerformanceSample) {
        let mut state = self.state.lock_or_recover("performance recorder");
        if !state.recording || state.generation != generation {
            return;
        }
        sample.renderer_stalls = std::mem::take(&mut state.pending_renderer_stalls);
        if state.samples.len() == SAMPLE_CAPACITY {
            state.samples.pop_front();
            state.dropped_samples += 1;
        }
        state.samples.push_back(sample);
    }
}

fn status_from(state: &RecorderState) -> PerformanceStatus {
    PerformanceStatus {
        recording: state.recording,
        started_at: state.started_at.clone(),
        sample_count: state.samples.len() as u64,
        dropped_samples: state.dropped_samples,
        latest: state.samples.back().cloned(),
    }
}

#[derive(Clone)]
struct PerformanceSources {
    providers: Option<Arc<crate::providers::session_service::ProviderSessionService>>,
    database: Option<Arc<crate::persistence::Database>>,
}

impl PerformanceSources {
    fn from_state(state: &AppState) -> Self {
        Self {
            providers: state.providers.get().cloned(),
            database: state.db.get().cloned(),
        }
    }
}

fn sample_loop(sources: PerformanceSources, recorder: Arc<PerformanceRecorder>, generation: u64) {
    let mut processes = ProcessSampler::default();
    let mut previous = Counters::from_sources(&sources);
    let _ = processes.sample();

    loop {
        std::thread::sleep(SAMPLE_INTERVAL);
        if !recorder.is_generation_active(generation) {
            break;
        }

        let sample_started = Instant::now();
        let current = Counters::from_sources(&sources);
        let elapsed_seconds = current
            .observed_at
            .duration_since(previous.observed_at)
            .as_secs_f64();
        let provider = sources
            .providers
            .as_ref()
            .map(|service| service.performance_stats())
            .unwrap_or_default();
        let sqlite = sources
            .database
            .as_ref()
            .and_then(|database| database.reader_pool_stats());
        let started = recorder
            .state
            .lock_or_recover("performance recorder")
            .started_instant;
        let sample = PerformanceSample {
            captured_at: Utc::now().to_rfc3339(),
            elapsed_ms: started
                .map(|instant| instant.elapsed().as_millis() as u64)
                .unwrap_or(0),
            sampler_overhead_ms: 0.0,
            processes: processes.sample(),
            running_chats: provider.running_chats,
            running_chats_by_provider: provider.running_chats_by_provider,
            provider_events: current
                .provider_events
                .saturating_sub(previous.provider_events),
            provider_events_per_second: rate(
                current.provider_events,
                previous.provider_events,
                elapsed_seconds,
            ),
            ipc_calls: current.ipc_calls.saturating_sub(previous.ipc_calls),
            ipc_calls_per_second: rate(current.ipc_calls, previous.ipc_calls, elapsed_seconds),
            pending_provider_items: provider.pending_items,
            sqlite: sqlite.map_or_else(SqlitePressureMetrics::default, |stats| {
                SqlitePressureMetrics {
                    active_readers: stats.active as u64,
                    waiting_reads: stats.wait_count.saturating_sub(previous.sqlite_wait_count),
                    wait_ms: stats
                        .total_wait
                        .saturating_sub(previous.sqlite_wait)
                        .as_secs_f64()
                        * 1_000.0,
                }
            }),
            renderer_stalls: RendererStallMetrics::default(),
        };
        let sample = PerformanceSample {
            sampler_overhead_ms: sample_started.elapsed().as_secs_f64() * 1_000.0,
            ..sample
        };
        recorder.push(generation, sample);
        previous = current;
    }
}

fn rate(current: u64, previous: u64, elapsed_seconds: f64) -> f64 {
    if elapsed_seconds <= 0.0 {
        0.0
    } else {
        current.saturating_sub(previous) as f64 / elapsed_seconds
    }
}

struct Counters {
    observed_at: Instant,
    provider_events: u64,
    ipc_calls: u64,
    sqlite_wait_count: u64,
    sqlite_wait: Duration,
}

impl Counters {
    fn from_sources(sources: &PerformanceSources) -> Self {
        let provider_events = sources
            .providers
            .as_ref()
            .map(|service| service.performance_stats().output_events)
            .unwrap_or(0);
        let (sqlite_wait_count, sqlite_wait) = sources
            .database
            .as_ref()
            .and_then(|database| database.reader_pool_stats())
            .map(|stats| (stats.wait_count, stats.total_wait))
            .unwrap_or_default();
        Self {
            observed_at: Instant::now(),
            provider_events,
            ipc_calls: total_ipc_calls(),
            sqlite_wait_count,
            sqlite_wait,
        }
    }
}

fn total_ipc_calls() -> u64 {
    std::panic::catch_unwind(crate::util::tracing_init::ipc_latency)
        .map(|registry| {
            registry
                .known_channels()
                .iter()
                .map(|channel| registry.total_recorded(channel) as u64)
                .sum()
        })
        .unwrap_or(0)
}

fn summarize(samples: &[PerformanceSample]) -> PerformanceCaptureSummary {
    let cpu: Vec<_> = samples
        .iter()
        .map(|sample| sample.processes.total.cpu_percent)
        .collect();
    let rss: Vec<_> = samples
        .iter()
        .map(|sample| sample.processes.total.rss_bytes as f64)
        .collect();
    let per_chat: Vec<_> = samples
        .iter()
        .filter(|sample| sample.running_chats > 0)
        .map(|sample| sample.processes.total.cpu_percent / sample.running_chats as f64)
        .collect();
    let sampler_overhead: Vec<_> = samples
        .iter()
        .map(|sample| sample.sampler_overhead_ms)
        .collect();
    PerformanceCaptureSummary {
        cpu_percent: numeric_summary(cpu),
        rss_bytes: numeric_summary(rss),
        cpu_percent_per_running_chat: numeric_summary(per_chat),
        sampler_overhead_ms: numeric_summary(sampler_overhead),
        renderer_stall_count: samples
            .iter()
            .map(|sample| sample.renderer_stalls.count)
            .sum(),
        renderer_stall_ms: samples
            .iter()
            .map(|sample| sample.renderer_stalls.total_ms)
            .sum(),
        sqlite_wait_count: samples
            .iter()
            .map(|sample| sample.sqlite.waiting_reads)
            .sum(),
        sqlite_wait_ms: samples.iter().map(|sample| sample.sqlite.wait_ms).sum(),
        provider_events: samples.iter().map(|sample| sample.provider_events).sum(),
        ipc_calls: samples.iter().map(|sample| sample.ipc_calls).sum(),
    }
}

fn numeric_summary(mut values: Vec<f64>) -> NumericSummary {
    if values.is_empty() {
        return NumericSummary::default();
    }
    values.sort_by(f64::total_cmp);
    NumericSummary {
        median: percentile(&values, 0.50),
        p95: percentile(&values, 0.95),
        peak: values.last().copied().unwrap_or(0.0),
    }
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    let index = ((sorted.len() as f64 - 1.0) * percentile).round() as usize;
    sorted[index]
}

#[derive(Default)]
struct ProcessSampler {
    previous_cpu_ns: HashMap<i32, u64>,
    previous_at: Option<Instant>,
}

impl ProcessSampler {
    fn sample(&mut self) -> ProcessTreeMetrics {
        let now = Instant::now();
        let elapsed_ns = self
            .previous_at
            .map(|previous| now.duration_since(previous).as_nanos() as f64)
            .unwrap_or(0.0);
        let root_pid = std::process::id() as i32;
        let processes = process_tree(root_pid);
        let live_pids: HashSet<_> = processes.iter().map(|process| process.pid).collect();
        let mut metrics = ProcessTreeMetrics::default();

        for process in processes {
            let cpu_percent = self
                .previous_cpu_ns
                .get(&process.pid)
                .filter(|_| elapsed_ns > 0.0)
                .map(|previous| {
                    process.cpu_ns.saturating_sub(*previous) as f64 / elapsed_ns * 100.0
                })
                .unwrap_or(0.0);
            self.previous_cpu_ns.insert(process.pid, process.cpu_ns);
            add_process(&mut metrics.total, cpu_percent, process.rss_bytes);
            if process.pid == root_pid {
                add_process(&mut metrics.host, cpu_percent, process.rss_bytes);
            } else if is_webview_process(&process.name) {
                add_process(&mut metrics.webview, cpu_percent, process.rss_bytes);
            } else {
                add_process(&mut metrics.agents, cpu_percent, process.rss_bytes);
            }
        }
        self.previous_cpu_ns
            .retain(|pid, _| live_pids.contains(pid));
        self.previous_at = Some(now);
        metrics
    }
}

fn add_process(group: &mut ProcessGroupMetrics, cpu_percent: f64, rss_bytes: u64) {
    group.cpu_percent += cpu_percent;
    group.rss_bytes = group.rss_bytes.saturating_add(rss_bytes);
    group.process_count += 1;
}

fn is_webview_process(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("webkit") || name.contains("webcontent") || name.contains("gpu")
}

struct ProcessUsage {
    pid: i32,
    name: String,
    cpu_ns: u64,
    rss_bytes: u64,
}

#[cfg(target_os = "macos")]
fn process_tree(root_pid: i32) -> Vec<ProcessUsage> {
    macos::process_tree(root_pid)
}

#[cfg(target_os = "linux")]
fn process_tree(root_pid: i32) -> Vec<ProcessUsage> {
    linux::process_tree(root_pid)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_tree(root_pid: i32) -> Vec<ProcessUsage> {
    vec![ProcessUsage {
        pid: root_pid,
        name: "argmax".to_string(),
        cpu_ns: 0,
        rss_bytes: 0,
    }]
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{c_int, c_void};
    use std::mem::{size_of, zeroed};

    use super::ProcessUsage;

    const RUSAGE_INFO_V0: c_int = 0;

    #[repr(C)]
    struct RusageInfoV0 {
        uuid: [u8; 16],
        user_time: u64,
        system_time: u64,
        package_idle_wakeups: u64,
        interrupt_wakeups: u64,
        pageins: u64,
        wired_size: u64,
        resident_size: u64,
        physical_footprint: u64,
        process_start_absolute_time: u64,
        process_exit_absolute_time: u64,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_listchildpids(pid: c_int, buffer: *mut c_void, buffer_size: c_int) -> c_int;
        fn proc_pid_rusage(pid: c_int, flavor: c_int, buffer: *mut c_void) -> c_int;
        fn proc_name(pid: c_int, buffer: *mut c_void, buffer_size: u32) -> c_int;
    }

    pub(super) fn process_tree(root_pid: i32) -> Vec<ProcessUsage> {
        let mut pending = vec![root_pid];
        let mut processes = Vec::new();
        while let Some(pid) = pending.pop() {
            pending.extend(children(pid));
            if let Some(usage) = usage(pid) {
                processes.push(usage);
            }
        }
        processes
    }

    fn children(pid: i32) -> Vec<i32> {
        let child_count = unsafe { proc_listchildpids(pid, std::ptr::null_mut(), 0) };
        if child_count <= 0 {
            return Vec::new();
        }
        let mut children = vec![0_i32; child_count as usize];
        let written = unsafe {
            proc_listchildpids(
                pid,
                children.as_mut_ptr().cast(),
                (children.len() * size_of::<i32>()) as c_int,
            )
        };
        if written <= 0 {
            return Vec::new();
        }
        children.truncate(written as usize);
        children.retain(|child| *child > 0);
        children
    }

    fn usage(pid: i32) -> Option<ProcessUsage> {
        let mut usage: RusageInfoV0 = unsafe { zeroed() };
        let result = unsafe {
            proc_pid_rusage(
                pid,
                RUSAGE_INFO_V0,
                (&mut usage as *mut RusageInfoV0).cast(),
            )
        };
        if result != 0 {
            return None;
        }
        let mut name = [0_u8; 256];
        let length = unsafe { proc_name(pid, name.as_mut_ptr().cast(), name.len() as u32) };
        let name = if length > 0 {
            String::from_utf8_lossy(&name[..length as usize]).into_owned()
        } else {
            "unknown".to_string()
        };
        Some(ProcessUsage {
            pid,
            name,
            cpu_ns: usage.user_time.saturating_add(usage.system_time),
            rss_bytes: usage.resident_size,
        })
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fs;

    use super::ProcessUsage;

    pub(super) fn process_tree(root_pid: i32) -> Vec<ProcessUsage> {
        let ticks_per_second = 100_u64;
        let page_size = 4096_u64;
        let mut all = Vec::new();
        let Ok(entries) = fs::read_dir("/proc") else {
            return all;
        };
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some(close) = stat.rfind(')') else {
                continue;
            };
            let name = stat[stat.find('(').unwrap_or(0) + 1..close].to_string();
            let fields: Vec<_> = stat[close + 2..].split_whitespace().collect();
            if fields.len() < 22 {
                continue;
            }
            let ppid = fields[1].parse::<i32>().unwrap_or(0);
            let cpu_ticks =
                fields[11].parse::<u64>().unwrap_or(0) + fields[12].parse::<u64>().unwrap_or(0);
            let rss_pages = fields[21].parse::<u64>().unwrap_or(0);
            all.push((pid, ppid, name, cpu_ticks, rss_pages));
        }
        let mut descendants = HashSet::from([root_pid]);
        loop {
            let before = descendants.len();
            for (pid, ppid, ..) in &all {
                if descendants.contains(ppid) {
                    descendants.insert(*pid);
                }
            }
            if descendants.len() == before {
                break;
            }
        }
        all.into_iter()
            .filter(|(pid, ..)| descendants.contains(pid))
            .map(|(pid, _, name, cpu_ticks, rss_pages)| ProcessUsage {
                pid,
                name,
                cpu_ns: cpu_ticks.saturating_mul(1_000_000_000 / ticks_per_second),
                rss_bytes: rss_pages.saturating_mul(page_size),
            })
            .collect()
    }

    use std::collections::HashSet;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_reports_distribution_and_per_chat_cost() {
        let samples = [10.0, 30.0, 20.0]
            .into_iter()
            .map(|cpu| PerformanceSample {
                captured_at: String::new(),
                elapsed_ms: 0,
                sampler_overhead_ms: 0.0,
                processes: ProcessTreeMetrics {
                    total: ProcessGroupMetrics {
                        cpu_percent: cpu,
                        rss_bytes: (cpu as u64) * 100,
                        process_count: 1,
                    },
                    ..ProcessTreeMetrics::default()
                },
                running_chats: 2,
                running_chats_by_provider: BTreeMap::new(),
                provider_events: 0,
                provider_events_per_second: 0.0,
                ipc_calls: 0,
                ipc_calls_per_second: 0.0,
                pending_provider_items: 0,
                sqlite: SqlitePressureMetrics::default(),
                renderer_stalls: RendererStallMetrics::default(),
            })
            .collect::<Vec<_>>();
        let summary = summarize(&samples);
        assert_eq!(summary.cpu_percent.median, 20.0);
        assert_eq!(summary.cpu_percent.p95, 30.0);
        assert_eq!(summary.cpu_percent_per_running_chat.median, 10.0);
        assert_eq!(summary.rss_bytes.peak, 3_000.0);
    }

    #[test]
    fn webview_process_names_are_classified_without_provider_false_positives() {
        assert!(is_webview_process("com.apple.WebKit.WebContent"));
        assert!(is_webview_process("Argmax GPU"));
        assert!(!is_webview_process("codex"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_sampler_reads_the_current_process() {
        let pid = std::process::id() as i32;
        let current = process_tree(pid)
            .into_iter()
            .find(|process| process.pid == pid)
            .expect("current process usage");
        assert!(current.rss_bytes > 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_process_sampler_walks_child_processes() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("2")
            .spawn()
            .expect("spawn child");
        let child_pid = child.id() as i32;
        let descendants = process_tree(std::process::id() as i32);
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            descendants.iter().any(|process| process.pid == child_pid),
            "spawned child was absent from the native process tree"
        );
    }
}
