//! Persisted site exceptions and native browser content-rule preparation.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::Url;
use tauri::{AppHandle, Manager};

use crate::error::{ArgmaxError, ArgmaxResult};
use crate::ipc::read_off_main;

const SETTINGS_FILE: &str = "browser-content-blocking.json";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    disabled_hosts: BTreeSet<String>,
}

#[derive(Default)]
pub struct ContentBlockingState {
    settings: Option<Settings>,
    identifier: Option<String>,
}

#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserContentBlocking {
    pub supported: bool,
    pub disabled_hosts: Vec<String>,
}

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSetSiteBlockingInput {
    pub url: String,
    pub enabled: bool,
}

fn failure(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("BROWSER_CONTENT_BLOCKING_FAILED", message)
}

pub fn site_host(raw_url: &str) -> ArgmaxResult<String> {
    let url = Url::parse(raw_url).map_err(|_| failure("Enter a valid website URL."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(failure(
            "Content blocking applies only to HTTP and HTTPS websites.",
        ));
    }
    url.host_str()
        .map(|host| host.trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .ok_or_else(|| failure("The website URL has no hostname."))
}

fn read_settings(directory: &Path) -> ArgmaxResult<Settings> {
    let bytes = match std::fs::read(directory.join(SETTINGS_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Settings::default())
        }
        Err(error) => {
            return Err(failure(format!(
                "Could not read browser site exceptions: {error}"
            )))
        }
    };
    let settings: Settings = serde_json::from_slice(&bytes)
        .map_err(|error| failure(format!("Invalid browser site exceptions: {error}")))?;
    for host in &settings.disabled_hosts {
        if site_host(&format!("https://{host}/"))? != *host {
            return Err(failure(
                "Browser site exceptions contain an invalid hostname.",
            ));
        }
    }
    Ok(settings)
}

fn write_settings(directory: &Path, settings: &Settings) -> ArgmaxResult<()> {
    std::fs::create_dir_all(directory).map_err(|error| failure(error.to_string()))?;
    let body = serde_json::to_vec(settings).map_err(|error| failure(error.to_string()))?;
    let mut staged =
        tempfile::NamedTempFile::new_in(directory).map_err(|error| failure(error.to_string()))?;
    staged
        .write_all(&body)
        .map_err(|error| failure(error.to_string()))?;
    staged
        .as_file()
        .sync_all()
        .map_err(|error| failure(error.to_string()))?;
    staged
        .persist(directory.join(SETTINGS_FILE))
        .map_err(|error| failure(error.to_string()))?;
    Ok(())
}

async fn load(app: &AppHandle, state: &mut ContentBlockingState) -> ArgmaxResult<Settings> {
    if state.settings.is_none() {
        let directory =
            crate::util::data_dir::app_data_dir(app).map_err(|error| failure(error.to_string()))?;
        state.settings = Some(read_off_main(move || read_settings(&directory)).await?);
    }
    Ok(state.settings.as_ref().expect("settings loaded").clone())
}

pub async fn status(
    app: &AppHandle,
    state: &mut ContentBlockingState,
) -> ArgmaxResult<BrowserContentBlocking> {
    let settings = load(app, state).await?;
    Ok(BrowserContentBlocking {
        supported: cfg!(target_os = "macos"),
        disabled_hosts: settings.disabled_hosts.into_iter().collect(),
    })
}

/// Caller holds the app's async mutex through the subsequent main-thread open.
pub async fn ensure(
    app: &AppHandle,
    state: &mut ContentBlockingState,
) -> ArgmaxResult<Option<String>> {
    if !cfg!(target_os = "macos") {
        return Ok(None);
    }
    if let Some(identifier) = &state.identifier {
        return Ok(Some(identifier.clone()));
    }
    let settings = load(app, state).await?;
    let identifier = prepare(app, settings).await?;
    let next = identifier.clone();
    on_main(app, move |app| activate(app, &next)).await?;
    state.identifier = Some(identifier.clone());
    Ok(Some(identifier))
}

pub async fn set_site(
    app: &AppHandle,
    state: &mut ContentBlockingState,
    input: BrowserSetSiteBlockingInput,
) -> ArgmaxResult<BrowserContentBlocking> {
    if !cfg!(target_os = "macos") {
        return Err(failure("Native content blocking is available on macOS."));
    }
    let host = site_host(&input.url)?;
    let mut settings = load(app, state).await?;
    if input.enabled {
        settings.disabled_hosts.remove(&host);
    } else {
        settings.disabled_hosts.insert(host);
    }
    if settings.disabled_hosts.len() > 1_000 {
        return Err(failure("The browser supports up to 1,000 site exceptions."));
    }
    let identifier = prepare(app, settings.clone()).await?;
    let directory =
        crate::util::data_dir::app_data_dir(app).map_err(|error| failure(error.to_string()))?;
    let saved = settings.clone();
    read_off_main(move || write_settings(&directory, &saved)).await?;
    // Keep the in-memory preference consistent with the durable one even if
    // a window disappears during application. Retrying reapplies the list.
    state.settings = Some(settings);
    state.identifier = None;
    let next = identifier.clone();
    on_main(app, move |app| activate(app, &next)).await?;
    state.identifier = Some(identifier);
    status(app, state).await
}

async fn prepare(app: &AppHandle, settings: Settings) -> ArgmaxResult<String> {
    let path = app
        .path()
        .resolve(
            "browser-blocking/light.txt",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| failure(error.to_string()))?;
    #[cfg(debug_assertions)]
    let path = if path.exists() {
        path
    } else {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/browser-blocking/light.txt")
    };
    let (identifier, json) = read_off_main(move || {
        let source = std::fs::read_to_string(path)
            .map_err(|error| failure(format!("Could not read bundled browser rules: {error}")))?;
        let json = rules_json(&source, &settings)?;
        let hash: String = Sha256::digest(json.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let identifier = format!("argmax-domains-v1-{hash}");
        Ok((identifier, json))
    })
    .await?;
    #[cfg(target_os = "macos")]
    super::content_blocking_macos::prepare(app, identifier.clone(), json).await?;
    #[cfg(not(target_os = "macos"))]
    let _ = json;
    Ok(identifier)
}

fn activate(app: &AppHandle, identifier: &str) -> ArgmaxResult<()> {
    #[cfg(target_os = "macos")]
    {
        super::content_blocking_macos::activate(identifier)?;
        let tabs = app.state::<crate::state::AppState>().browser_tabs.list();
        let labels: BTreeSet<_> = tabs
            .iter()
            .filter(|tab| tab.owner_session_id.is_none())
            .map(|tab| format!("browser-{}", tab.tab_id))
            .collect();
        for (label, webview) in app.webviews() {
            if labels.contains(&label) || label.starts_with("browser-popup-user-") {
                super::content_blocking_macos::apply(&webview, Some(identifier.to_owned()))?;
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, identifier);
    Ok(())
}

/// Domain-list conversion, not an Adblock syntax interpreter. Reject anything
/// outside HaGeZi's documented domain-only format instead of weakening a rule.
fn rules_json(source: &str, settings: &Settings) -> ArgmaxResult<String> {
    let mut domains = BTreeSet::new();
    for line in source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('!') && *line != "[Adblock Plus]")
    {
        let domain = line
            .strip_prefix("||")
            .and_then(|value| value.strip_suffix('^'))
            .filter(|value| valid_domain(value))
            .ok_or_else(|| failure("Bundled browser rules contain unsupported filter syntax."))?;
        domains.insert(domain);
    }
    if domains.is_empty() || domains.len() > 100_000 {
        return Err(failure(
            "Bundled browser rules have an invalid domain count.",
        ));
    }
    let mut rules: Vec<_> = domains.into_iter().map(|domain| serde_json::json!({
        "trigger": {"url-filter": format!(r"^https?://([^/]+\.)?{}\.?(:[0-9]+)?/", domain.replace('.', r"\.")), "load-type": ["third-party"]},
        "action": {"type": "block"}
    })).collect();
    // WebKit's regex subset does not support alternation.
    let mut exceptions: Vec<String> = [
        r"^https?://([^/]+\.)?localhost\.?(:[0-9]+)?/",
        r"^https?://127\.[0-9]+\.[0-9]+\.[0-9]+\.?(:[0-9]+)?/",
        r"^https?://\[::1\](:[0-9]+)?/",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for host in &settings.disabled_hosts {
        exceptions.push(format!(r"^https?://{}\.?(:[0-9]+)?/", regex::escape(host)));
    }
    rules.push(serde_json::json!({
        "trigger": {"url-filter": ".*", "if-top-url": exceptions},
        "action": {"type": "ignore-previous-rules"}
    }));
    serde_json::to_string(&rules).map_err(|error| failure(error.to_string()))
}

fn valid_domain(domain: &str) -> bool {
    domain.len() <= 253
        && domain.contains('.')
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

pub async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    work: impl FnOnce(&AppHandle) -> ArgmaxResult<T> + Send + 'static,
) -> ArgmaxResult<T> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(work(&handle));
    })
    .map_err(|error| failure(error.to_string()))?;
    receiver
        .await
        .map_err(|_| failure("The browser operation was dropped before it ran."))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_rules_reject_unknown_filter_syntax() {
        for source in [
            "",
            "||example.com^$script",
            "@@||example.com^",
            "||example.com/ads^",
            "||example..com^",
        ] {
            assert!(
                rules_json(source, &Settings::default()).is_err(),
                "{source}"
            );
        }
    }

    #[test]
    fn matching_respects_host_boundaries_and_exact_site_exceptions() {
        let settings = Settings {
            disabled_hosts: BTreeSet::from(["allowed.test".into()]),
        };
        let rules: serde_json::Value =
            serde_json::from_str(&rules_json("||ads.example.com^", &settings).unwrap()).unwrap();
        let block = regex::Regex::new(rules[0]["trigger"]["url-filter"].as_str().unwrap()).unwrap();
        for url in [
            "https://ads.example.com/a.js",
            "http://sub.ads.example.com:8000/a.js",
            "https://ads.example.com./a.js",
        ] {
            assert!(block.is_match(url), "{url}");
        }
        for url in [
            "https://notads.example.com/a",
            "https://ads.example.com.evil.test/a",
            "https://other.test/ads.example.com/a",
        ] {
            assert!(!block.is_match(url), "{url}");
        }
        let exception =
            regex::Regex::new(rules[1]["trigger"]["if-top-url"][3].as_str().unwrap()).unwrap();
        assert!(exception.is_match("https://allowed.test:8443/page"));
        assert!(!exception.is_match("https://notallowed.test/page"));
        assert!(!exception.is_match("https://sub.allowed.test/page"));
        assert_eq!(
            rules[0]["trigger"]["load-type"],
            serde_json::json!(["third-party"])
        );
        assert_eq!(rules[1]["action"]["type"], "ignore-previous-rules");
    }

    #[test]
    fn exceptions_round_trip_and_invalid_files_fail_loudly() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_settings(dir.path()).unwrap().disabled_hosts.is_empty());
        let settings = Settings {
            disabled_hosts: BTreeSet::from([site_host("https://ExAmPlE.com.:8443/path").unwrap()]),
        };
        write_settings(dir.path(), &settings).unwrap();
        assert_eq!(
            read_settings(dir.path()).unwrap().disabled_hosts,
            BTreeSet::from(["example.com".into()])
        );
        std::fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{"disabledHosts":["example.com/path"]}"#,
        )
        .unwrap();
        assert!(read_settings(dir.path()).is_err());
        assert!(site_host("file:///tmp/test").is_err());
    }

    fn bundled_source() -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/browser-blocking/light.txt"),
        )
        .unwrap()
    }

    #[test]
    fn bundled_list_matches_its_provenance_and_converts_without_dropping_rules() {
        let source = bundled_source();
        let provenance: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../assets/browser-blocking/source.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let hash: String = Sha256::digest(source.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(provenance["sha256"].as_str().unwrap(), hash);
        let rules: Vec<serde_json::Value> =
            serde_json::from_str(&rules_json(&source, &Settings::default()).unwrap()).unwrap();
        assert_eq!(
            rules.len(),
            provenance["domains"].as_u64().unwrap() as usize + 1
        );
    }

    /// Exercises WebKit itself in a separate main-thread process. Requires the
    /// macOS Swift toolchain and access to Google's public analytics.js file.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn native_browser_content_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let rules = dir.path().join("rules.json");
        let settings = Settings {
            disabled_hosts: BTreeSet::from(["allowed.example.test".into()]),
        };
        std::fs::write(&rules, rules_json(&bundled_source(), &settings).unwrap()).unwrap();
        let output = std::process::Command::new("swift")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../scripts/check-browser-blocking.swift"),
            )
            .arg(&rules)
            .output()
            .expect("run native WebKit fixture");
        println!("{}", String::from_utf8_lossy(&output.stdout));
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
