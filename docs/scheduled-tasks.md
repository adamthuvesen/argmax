# Scheduled Tasks

Scheduled tasks ("routines") are stored prompts launched as top-level sessions on a schedule. The scheduler runs locally in the Tauri process and spawns provider CLIs directly.

## Components and Structure

| Piece | File |
|---|---|
| Panel UI | [ScheduledTasksPanel.tsx](../src/renderer/components/scheduled/ScheduledTasksPanel.tsx) |
| Schedule mapping | [schedule.ts](../src/renderer/lib/schedule.ts) |
| Scheduler loop | [scheduler.rs](../src-tauri/src/routines/scheduler.rs) |
| Cron parsing & calculations | [schedule.rs](../src-tauri/src/routines/schedule.rs) |
| SQLite persistence | [routines.rs](../src-tauri/src/persistence/routines.rs) (table `routines`, migration v19) |
| IPC channels | [ipc/routines.rs](../src-tauri/src/ipc/routines.rs) (`routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, `routines:run-now`) |

## Scheduler Behavior

The scheduler ticks every 30 seconds. Due tasks launch sequentially via `session_control::launch_with_spec`.

- **Missed runs:** If the app was closed during scheduled run times, backlog collapses into a single run.
- **Failures:** Recurring tasks back off by 15 minutes on launch failure. One-shot tasks are disabled with `last_error` recorded.
- **Permissions:** Scheduled tasks always run in `auto-approve` / `auto` mode without interactive prompts.
- **Targeting:** Isolated worktrees are the default target; scratch projects are rejected.
