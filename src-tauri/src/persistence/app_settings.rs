//! App-wide settings that the launcher has to know about.
//!
//! Most of Argmax's preferences live in the renderer and travel with the
//! launch that uses them ([`fast_mode`](crate::providers::ProviderLaunchInput)
//! is the pattern). This module is for the ones that cannot: a setting read
//! while building a provider launch is read on every launch path, including
//! the ones with no renderer in the loop — an agent's `session_launch`, a goal
//! turn, a check-failure follow-up, a scheduled wake. Keeping those in the
//! renderer would mean the user's choice silently applied to chats they
//! started and not to chats their agents started.
//!
//! The store is the `ui_state` key/value table.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::ArgmaxResult;

use super::{sqlite_error, time::now_iso};

/// Whether an agent's `argmax` MCP server carries the browser tools.
const BROWSER_TOOLS_KEY: &str = "agent.browser_tools.enabled";

/// What Project check may do when a launch looks aimed at the wrong project.
const PROJECT_CHECK_KEY: &str = "launch.project_check.mode";

/// The app-wide branch template for new isolated workspaces. A project's own
/// template overrides it. Read on every launch path, so it lives here.
const BRANCH_TEMPLATE_KEY: &str = "workspace.branch_template";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ProjectCheckMode {
    Off,
    /// Ask before starting in the project Jev picked.
    Suggest,
    /// Ask, and start there without asking when the evidence is overwhelming.
    Switch,
}

/// Reads a boolean setting, treating anything unset or unreadable as `default`.
///
/// A settings row is not worth failing a launch over: a corrupt value means
/// the user gets the default surface, not a chat that will not start.
fn boolean_setting(connection: &Connection, key: &str, default: bool) -> bool {
    let stored: Option<String> = connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .and_then(|mut statement| {
            statement
                .query_row(params![key], |row| row.get(0))
                .optional()
        })
        .unwrap_or(None);
    stored
        .and_then(|value| serde_json::from_str::<bool>(&value).ok())
        .unwrap_or(default)
}

fn set_boolean_setting(connection: &Connection, key: &str, value: bool) -> ArgmaxResult<()> {
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![key, value.to_string(), now_iso()])
        .map_err(sqlite_error)?;
    Ok(())
}

/// Whether new launches carry the browser tools. On unless the user turned
/// them off: the browser is a feature of the app, not an opt-in.
pub fn browser_tools_enabled(connection: &Connection) -> bool {
    boolean_setting(connection, BROWSER_TOOLS_KEY, true)
}

pub fn set_browser_tools_enabled(connection: &Connection, enabled: bool) -> ArgmaxResult<()> {
    set_boolean_setting(connection, BROWSER_TOOLS_KEY, enabled)
}

/// On with automatic switching unless the user chose otherwise. It only runs
/// once a Jev key is saved, which is its own opt-in.
pub fn project_check_mode(connection: &Connection) -> ProjectCheckMode {
    connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .and_then(|mut statement| {
            statement
                .query_row(params![PROJECT_CHECK_KEY], |row| row.get::<_, String>(0))
                .optional()
        })
        .unwrap_or(None)
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or(ProjectCheckMode::Switch)
}

pub fn set_project_check_mode(connection: &Connection, mode: ProjectCheckMode) -> ArgmaxResult<()> {
    let value = serde_json::to_string(&mode).map_err(super::json_error)?;
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![PROJECT_CHECK_KEY, value, now_iso()])
        .map_err(sqlite_error)?;
    Ok(())
}

/// The user's app-wide branch template, or `None` for Argmax's built-in
/// default. An unreadable value reads as unset: a launch is not worth failing
/// over a corrupt row.
pub fn branch_template(connection: &Connection) -> Option<String> {
    connection
        .prepare_cached("SELECT value_json FROM ui_state WHERE key = ?")
        .and_then(|mut statement| {
            statement
                .query_row(params![BRANCH_TEMPLATE_KEY], |row| row.get::<_, String>(0))
                .optional()
        })
        .unwrap_or(None)
        .and_then(|value| serde_json::from_str::<String>(&value).ok())
        .filter(|template| !template.is_empty())
}

/// Saves the app-wide template after validating it. `None` clears it.
pub fn set_branch_template(connection: &Connection, template: Option<&str>) -> ArgmaxResult<()> {
    let Some(template) = template else {
        connection
            .prepare_cached("DELETE FROM ui_state WHERE key = ?")
            .map_err(sqlite_error)?
            .execute(params![BRANCH_TEMPLATE_KEY])
            .map_err(sqlite_error)?;
        return Ok(());
    };
    crate::workspaces::branch_names::validate_branch_template(template)?;
    let value = serde_json::to_string(template).map_err(super::json_error)?;
    connection
        .prepare_cached(
            "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        )
        .map_err(sqlite_error)?
        .execute(params![BRANCH_TEMPLATE_KEY, value, now_iso()])
        .map_err(sqlite_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::database::Database;

    #[test]
    fn browser_tools_are_on_until_the_user_turns_them_off() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();

        assert!(browser_tools_enabled(&connection));

        set_browser_tools_enabled(&connection, false).expect("write");
        assert!(!browser_tools_enabled(&connection));

        set_browser_tools_enabled(&connection, true).expect("write");
        assert!(browser_tools_enabled(&connection));
    }

    #[test]
    fn an_unreadable_value_reads_as_the_default_rather_than_failing() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();
        connection
            .execute(
                "INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)",
                params![BROWSER_TOOLS_KEY, "not-a-bool", now_iso()],
            )
            .expect("seed");

        assert!(browser_tools_enabled(&connection));
    }

    #[test]
    fn project_check_switches_until_the_user_picks_a_mode() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();

        assert_eq!(project_check_mode(&connection), ProjectCheckMode::Switch);
        set_project_check_mode(&connection, ProjectCheckMode::Off).expect("write");
        assert_eq!(project_check_mode(&connection), ProjectCheckMode::Off);
        set_project_check_mode(&connection, ProjectCheckMode::Suggest).expect("write");
        assert_eq!(project_check_mode(&connection), ProjectCheckMode::Suggest);
    }

    #[test]
    fn branch_template_is_unset_until_saved_and_validated_on_save() {
        let database = Database::open_in_memory().expect("database");
        let connection = database.connection();

        assert_eq!(branch_template(&connection), None);
        set_branch_template(&connection, Some("adam/{type}-{slug}")).expect("write");
        assert_eq!(
            branch_template(&connection).as_deref(),
            Some("adam/{type}-{slug}")
        );

        assert!(set_branch_template(&connection, Some("adam/{bogus}")).is_err());
        assert_eq!(
            branch_template(&connection).as_deref(),
            Some("adam/{type}-{slug}"),
            "a rejected save keeps the previous template"
        );

        set_branch_template(&connection, None).expect("clear");
        assert_eq!(branch_template(&connection), None);
    }
}
