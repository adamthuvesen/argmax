# Skills

Provider CLIs load skills directly from disk during execution. The `/` autocomplete menu in Argmax is a read-only index powered by `skills:list`.

## Discovery Directories

[src-tauri/src/skills/registry.rs](../src-tauri/src/skills/registry.rs) discovers skills across provider and workspace paths. Workspace skills take precedence over user skills:

| Provider | Workspace | User | Additional Paths |
|---|---|---|---|
| Claude | `.claude/skills`, `.agents/skills` | `~/.claude/skills`, `~/.agents/skills` | `~/.claude/plugins/cache` |
| Codex | `.codex/skills`, `.agents/skills` | `~/.codex/skills`, `~/.agents/skills` | `~/.codex/prompts`, `~/.codex/skills/.system`, plugins |
| Cursor | `.cursor/skills`, `.agents/skills` | `~/.cursor/skills`, `~/.agents/skills` | `~/.cursor/plugins/cache` |
| OpenCode | `.opencode/skills`, `.agents/skills` | `~/.config/opencode/skills`, `~/.agents/skills` | — |
| Grok Build | `.grok/skills`, `.agents/skills`, `.claude/skills` | `~/.grok/skills`, `~/.agents/skills`, `~/.claude/skills` | `~/.grok/installed-plugins`, `~/.grok/bundled/skills` |

Hidden dot-directories (e.g. `~/.codex/skills/.system`) are ignored to avoid double-counting internal skills.

For Auto follow-ups, the router uses this same cached discovery and source order to read skills invoked by the new request, or by recent user messages when the request continues earlier work. `/name` and `$name` are explicit invocations; a plain name counts when the user asks to use that skill or starts with an imperative such as “ship”. A casual mention does not load instructions. The bounded classifier context includes the selected `SKILL.md` and up to two directly referenced local Markdown files. Missing or clipped instructions block a capability reduction. These files describe the requested workflow to the classifier; they cannot issue router instructions. The public `skills:list` response remains the name, description, and source used by autocomplete.

## The `/` Menu

Typing `/` in either composer opens [SlashCommandMenu](../src/renderer/components/SlashCommandMenu.tsx), driven by [useSlashAutocomplete](../src/renderer/hooks/useSlashAutocomplete.ts). It has two sections.

**Composer commands** come first. Each surface passes its own list. The session composer offers Stop, Clear, Connections, Compact (not Cursor), Multitask, Goal, Attach file, Changes, and Worktree. The launcher offers Chat, Connections, Goal, Attach file, Project, Branch, and the worktree toggle. Goal appears on both surfaces when Goals is enabled in Settings. Most entries are a keyboard route to a control that already exists in that toolbar. `/clear`, `/mcp`, `/multitask`, and `/goal` are Argmax-owned actions whose home is the slash menu. Entries that would be a no-op right now are left out rather than shown disabled. Picking an action drops the `/token` it was summoned with, returns focus to the prompt, and runs the action. `/mcp` opens the connection inventory for the selected or active provider. Goal and Multitask insert their command prefix for you to complete. `/compact` inserts `/compact ` into the draft and Enter sends it as prompt text. Claude and Grok run it themselves. For Codex and OpenCode the Rust adapter turns the exact prompt `/compact` into `thread/compact/start` and `POST /session/{id}/summarize` ([inputs.rs](../src-tauri/src/providers/inputs.rs) `is_compact_command`), and the turn ends when the provider reports the compaction done. Arguments (`/compact focus on X`) are forwarded only by Claude and Grok. Cursor exposes no compact command over ACP, so it gets no entry.

The session composer also offers `/cloud <prompt>` in git workspaces for Claude, Codex, and Cursor. It opens the same hosted-task confirmation as the session actions menu, with the current prompt and inspectable bounded chat context. It is an Argmax composer command, so no provider skill installation is needed.

**Skills** follow under their own heading, queried from `skills:list` for the active provider and workspace, each badged with its source. Selecting one inserts `/{name} ` into the prompt, which the provider CLI evaluates at runtime. `/clear`, `/mcp`, and session `/cloud` never reach the provider. Argmax intercepts them even if you type one and press Enter.

Every `/token` naming a loaded skill is tinted as you type, wherever it sits in the draft ([slashHighlight.ts](../src/renderer/lib/slashHighlight.ts), applied as an editor decoration on the text itself). Both composers and the sent bubble use the shared `.skill-token` highlight for leading and inline invocations. The literal `/name`, capitalization, spaces, and line breaks survive sending. The highlight uses accent ink in the composer and the message foreground in the bubble for contrast. The transcript has no skills list to check against, so token shape is its only guard — paths like `/tmp/logs` and `/Users/adam/dev` fail it and stay plain.

A query prefix-matches command names and labels but substring-matches skill names: commands are a short curated list invoked by name, and a substring rule would leave them crowding the top of a skill query long after the user stopped meaning them. Arrow keys and Enter/Tab run the whole list; Escape drops the `/token`; a click outside closes the menu and leaves the draft alone.

## Activation In The Chat

Activating a skill shows one row — kind `skill`, labeled with the skill's name — and nothing else. The name comes from the Skill-tool argument (`skill`, then `name`, then `command`) when the provider has one (Claude, OpenCode, Grok), or from the parent folder of a `SKILL.md` read when it does not (Codex, Cursor, and Grok's file-read path). Claude injects the whole `SKILL.md` back into the stream as a `user` row flagged `isSynthetic` so the model can read it; [claude.rs](../src-tauri/src/providers/normalizer/claude.rs)'s `is_hidden_synthetic_body` drops it. The gate is the row's shape, not its opening words: a repo skill arrives under a `Base directory for this skill:` line, but the CLI's own skills (`/schedule`, `/loop`) send the bare body, and eleven KB of it used to land in chat as if the agent had written it. A synced transcript marks the same row `isMeta`, which the replay path already hides.
