# Scheduled Tasks

Scheduled tasks ("routines") are stored prompts launched as top-level sessions on a schedule. The scheduler runs locally in the Tauri process and spawns provider CLIs directly.

## Components and Structure

| Piece | File |
|---|---|
| Panel UI | [ScheduledTasksPanel.tsx](../src/renderer/components/scheduled/ScheduledTasksPanel.tsx) |
| Standalone rail | [ScheduleRail.tsx](../src/renderer/components/scheduled/ScheduleRail.tsx) |
| Schedule mapping | [schedule.ts](../src/renderer/lib/schedule.ts) |
| Scheduler loop | [scheduler.rs](../src-tauri/src/routines/scheduler.rs) |
| Cron parsing & calculations | [schedule.rs](../src-tauri/src/routines/schedule.rs) |
| SQLite persistence | [routines.rs](../src-tauri/src/persistence/routines.rs) (table `routines`, migration v19) |
| IPC channels | [ipc/routines.rs](../src-tauri/src/ipc/routines.rs) (`routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, `routines:run-now`, `routines:reset-session`) |

The page is standalone. Opening it swaps the app sidebar for a back rail and uses the same content chrome as settings. The title sits in the column, not the window topbar.

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
- **Permissions:** New scheduled chats use their provider’s choice in Settings → Agents → Permissions. Provider defaults honors native configuration, and native approval requests wait in the chat. Follow-ups retain the existing chat’s stored permission choice.
- **Agents:** a chat can schedule a wake for itself with `schedule_followup`, see its project's tasks with `schedule_list`, and stop one with `schedule_cancel` — deleting it, or pausing it, which `schedule_resume` undoes. Writing and editing tasks stays in the panel. An open panel does not know about it, and shows the change on its next load. See [agent-tools.md](agent-tools.md).
- **Targeting:** Each task picks where a run lands — a fresh chat in the shared checkout (`new_session`), a follow-up in the same chat every time (`same_session`, tracked by `last_session_id`), or a fresh isolated worktree (`worktree`, the default). Same-chat tasks send follow-ups via `ProvidersSendInput`; if the chat is gone, the next run starts fresh and re-points the routine. Use `routines:reset-session` (or **Fresh chat next run** in the panel) to drop the pointer deliberately.
- **A busy shared chat defers the run.** A same-chat follow-up goes in as a turn of its own, through `send_scheduled_input`, which refuses rather than joins the chat's follow-up queue while a turn is running. Nothing is recorded: the row keeps its past `next_run_at`, stays due, and fires on the first tick after the chat settles, collapsing the intervening ticks into that one run. A run the *user* asked for with **Run now** fails with `ROUTINE_CHAT_BUSY` instead of deferring silently, since a button press that starts nothing has to say why. The queue is the person's — a scheduled prompt sitting in it reads as something they typed, blocks move and archive, and stacks another copy on the next tick.
