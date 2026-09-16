# Scheduled Tasks

Scheduled tasks ("routines") are stored prompts launched as top-level sessions on a schedule. The scheduler runs locally in the Tauri process and spawns provider CLIs directly.

## Components and Structure

| Piece | File |
|---|---|
| Panel UI | [ScheduledTasksPanel.tsx](../src/renderer/components/scheduled/ScheduledTasksPanel.tsx) |
| Schedule mapping | [schedule.ts](../src/renderer/lib/schedule.ts) |
| Scheduler loop | [scheduler.rs](../src-tauri/src/routines/scheduler.rs) |
| Cron parsing & calculations | [schedule.rs](../src-tauri/src/routines/schedule.rs) |
| SQLite persistence | [routines.rs](../src-tauri/src/persistence/routines.rs) (table `routines`, migration v19; `created_by` in v50; `arc_id` + `arc_coordinator` target in v52) |
| IPC channels | [ipc/routines.rs](../src-tauri/src/ipc/routines.rs) (`routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, `routines:run-now`, `routines:reset-session`) |

The page opens in the workspace with the app sidebar still beside it, using the same content chrome as settings. The title sits in the column, not the window topbar. Esc, or any sidebar row, leaves it.

## Scheduler Behavior

The scheduler ticks every 30 seconds. Due tasks launch sequentially via `session_control::launch_with_spec`.

The scheduler and Run now share a per-routine launch claim. An overlapping
request cannot launch the same task twice, while different tasks can still run
independently. Each tick rechecks the schedule after claiming it so a completed
manual run, an edit, or a deletion invalidates an older due-list entry. Claims
release when the request finishes or is cancelled.

Run settlement also checks that the task has not changed while provider launch
or follow-up work was awaiting. A pause, reschedule, target change, or shared-chat
reset made during that window is preserved. A newly launched shared-chat pointer
is stored in the same conditional settlement.

- **Missed runs:** If the app was closed during scheduled run times, backlog collapses into a single run.
- **Failures:** Recurring tasks back off by 15 minutes on launch failure. One-shot tasks are disabled with `last_error` recorded.
- **Spent one-shots:** A one-shot the user wrote is disabled once it fires, so the list keeps showing what ran. A wake a chat set for itself (`created_by = 'agent'`) is deleted instead — the chat it woke holds the record, and a paused row nobody wrote just accumulates. Failures never take that path: they stay on the list with their error. The delete carries the same `updated_at` token as a run settlement, so an edit made while the launch was awaiting keeps the row.
- **Permissions:** New scheduled chats use their provider’s choice in Settings → Agents → Permissions. Provider defaults honors native configuration, and native approval requests wait in the chat. Follow-ups retain the existing chat’s stored permission choice.
- **Agents:** a chat can schedule a wake for itself with `schedule_followup`, see its project's tasks with `schedule_list`, and stop one with `schedule_cancel` — deleting it, or pausing it, which `schedule_resume` undoes. `schedule_list` reports `createdBy`, so an agent can tell its own wakes from the user's tasks and delete rather than pause them. Writing and editing tasks stays in the panel. An open panel does not know about it, and shows the change on its next load. See [agent-tools.md](agent-tools.md).
- **Targeting:** Each task picks where a run lands — a fresh chat in the shared checkout (`new_session`), a follow-up in the same chat every time (`same_session`, tracked by `last_session_id`), a fresh isolated worktree (`worktree`, the default), or a live Arc's coordinator (`arc_coordinator`, tracked by `arc_id`; see below). Same-chat tasks send follow-ups via `ProvidersSendInput`; if the chat is gone, the next run starts fresh and re-points the routine. Use `routines:reset-session` (or **Fresh chat next run** in the panel) to drop the pointer deliberately.
- **`arc_coordinator`:** resolves the named Arc's *current* coordinator fresh at every fire, not a cached session id, so repointing the Arc mid-schedule is picked up automatically. A paused or done Arc skips the occurrence — not a failure, the schedule just advances. An Arc with no live coordinator (missing, or its workspace archiving/archived — see [data.md](data.md#arcs)) records `last_error` "Arc has no coordinator" and backs off like a launch failure. A busy coordinator defers exactly like `same_session`. `routines:upsert` validates `arc_coordinator` against `ROUTINE_ARC_INVALID`: the Arc must exist and its `home_project_id` must match the routine's `project_id`. The panel's **Run in** picker offers "Arc coordinator" with an Arc select scoped to the chosen repository, and hides the Agent/Model pickers in favor of a note: this target wakes an existing chat rather than launching one, so `send_routine_follow_up` passes `provider`/`model_label`/`model_id` as `None` to `send_scheduled_input`, and the coordinator keeps whatever it is already running under — the routine's own stored provider/model (still shown for other targets) is not read for this one.
- **A busy shared chat defers the run.** A same-chat follow-up goes in as a turn of its own, through `send_scheduled_input`, which refuses rather than joins the chat's follow-up queue while a turn is running. Nothing is recorded: the row keeps its past `next_run_at`, stays due, and fires on the first tick after the chat settles, collapsing the intervening ticks into that one run. A run the *user* asked for with **Run now** fails with `ROUTINE_CHAT_BUSY` instead of deferring silently, since a button press that starts nothing has to say why. The queue is the person's — a scheduled prompt sitting in it reads as something they typed, blocks move and archive, and stacks another copy on the next tick.
