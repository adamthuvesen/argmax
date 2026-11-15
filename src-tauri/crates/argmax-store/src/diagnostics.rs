//! Read-only numbers for `system:diagnostics`. A failed read reports a neutral
//! value, because a diagnostics page must not fail on the thing it diagnoses.

use rusqlite::Connection;

pub fn sqlite_version(connection: &Connection) -> String {
    connection
        .query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "unknown".to_string())
}

pub fn count_rows(connection: &Connection, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

pub fn pragma_i64(connection: &Connection, name: &str) -> i64 {
    let sql = format!("PRAGMA {name}");
    connection
        .query_row(&sql, [], |row| row.get::<_, i64>(0))
        .unwrap_or(0)
}

pub fn pragma_string(connection: &Connection, name: &str) -> String {
    let sql = format!("PRAGMA {name}");
    connection
        .query_row(&sql, [], |row| row.get::<_, String>(0))
        .unwrap_or_else(|_| "unknown".to_string())
}
