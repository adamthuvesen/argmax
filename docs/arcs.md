# Arcs

An Arc is a long-lived body of work: a feature, a migration, an app. It outlives any one chat and may span several projects. Argmax keeps it thin on purpose. The Arc names the work, holds its shared context, and points at a coordinator chat; the coordinator does the planning, and Argmax only launches, limits, and wakes it. See [CONTEXT.md](../CONTEXT.md) for Arc, Coordinator, Member, and Arc folder.

## Using one

**New arc** in the sidebar's Arcs section asks for a name, a brief, a home project, and the coordinator's model, with an optional existing folder. Creating it writes the arc folder and launches the coordinator in the home project's shared checkout. The Arc page shows the brief (saved to `BRIEF.md`), the folder, the coordinator, the members, and the triggers, with Pause, Mark done, and New coordinator.

A brief is required. When the chosen folder already has a `BRIEF.md`, leave the brief empty and the file is used (`ARC_BRIEF_EXISTS` otherwise; `ARC_BRIEF_REQUIRED` when there is neither). Pointing an Arc at an existing folder is how a folder kept elsewhere, such as an hq mission, becomes its shared context.

## How it works

| Piece | Where |
|---|---|
| `arcs` table, `sessions.arc_id` (v51); `routines.arc_id` + `arc_coordinator` target (v52) | [data.md](data.md#arcs) |
| Persistence, caps, member summaries | [persistence/arcs.rs](../src-tauri/src/persistence/arcs.rs) |
| Coordinator launch and preambles | [arcs/mod.rs](../src-tauri/src/arcs/mod.rs), [arcs/preamble.rs](../src-tauri/src/arcs/preamble.rs) |
| `arc:*` IPC channels | [ipc/arcs.rs](../src-tauri/src/ipc/arcs.rs), [ipc.md](ipc.md#arcs) |
| Inheritance, caps, `arc_status` | [agent-tools.md](agent-tools.md#arcs) |
| PR/CI events to the coordinator | [gh.md](gh.md#arc-prci-events) |
| Scheduled runs into the coordinator | [scheduled-tasks.md](scheduled-tasks.md) |
| Sidebar section, Arc page, New arc dialog | [components/arcs](../src/renderer/components/arcs) |

**The coordinator is a pointer.** `arcs.coordinator_session_id` names an ordinary session. Its prompt tells it to plan and delegate, keep `NOTES.md`, and leave implementation to members. New coordinator launches a fresh chat seeded from `BRIEF.md` and `NOTES.md` and repoints the Arc; the old chat keeps its `arc_id` as history. Expect to rotate a coordinator after weeks of work, since its context degrades. See [ADR 0009](adr/0009-a-coordinator-is-a-disposable-session.md).

**Members inherit.** `session_launch` and `/multitask` from an Arc session carry `arc_id` onto the new session and prepend the member preamble. `session_move` carries it and repoints the coordinator if the coordinator moved. A fork leaves the Arc.

**One writer.** The coordinator is the only writer of the arc folder. Members read `BRIEF.md` and `NOTES.md` and end their final answer with learnings, which reach the coordinator in the completion notice. See [ADR 0010](adr/0010-arc-context-is-files-with-one-writer.md).

**Caps.** An Arc allows 8 active members and 40 launches in a rolling 24 hours. The current coordinator is exempt from the ordinary ten-launches-per-session cap. The checks run in the same write as the session insert, so parallel launches cannot overrun them. A done Arc refuses launches.

**Triggers.** A member's PR that starts failing, starts passing, or merges sends one message to the coordinator. While the Arc is live and that message was delivered, the ordinary check-failure follow-up stands down for that PR. Scheduled tasks can target the Arc's coordinator. A paused Arc silences both. See [ADR 0011](adr/0011-arc-events-replace-check-failure-follow-ups.md).

## Not in this version

Slack triggers, agents writing recurring schedules, turning an existing chat into a coordinator, and the phone app.

## Limits

- A member whose workspace is archived before its PR resolves leaves the poll set, so the coordinator does not hear about that PR's later transitions.
- The Arc page opens only member chats still in the sidebar's recent list; older members are listed without an open action.
