//! Which browser tabs exist, and who opened them.
//!
//! The renderer used to be the only place that knew what tabs there were. An
//! agent opening a page has no renderer to ask, so the list moved here: every
//! child webview the app creates is registered, tagged with the session that
//! asked for it (or with nobody, for tabs the user opened). The renderer
//! mirrors this list through the `browser:tabs` push event rather than owning
//! it — it still keeps its `localStorage` copy, but only to remember URLs
//! across a restart, since the webviews themselves die with the process.
//!
//! `last_used` is what "the session's current tab" means: an agent that opens
//! two pages and then clicks acts on the one it touched most recently, the
//! same rule a person's foreground tab follows.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabInfo {
    pub tab_id: String,
    /// Session that opened the tab. `None` for tabs the user opened.
    pub owner_session_id: Option<String>,
    pub url: String,
    pub title: Option<String>,
    pub loading: bool,
    /// Optional label used to organize related tabs in the visible strip.
    pub group: Option<String>,
}

/// Full list, pushed on every change — a delta would have to be reconciled
/// against a renderer list that is no longer the source of truth.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabsEvent {
    pub tabs: Vec<BrowserTabInfo>,
}

/// Pushed when a session's tab opens, so the pane showing that session can
/// switch itself to Browser mode and watch.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentOpenEvent {
    pub session_id: String,
    pub tab_id: String,
    pub url: String,
}

struct Entry {
    info: BrowserTabInfo,
    last_used: u64,
}

#[derive(Default)]
pub struct BrowserTabRegistry {
    entries: Mutex<Vec<Entry>>,
    clock: AtomicU64,
}

impl BrowserTabRegistry {
    fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed)
    }

    /// Records a tab, or re-points an existing one at a new URL (`browser:open`
    /// on a live tab navigates it). Returns true when the list changed.
    pub fn insert(&self, tab_id: &str, owner_session_id: Option<String>, url: &str) -> bool {
        let stamp = self.tick();
        let mut entries = self.entries.lock().expect("browser registry poisoned");
        if let Some(entry) = entries.iter_mut().find(|entry| entry.info.tab_id == tab_id) {
            entry.last_used = stamp;
            if entry.info.url == url && entry.info.owner_session_id == owner_session_id {
                return false;
            }
            entry.info.url = url.to_string();
            // Re-opening never *drops* an owner: the renderer re-materializes
            // a restored tab through the same command, with no session to
            // name, and that must not orphan the agent's tab.
            if owner_session_id.is_some() {
                entry.info.owner_session_id = owner_session_id;
            }
            return true;
        }
        entries.push(Entry {
            info: BrowserTabInfo {
                tab_id: tab_id.to_string(),
                owner_session_id,
                url: url.to_string(),
                title: None,
                loading: true,
                group: None,
            },
            last_used: stamp,
        });
        true
    }

    /// Folds a `browser:state` event in. Unknown tabs are ignored — a state
    /// event for a tab this registry never saw means the webview outlived its
    /// registration, and inventing an entry would resurrect it in the strip.
    pub fn update_state(
        &self,
        tab_id: &str,
        url: &str,
        title: Option<String>,
        loading: bool,
    ) -> bool {
        let mut entries = self.entries.lock().expect("browser registry poisoned");
        let Some(entry) = entries.iter_mut().find(|entry| entry.info.tab_id == tab_id) else {
            return false;
        };
        let title = title.or_else(|| entry.info.title.clone());
        let next = (url.to_string(), title, loading);
        if (
            entry.info.url.clone(),
            entry.info.title.clone(),
            entry.info.loading,
        ) == next
        {
            return false;
        }
        entry.info.url = next.0;
        entry.info.title = next.1;
        entry.info.loading = next.2;
        true
    }

    /// Marks a tab as the one its owner is working in.
    pub fn touch(&self, tab_id: &str) {
        let stamp = self.tick();
        let mut entries = self.entries.lock().expect("browser registry poisoned");
        if let Some(entry) = entries.iter_mut().find(|entry| entry.info.tab_id == tab_id) {
            entry.last_used = stamp;
        }
    }

    pub fn remove(&self, tab_id: &str) -> bool {
        let mut entries = self.entries.lock().expect("browser registry poisoned");
        let before = entries.len();
        entries.retain(|entry| entry.info.tab_id != tab_id);
        entries.len() != before
    }

    pub fn contains(&self, tab_id: &str) -> bool {
        let entries = self.entries.lock().expect("browser registry poisoned");
        entries.iter().any(|entry| entry.info.tab_id == tab_id)
    }

    pub fn get(&self, tab_id: &str) -> Option<BrowserTabInfo> {
        let entries = self.entries.lock().expect("browser registry poisoned");
        entries
            .iter()
            .find(|entry| entry.info.tab_id == tab_id)
            .map(|entry| entry.info.clone())
    }

    pub fn set_group(&self, tab_ids: &[String], group: Option<String>) -> bool {
        let mut changed = false;
        let mut entries = self.entries.lock().expect("browser registry poisoned");
        for entry in entries.iter_mut() {
            if tab_ids.contains(&entry.info.tab_id) && entry.info.group != group {
                entry.info.group = group.clone();
                changed = true;
            }
        }
        changed
    }

    pub fn list(&self) -> Vec<BrowserTabInfo> {
        let entries = self.entries.lock().expect("browser registry poisoned");
        entries.iter().map(|entry| entry.info.clone()).collect()
    }

    pub fn for_session(&self, session_id: &str) -> Vec<BrowserTabInfo> {
        let entries = self.entries.lock().expect("browser registry poisoned");
        entries
            .iter()
            .filter(|entry| entry.info.owner_session_id.as_deref() == Some(session_id))
            .map(|entry| entry.info.clone())
            .collect()
    }

    /// The tab a session-scoped action means when it names no tab.
    pub fn latest_for_session(&self, session_id: &str) -> Option<BrowserTabInfo> {
        let entries = self.entries.lock().expect("browser registry poisoned");
        entries
            .iter()
            .filter(|entry| entry.info.owner_session_id.as_deref() == Some(session_id))
            .max_by_key(|entry| entry.last_used)
            .map(|entry| entry.info.clone())
    }

    /// Free tab id for a session-opened tab. Ids become native webview labels
    /// (`browser-<id>`), and a destroyed label must not come back, so the
    /// counter only ever moves forward.
    pub fn allocate_tab_id(&self) -> String {
        loop {
            let candidate = format!("agent-{}", self.tick());
            if !self.contains(&candidate) {
                return candidate;
            }
        }
    }
}

/// Pushes the whole list to the main webview. Called after every change, so
/// the renderer's strip is a mirror rather than a second source of truth.
pub fn publish(app: &AppHandle, registry: &BrowserTabRegistry) {
    let _ = app.emit_to(
        "main",
        "browser:tabs",
        BrowserTabsEvent {
            tabs: registry.list(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::BrowserTabRegistry;

    #[test]
    fn the_sessions_tab_is_the_one_it_touched_last() {
        let registry = BrowserTabRegistry::default();
        registry.insert("agent-1", Some("s1".into()), "https://a.example");
        registry.insert("agent-2", Some("s1".into()), "https://b.example");
        registry.insert("tab-1", None, "https://user.example");

        assert_eq!(
            registry.latest_for_session("s1").map(|tab| tab.tab_id),
            Some("agent-2".to_string())
        );
        registry.touch("agent-1");
        assert_eq!(
            registry.latest_for_session("s1").map(|tab| tab.tab_id),
            Some("agent-1".to_string())
        );
        assert_eq!(registry.for_session("s1").len(), 2);
        assert!(registry.latest_for_session("s2").is_none());
    }

    #[test]
    fn re_opening_a_restored_tab_keeps_its_owner() {
        let registry = BrowserTabRegistry::default();
        registry.insert("agent-1", Some("s1".into()), "https://a.example");
        // The renderer re-materializes the webview with no session to name.
        registry.insert("agent-1", None, "https://a.example/next");

        let tab = registry.latest_for_session("s1").expect("owner survives");
        assert_eq!(tab.url, "https://a.example/next");
    }

    #[test]
    fn state_for_an_unknown_tab_does_not_resurrect_it() {
        let registry = BrowserTabRegistry::default();
        registry.insert("tab-1", None, "https://a.example");
        assert!(registry.remove("tab-1"));
        assert!(!registry.update_state("tab-1", "https://a.example", None, false));
        assert!(registry.list().is_empty());
    }

    #[test]
    fn a_title_survives_a_state_event_that_carries_none() {
        let registry = BrowserTabRegistry::default();
        registry.insert("tab-1", None, "https://a.example");
        registry.update_state("tab-1", "https://a.example", Some("Page".into()), false);
        registry.update_state("tab-1", "https://a.example/next", None, true);

        let tab = registry.list().pop().expect("one tab");
        assert_eq!(tab.title.as_deref(), Some("Page"));
        assert!(tab.loading);
    }

    #[test]
    fn a_group_label_lands_on_the_named_tabs_only() {
        let registry = BrowserTabRegistry::default();
        registry.insert("agent-1", Some("s1".into()), "https://a.example");
        registry.insert("agent-2", Some("s1".into()), "https://b.example");
        registry.insert("agent-3", Some("s1".into()), "https://c.example");

        assert!(registry.set_group(
            &["agent-1".into(), "agent-3".into()],
            Some("Research".into())
        ));
        // Setting the label a tab already carries is not a change, so it must
        // not publish another identical list to the strip.
        assert!(!registry.set_group(&["agent-1".into()], Some("Research".into())));

        let tabs = registry.list();
        assert_eq!(tabs[0].group.as_deref(), Some("Research"));
        assert_eq!(tabs[1].group, None);
        assert_eq!(tabs[2].group.as_deref(), Some("Research"));

        assert!(registry.set_group(&["agent-1".into(), "agent-3".into()], None));
        assert!(registry.list().iter().all(|tab| tab.group.is_none()));
    }
}
