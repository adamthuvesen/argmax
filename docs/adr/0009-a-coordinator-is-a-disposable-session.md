# A coordinator is a disposable session named by a pointer

An Arc needs one chat that plans the work and launches the rest. The tempting shapes are a role column on `sessions` or a special session kind with its own permissions. Both are worse than a pointer. A role column allows zero or two coordinators per Arc and needs a uniqueness rule the pointer gives for free. A special kind would need its own launch path, its own resume rules, and its own permission handling across five providers, for a restriction no provider can enforce anyway.

So `arcs.coordinator_session_id` names an ordinary session. Everything that works on a chat works on the coordinator: resume, move, stop, goals, the inbox. "Plans and delegates, never codes" lives in its prompt. It is a contract, not a permission, and the coordinator could write code if it ignored the prompt. That is accepted: the cost of a coordinator that edits a file is small, and the cost of a permission layer that each provider honours differently is not.

The coordinator is also disposable. Weeks of work fill and compact any provider's context, and a degraded coordinator is worse than a fresh one that reads the notes. The durable state therefore lives in the arc folder, not in the transcript. Starting a new coordinator is the ordinary rotation path, not error recovery: it launches from `BRIEF.md` and `NOTES.md`, repoints the Arc, and leaves the old chat as history with its `arc_id` intact.

The caps follow the pointer. Only the session the pointer names is exempt from the ten-launches-per-session limit, so a rotated-out coordinator is an ordinary member again.
