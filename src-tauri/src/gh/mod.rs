// GitHub PR status subsystem: `service.rs` performs live `gh pr view` reads
// and persistence; `poller.rs` refreshes open PR rows and publishes deltas.

pub mod poller;
pub mod service;

/// Re-read every workspace whose marker can change when this session refreshes
/// a PR, including other observers and isolated workspaces on its head branch.
pub(crate) fn workspaces_for_pr_refresh(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> crate::error::ArgmaxResult<Vec<crate::persistence::workspaces::WorkspaceSummary>> {
    let mut statement = connection
        .prepare_cached(
            r#"
            SELECT DISTINCT candidate.id
            FROM sessions source
            JOIN workspaces origin ON origin.id = source.workspace_id
            JOIN workspaces candidate ON candidate.project_id = origin.project_id
            WHERE source.id = ?1 AND (
                candidate.id = origin.id
                OR EXISTS (
                    SELECT 1 FROM gh_pr refreshed
                    WHERE refreshed.session_id = source.id AND (
                        (candidate.shared_workspace = 0
                         AND candidate.branch = refreshed.head_ref_name)
                        OR EXISTS (
                            SELECT 1 FROM sessions observer
                            JOIN gh_pr peer ON peer.session_id = observer.id
                            WHERE observer.workspace_id = candidate.id
                              AND peer.pr_number = refreshed.pr_number
                        )
                    )
                )
            )
            "#,
        )
        .map_err(crate::persistence::sqlite_error)?;
    let ids = statement
        .query_map([session_id], |row| row.get::<_, String>(0))
        .map_err(crate::persistence::sqlite_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(crate::persistence::sqlite_error)?;
    ids.iter()
        .map(|id| crate::persistence::workspaces::find_workspace_by_id(connection, id))
        .collect()
}
