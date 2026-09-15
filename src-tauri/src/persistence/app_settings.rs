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

use crate::error::ArgmaxResult;

use super::{sqlite_error, time::now_iso};

/// Whether an agent's `argmax` MCP server carries the browser tools.
const BROWSER_TOOLS_KEY: &str = "agent.browser_tools.enabled";

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
}
