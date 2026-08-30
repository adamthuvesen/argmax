# Scheduled Tasks

Scheduled tasks ("routines") are stored prompts that Argmax launches as normal top-level sessions on a schedule. Everything is local: the scheduler runs inside the app process and spawns the provider CLIs exactly like a manual launch does. No cloud agents, no external cron.

## Where things live

| Piece | File |
|---|---|
| Panel UI (rail entry: Schedule) | [ScheduledTasksPanel.tsx](../src/renderer/components/scheduled/ScheduledTasksPanel.tsx) |
| Friendly schedule controls ↔ cron mapping | [schedule.ts](../src/renderer/lib/schedule.ts) |
| Scheduler loop + launch-or-backoff policy | [scheduler.rs](../src-tauri/src/routines/scheduler.rs) |
| Cron parsing, next-occurrence math, once-time normalization | [schedule.rs](../src-tauri/src/routines/schedule.rs) |
| SQLite repository (table `routines`, migration v19) | [routines.rs](../src-tauri/src/persistence/routines.rs) |
| IPC: `routines:list`, `routines:upsert`, `routines:delete`, `routines:set-enabled`, `routines:run-now` | [ipc/routines.rs](../src-tauri/src/ipc/routines.rs) |

The rail entry and the `Open Schedule` palette action both open the panel. It shares the workspace slot with Settings, so `useOverlays` closes one when the other opens — every navigation site in `App` already dismisses Settings, which is what keeps the panel from stranding itself over the session grid.

The scheduler spawns in `lib.rs` setup next to the session-sync sweep. It ticks every 30 seconds, pulls `db`/`workspaces`/`providers` from `AppState` per tick (so it is safe before boot finishes), and fires due rows sequentially. Launches go through `session_control::launch_with_spec`, the shared tail also used by the `session launch` socket protocol.

## Panel

Two screens share the workspace slot: a list and a full-page editor. The list is one row per task — a state dot, name, repository and model, then the cadence and a relative countdown ("in 9h", "due", "Paused", "Last run failed"); run/edit/delete/pause appear over the right edge on hover or focus. The editor is a single column of label→control rows: Name and Prompt, then When (Repeats, plus whichever of Time / Minute / Day / Run at / Cron the chosen kind needs) and Where (Repository, Agent, Model, isolated worktree). Every choice is a dropdown rather than a row of chips, so the six rows share one right edge. Under When, `describeCadence` reads the schedule back as a sentence — "Runs **every Monday at 09:00** in argmax" — so the six cron fields never have to be decoded by eye.

## Schedule model

Each row stores exactly one of:

- `cron_expr` — six-field cron (`cron` crate dialect: sec min hour dom month dow [year]). Day-of-week is 1–7 with **1 = Sunday**; the UI generates weekday names (`Mon`, `Tue`, …) for readability.
- `run_once_at` — an RFC 3339 UTC timestamp, normalized at upsert. Naive `datetime-local` input values are interpreted in the user's local timezone.

`next_run_at` is always maintained by Rust so the tick and the panel read due-ness without recomputing. All stored timestamps use UTC millisecond precision, which keeps the lexicographic `next_run_at <= now` comparison correct.

## Missed-run and failure policy

- **App closed or asleep at fire time:** timers do not run while the process is dead. The next occurrence is computed strictly after the fire time, so any backlog collapses into a single late run. One-shots in the past fire once on the next tick and then disable themselves.
- **Launch failure (recurring):** `next_run_at` is pushed back 15 minutes and `last_error` is surfaced inline in the panel, so a broken routine can never retry on every tick.
- **Launch failure (one-shot):** the row is disabled with the error shown; `routines:run-now` retries deliberately.
- **Run-now on a paused task:** it launches and records `last_run_at`, then stays paused. `RoutineLaunchFields` carries the row's `enabled` state precisely so recording the outcome cannot resume a routine the user turned off.
- **Concurrency guard:** the tick loop is the guard. Several routines due in the same tick launch one after another instead of stampeding worktree creation.
- **Repository removed:** `routines.project_id` cascades like every other `projects(id)` reference, so `projects:remove` takes that repository's scheduled tasks with it instead of failing on the constraint.

## Panel refresh

The panel reads `routines:list` on mount and then re-reads once the soonest enabled `next_run_at` has passed (plus one scheduler tick). There is no recurring poll: each reload re-arms the timer from the rows it just read, so an idle panel is idle.

## Permission mode

Scheduled runs are always `permission_mode=auto-approve` / `agent_mode=auto`, hardcoded in `scheduler.rs`. The row stores no mode columns and the panel offers no choice: nobody is watching a scheduled run, so an approval prompt would hang the session until someone noticed it. Isolated worktrees are the default target, and the scratch side-chats project is rejected at upsert.

## Remote / mobile

All `routines:*` channels are listed in `REMOTE_UNSUPPORTED_CHANNELS` for now; the panel is desktop-only. The mobile surface can gain a read-only view later by dropping `routines:list` from that list.
