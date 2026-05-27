# Legacy Electron Migrations

The Tauri port intentionally starts a new app id (`com.argmax.rs`) and a fresh
user data directory, so it squashes the Electron database history into
`src-tauri/src/persistence/migrations.rs` migration `v1: initial_schema`.

This file preserves the archaeology needed to reason about that squash. The
legacy source of truth at the time of the Rust baseline is:

- `src/main/persistence/migrations.ts`
- `src/main/persistence/migrations.test.ts`

The squashed Rust migration covers Electron migrations `v1` through `v20`,
including:

- the original project/workspace/session/event/checkpoint/check schema
- schema migration checksum tracking and drift detection
- the destructive workspace/session relationship repair
- approvals, usage events, learnings, PR feedback, scoring policies, and
  tournament tables
- `learnings_fts` and `events_fts` sidecars and their insert/update/delete
  triggers

## Legacy Ledger

| Version | Name |
| --- | --- |
| v1 | `initial_local_product_state` |
| v2 | `schema_migrations_checksum` |
| v3 | `workspaces_check_constraints` |
| v4 | `sessions_provider_conversation_id` |
| v5 | `sessions_model_selection` |
| v6 | `sessions_cost_usage` |
| v7 | `dashboard_read_indexes` |
| v8 | `sessions_last_model_id` |
| v9 | `learnings_table` |
| v10 | `events_fts_sidecar` |
| v11 | `workspaces_pinned` |
| v12 | `projects_remote_and_gh_pr` |
| v13 | `usage_events_created_at_iso` |
| v14 | `sessions_permission_mode` |
| v15 | `sessions_agent_mode` |
| v16 | `tournaments` |
| v17 | `scoring_policies_seed` |
| v18 | `sessions_agent_mode_rename_edit_to_auto` |
| v19 | `gh_pr_state_and_notified_at` |
| v20 | `events_session_rowid_index` |

Future Rust migrations append after the squashed `v1`. Do not edit the squashed
SQL after it has shipped; write a new migration instead. If the Electron source
tree is removed during cutover, keep `src/main/persistence/migrations.ts` in git
history and use that file as the detailed per-version reference for import-tool
work or schema-forensics debugging.
