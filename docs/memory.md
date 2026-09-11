# Project Learnings

Argmax stores project-scoped learnings in SQLite for review across sessions.

- [src-tauri/src/persistence/learnings.rs](../src-tauri/src/persistence/learnings.rs): Persistence and FTS5 full-text search.
- IPC channels: `learnings:list`, `learnings:update`, `learnings:delete`.

Use docs or skills for persistent repository instructions; use learnings for project-specific facts discovered during agent execution.

## Project sources

Settings → Projects → Project sources stores references to repository files and
HTTP(S) pages, with a title and guidance on when to consult each one. The library
belongs to the project and is shared across its chats. Users can edit or remove
references. Agents can add references through `sources_add` without overwriting
an existing entry at the same location.

The agent receives guidance to list sources at the beginning of relevant project
work, then read the relevant entries through `sources_read`. This is agent
instruction, not a guarantee that every provider will consult every source.
Listing returns metadata only. Content is retrieved on demand, not injected into
every prompt or saved as a document cache. Repository paths resolve inside the
calling chat's current checkout, so a worktree reads its own version. URL reads
use the chat's browser and can fail if a page needs authentication or does not
expose readable content.

Successful reads produce an expandable **Read source** entry in the desktop
conversation. It records the source metadata at the time of retrieval, the actual
location, retrieval time, and truncation status. New agent additions produce
**Added source** entries. Failed reads and listings do not produce successful-read
entries. These entries record that the tool read that source and location at
that time. They do not retain the exact returned contents or establish which
version was read, whether the model relied on it, or whether its claims were
verified. Reads through unrelated provider
tools retain their ordinary tool-call display and are not attributed to this
library automatically.

Keep durable explanations in maintained project documents and register those
paths here. Agents can update those documents using their normal editing tools.
A source's creation or edit date describes its reference metadata, not the age
or correctness of its contents. The library has no automatic claim verification
or background refresh. Remove obsolete references and update their source
documents as decisions change.

Engram remains an optional provider integration, configured separately in
Settings → Integrations. Project sources work without it. Sources retain links
to primary material, while learnings and Engram retain selected facts or
conclusions. Neither should override current code or primary evidence.

- Persistence: `src-tauri/src/persistence/project_sources.rs`.
- IPC: `sources:list`, `sources:add`, `sources:update`, `sources:delete`.
- Agent tools: `sources_list`, `sources_add`, `sources_read`.
