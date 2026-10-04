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

## Linked repositories

Settings → Projects → Linked repositories has a **Connect repository…** button. It opens the native folder picker and connects the selected directory without registering another project. Agents may read and edit that checkout. Each entry has a **name** (lowercase letters, digits, `-`, `_`, `.`, at most 40 characters, unique in the project) and a **canonical root**. The picker derives the name from the directory. The existing add API also accepts a custom name. Adding one resolves the path with `canonicalize` and rejects, with a specific message, a relative or missing path, a file, the filesystem root, the home folder or any folder that contains it (`/Users`), a root that is, contains, or sits inside the project's own checkout, a duplicate name or root, and more than 10 per project. Each can be switched off or removed. This is the allowlist: nothing outside a stored root is ever readable through it, and the table is separate from project sources, which stay project-relative files and URLs.

After connecting, Argmax automatically generates a concise **summary** with the first available provider's existing helper model. The helper receives a bounded sample of root documentation, manifests, and directory names. It has no tools and cannot explore or edit the checkout. The sample selects documentation and manifests rather than scanning the whole checkout. It uses the same confined path resolution as linked reads. The summary has at most 600 characters and is saved in SQLite. It describes the repository, rather than giving instructions or claiming a relationship to another project. Names, roots, and available summaries reach every launch and `sources_list`. Summary generation does not block connecting. A failed generation leaves the link and any previous summary intact, shows an error, and offers Retry. Existing links can generate a summary. **Regenerate summary** refreshes it explicitly. There is no file configuration or background refresh.

What an agent gets, per launch (the roots are read from the database each time, so a follow-up sees today's settings):

- **Claude:** one `--add-dir <root>` per enabled root, built in `claude_common_args`, so fresh, resumed, and control-channel launches all carry it. Claude Code does not load `CLAUDE.md` from `--add-dir` directories by default; its memory docs name `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` as the switch, and Argmax sets exactly that in the provider environment (both spawn paths) when there is at least one root. That is the only mechanism: Argmax never reads a linked repository's `CLAUDE.md` into the prompt, so nothing loads twice.
- **Every provider:** a `<argmax-linked-repositories>` block ahead of the prompt, after the routing instruction, naming each root. It exists only on a launch that carries the Argmax server, and not on a slash command, which must stay at byte zero. For a non-Claude provider it explains that no native workspace root is added. Agents can use source tools for reads and normal file or shell tools for edits, subject to session permissions. [`strip_instruction`](../src-tauri/src/providers/mcp_injection.rs) removes the block from imported transcripts.
- **The agent tools:** `sources_list` also returns the enabled roots as `linkedRepos`, and takes `linked_repo` (and `path`) to list a directory; `sources_read` takes `linked_repo` and `path` to read a file. See [agent-tools.md](agent-tools.md).

**Linked repositories support reading and editing for the task, subject to session permissions and each repository's instructions.** `sources_list` and `sources_read` confine reads to the stored roots. Nothing confines the agent's own shell: under the default auto-approve permission mode every provider runs without a sandbox (Codex with `--dangerously-bypass-approvals-and-sandbox` or `danger-full-access`), and the prompt block hands the agent each root's absolute path, so any agent can read and edit a linked root with its shell. `--add-dir` grants Claude Code edit access with read access, and Argmax cannot narrow that. What Argmax adds beyond the shell is a named, listed entry point and (for Claude) the loaded `CLAUDE.md`. Codex's `runtimeWorkspaceRoots` is not used, so the Codex, Cursor, OpenCode and Grok launches carry no native workspace-root setting for a linked root. The ACP and app-server paths pass only the working directory. Argmax reads a linked root on demand (`files/linked_roots.rs`) and **never attaches a filesystem watcher to one**; the only watcher is the per-workspace one in `workspaces/watcher.rs`.

Path rules for reads: the path is relative; an absolute path, any `..`, a NUL byte, and any `.git` component (spelled or reached through a symlink inside the root) are refused; the resolved path must still be under the stored root after symlinks resolve, and the root itself must still resolve to the stored canonical path (a directory swapped for a symlink is `LINKED_REPO_ROOT_CHANGED`). Files use the same 1 MiB and binary limits as workspace previews. A launch leaves out a root that is gone or has moved rather than hand a provider a path the user did not approve. Secrets such as `.env` files inside a linked root are not filtered.

- Persistence: `src-tauri/src/persistence/project_sources.rs` (sources), `src-tauri/src/persistence/linked_repos.rs` (linked repositories).
- IPC: `linked-repos:list`, `linked-repos:add`, `linked-repos:pick-folder`, `linked-repos:summarize`, `linked-repos:set-enabled`, `linked-repos:remove`, all desktop-only.
- IPC: `sources:list`, `sources:add`, `sources:update`, `sources:delete`.
- Agent tools: `sources_list`, `sources_add`, `sources_read`.
