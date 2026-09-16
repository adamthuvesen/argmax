# Arc context is files with one writer

An Arc's shared context — the brief, what agents learned about the codebase, how the user wants work done — has to reach agents in several repositories running five different CLIs. It lives in files: an arc folder holding `BRIEF.md` and `NOTES.md`. Every provider can read a file with the tools it already has, the person can open and edit it, and an existing folder such as an hq mission can be adopted as-is.

The alternative was database rows behind `arc_note` and `arc_read` agent tools. That would have been a second memory system beside project learnings, with its own schema, tools, and prompt cost on every turn, and it would have hidden the context from the person behind the app.

Files bring one real hazard: several agents appending to `NOTES.md` at once, from CLIs with different write strategies, truncate each other. The rule that removes it is a single writer. The coordinator is the only session that writes to the arc folder. Members read `BRIEF.md` and `NOTES.md` and end their final answer with the learnings worth keeping; the completion notice carries that answer to the coordinator, which decides what goes into the notes. The rule is stated in both preambles. It also removes the question of whether a member's sandbox allows writes outside its checkout, since members only read there.

The brief has one source of truth. When an Arc adopts a folder that already has a `BRIEF.md`, the file wins and a typed brief is refused rather than silently diverging from it.
