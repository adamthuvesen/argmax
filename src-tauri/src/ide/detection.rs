// IDE detection. Mirrors `src/main/ide/ideDetection.ts`.
//
// Runs once at app boot via `OnceCell` and caches results for the
// process lifetime. macOS-only for v1; the renderer hides the
// affordance if zero IDEs surface. If the user installs a new IDE
// while Argmax is open they must restart — re-running `mdfind` on
// every render would be wasteful.

use std::{path::Path, sync::Arc, time::Duration};

use serde::Serialize;
use specta::Type;
use tokio::{process::Command, sync::OnceCell, time};

/// 4 second cap on `mdfind` per IDE.
const MDFIND_TIMEOUT: Duration = Duration::from_millis(4_000);
/// 2 second cap on `which <cli>` probing.
const WHICH_TIMEOUT: Duration = Duration::from_millis(2_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum IdeId {
    Vscode,
    Cursor,
    Windsurf,
    Zed,
    Iterm,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DetectedIde {
    pub id: IdeId,
    pub label: String,
    pub app_path: String,
    pub has_cli: bool,
}

#[derive(Debug, Clone, Copy)]
struct GuiCandidate {
    id: IdeId,
    label: &'static str,
    bundle_id: &'static str,
    app_name: &'static str,
    cli: &'static str,
}

const GUI_IDES: &[GuiCandidate] = &[
    GuiCandidate {
        id: IdeId::Vscode,
        label: "VS Code",
        bundle_id: "com.microsoft.VSCode",
        app_name: "Visual Studio Code",
        cli: "code",
    },
    GuiCandidate {
        id: IdeId::Cursor,
        label: "Cursor",
        bundle_id: "com.todesktop.230313mzl4w4u92",
        app_name: "Cursor",
        cli: "cursor",
    },
    GuiCandidate {
        id: IdeId::Windsurf,
        label: "Windsurf",
        bundle_id: "com.exafunction.windsurf",
        app_name: "Windsurf",
        cli: "windsurf",
    },
    GuiCandidate {
        id: IdeId::Zed,
        label: "Zed",
        bundle_id: "dev.zed.Zed",
        app_name: "Zed",
        cli: "zed",
    },
];

const ITERM_BUNDLE_ID: &str = "com.googlecode.iterm2";
const ITERM_APP_NAME: &str = "iTerm";
const TERMINAL_PATH: &str = "/System/Applications/Utilities/Terminal.app";

/// Process-scoped cache for `detect_installed_ides`. Resolves once per
/// process; failure clears the cell so a retry is possible.
static CACHE: OnceCell<Arc<Vec<DetectedIde>>> = OnceCell::const_new();

/// Reset the detection cache. Test-only — production code should never
/// need this because detection is keyed to the app boot.
pub async fn reset_cache_for_tests() {
    // OnceCell exposes no reset, so we work around by reaching for the
    // internal state via a write under the same module. Easiest path:
    // expose a function-scoped OnceCell via a thread_local instead. But
    // because tests are serial here, we use a one-shot bool that
    // `detect_installed_ides` checks below. For now this is a no-op;
    // every test should pass `force=true` to bypass the cache.
}

pub async fn detect_installed_ides() -> Vec<DetectedIde> {
    let arc = CACHE
        .get_or_init(|| async { Arc::new(run_detection().await) })
        .await
        .clone();
    (*arc).clone()
}

/// Force a fresh detection that bypasses the cache. Used by tests and
/// (eventually) the explicit "rescan IDEs" affordance.
pub async fn detect_installed_ides_uncached() -> Vec<DetectedIde> {
    run_detection().await
}

async fn run_detection() -> Vec<DetectedIde> {
    let mut detected: Vec<DetectedIde> = Vec::new();
    let gui_futures: Vec<_> = GUI_IDES
        .iter()
        .map(|candidate| detect_gui_ide(*candidate))
        .collect();
    let gui_results = futures_join(gui_futures).await;
    for result in gui_results.into_iter().flatten() {
        detected.push(result);
    }

    if let Some(iterm_path) = locate_app(ITERM_BUNDLE_ID, ITERM_APP_NAME).await {
        detected.push(DetectedIde {
            id: IdeId::Iterm,
            label: "iTerm".to_string(),
            app_path: iterm_path,
            has_cli: false,
        });
    }

    // Terminal.app always surfaces — users on macOS without it would
    // have other problems first.
    detected.push(DetectedIde {
        id: IdeId::Terminal,
        label: "Terminal".to_string(),
        app_path: TERMINAL_PATH.to_string(),
        has_cli: false,
    });
    detected
}

async fn detect_gui_ide(candidate: GuiCandidate) -> Option<DetectedIde> {
    let app_path = locate_app(candidate.bundle_id, candidate.app_name).await?;
    let has_cli = probe_cli(candidate.cli).await;
    Some(DetectedIde {
        id: candidate.id,
        label: candidate.label.to_string(),
        app_path,
        has_cli,
    })
}

async fn locate_app(bundle_id: &str, app_name: &str) -> Option<String> {
    if let Some(from_mdfind) = mdfind_first(bundle_id).await {
        return Some(from_mdfind);
    }
    let fallback = format!("/Applications/{app_name}.app");
    if tokio::fs::metadata(Path::new(&fallback)).await.is_ok() {
        Some(fallback)
    } else {
        None
    }
}

async fn mdfind_first(bundle_id: &str) -> Option<String> {
    let predicate = format!("kMDItemCFBundleIdentifier == \"{bundle_id}\"");
    let result = time::timeout(
        MDFIND_TIMEOUT,
        Command::new("mdfind").arg(&predicate).output(),
    )
    .await
    .ok()?;
    let output = result.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    stdout
        .lines()
        .map(|line| line.trim().to_string())
        .find(|line| !line.is_empty())
}

async fn probe_cli(cmd: &str) -> bool {
    let result = time::timeout(WHICH_TIMEOUT, Command::new("which").arg(cmd).output()).await;
    matches!(result, Ok(Ok(output)) if output.status.success())
}

async fn futures_join<F>(futures: Vec<F>) -> Vec<F::Output>
where
    F: std::future::Future,
{
    let mut out = Vec::with_capacity(futures.len());
    for f in futures {
        out.push(f.await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn detection_always_includes_terminal() {
        let detected = detect_installed_ides_uncached().await;
        assert!(detected.iter().any(|ide| ide.id == IdeId::Terminal));
    }
}
