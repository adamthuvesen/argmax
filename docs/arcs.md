# Arcs

An Arc is a long-lived body of work: a feature, a migration, an app. It outlives any one chat and may span several projects. Argmax keeps it thin on purpose. The Arc names the work, holds its shared context, and points at a coordinator chat; the coordinator does the planning, and Argmax only launches, limits, and wakes it. See [CONTEXT.md](../CONTEXT.md) for Arc, Coordinator, Member, and Arc folder.

## Using one

**New arc** in the sidebar's Arcs section asks for a name, a brief, a home project, and the coordinator's model, with an optional existing folder. Creating it writes the arc folder and launches the coordinator in the home project's shared checkout. **Start an arc from this chat…** in a chat's actions menu does the same from work already under way: the chat becomes the coordinator, a one-shot helper drafts the name and brief from its conversation (never overwriting a field you have typed into), and the chats it launched join the arc. It is unavailable while the chat's turn is running.

The Arc page opens with the name, a meta line led by the state, and the brief's first paragraph with an Edit action. A Chats ledger follows: the coordinator as its first row, then the members still working, with the working and pull request counts in its header. The timeline follows, then the folder and triggers.

A brief is required. When the chosen folder already has a `BRIEF.md`, leave the brief empty and the file is used (`ARC_BRIEF_EXISTS` otherwise; `ARC_BRIEF_REQUIRED` when there is neither). Pointing an Arc at an existing folder is how a folder kept elsewhere, such as an hq mission, becomes its shared context.

## How it works

| Piece | Where |
|---|---|
| `arcs` table, `sessions.arc_id` (v51); `routines.arc_id` + `arc_coordinator` target (v52) | [data.md](data.md#arcs) |
| Persistence, caps, member summaries | [persistence/arcs.rs](../src-tauri/src/persistence/arcs.rs) |
| Timeline (`arc_events`, v53) and `arc:timeline` | [persistence/arc_events.rs](../src-tauri/src/persistence/arc_events.rs), [ArcTimeline.tsx](../src/renderer/components/arcs/ArcTimeline.tsx) |
| Starting from a chat (`arc:draft-from-session`, `arc:promote`) | [arcs/mod.rs](../src-tauri/src/arcs/mod.rs) `promote_session`, [one_shot.rs](../src-tauri/src/providers/one_shot.rs) `draft_arc` |
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

**The timeline is recorded, not derived.** Chats get deleted and coordinator repoints, brief edits, state changes, and `NOTES.md` edits leave no other trace, so each write point appends one `arc_events` row with a deterministic id: arc created, coordinator started (new, replaced, or started from a chat), member launched or joined, member finished with the opening of its answer, PR checks failing or passing or merged (only once the coordinator has the message), brief edited, state changed, and a scheduled run. A coordinator turn leaves a row only when it changed `NOTES.md`: the row carries the line diff, the first new section heading, and the opening of the coordinator's answer as its reasoning. Turns that wrote nothing down are not part of the story. Rows keep their session and project ids without a foreign key, so they outlive the chats they describe.

**Starting from a chat** runs in one write transaction: create the arc in the chat's project, point it at the chat, and attach up to 8 sessions the chat launched whose workspaces are still around. The chat then gets its new role as a visible Argmax notice, since no provider can change a running conversation's instructions any other way. A promoted coordinator can live in its own worktree; archiving that worktree ends it, and New coordinator recovers.

**Triggers.** A member's PR that starts failing, starts passing, or merges sends one message to the coordinator. While the Arc is live and that message was delivered, the ordinary check-failure follow-up stands down for that PR. Scheduled tasks can target the Arc's coordinator. A paused Arc silences both. See [ADR 0011](adr/0011-arc-events-replace-check-failure-follow-ups.md).

## On the phone

The iPhone app lists live arcs (active, then paused, most recently touched first) in an **Arcs** section above Pinned. Done arcs stay on the Mac. A chat that belongs to an arc wears a small arc glyph on its second line. The Arc screen ([ios/Argmax/Sources/Arcs](../ios/Argmax/Sources/Arcs)) opens the coordinator and the members working now, shows the stats, the brief, and the timeline with Show earlier, and its ⋯ menu pauses, resumes, or marks the arc done. It reads `arc:get` and `arc:timeline`, which are in `remoteReadChannels.json`. The screen refetches when the dashboard's arc row or any arc session's state moves, the same keys the desktop page follows, so nothing polls. Creating an arc, starting from a chat, starting a new coordinator, renaming, editing the brief, reopening a done arc, and triggers are desktop-only.

A Mac built before the arc reads joined the manifest refuses them for want of an operation id. The phone answers `REMOTE_OPERATION_REQUIRED` on any read by sending it once more under a throwaway operation id, so an older Mac still serves the Arc screen and only journals the read.

## Not in this version

Slack triggers and agents writing recurring schedules.

## Limits

- A member whose workspace is archived before its PR resolves leaves the poll set, so the coordinator does not hear about that PR's later transitions.
- The Arc page opens only member chats still in the sidebar's recent list; older members are listed without an open action.
