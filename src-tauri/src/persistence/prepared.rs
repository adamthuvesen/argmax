use rusqlite::{CachedStatement, Connection, Result};

/// Single audit point for hot-path prepared statements.
///
/// `rusqlite::Connection::prepare_cached` owns the actual per-connection cache;
/// this wrapper keeps dashboard/session query sites consistent and easy to grep.
pub fn prepared<'conn>(connection: &'conn Connection, sql: &str) -> Result<CachedStatement<'conn>> {
    connection.prepare_cached(sql)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_wrapper_runs_cached_statement() {
        let connection = Connection::open_in_memory().expect("open db");
        let mut first = prepared(&connection, "SELECT 42").expect("prepare first");
        let value: i64 = first.query_row([], |row| row.get(0)).expect("query first");
        drop(first);

        let mut second = prepared(&connection, "SELECT 42").expect("prepare second");
        let value_again: i64 = second
            .query_row([], |row| row.get(0))
            .expect("query second");

        assert_eq!(value, 42);
        assert_eq!(value_again, 42);
    }
}
