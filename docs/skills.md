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

Hidden dot-directories (e.g. `~/.codex/skills/.system`) are ignored to avoid double-counting internal skills.

## The `/` Menu

Typing `/` in either composer opens [SlashCommandMenu](../src/renderer/components/SlashCommandMenu.tsx), driven by [useSlashAutocomplete](../src/renderer/hooks/useSlashAutocomplete.ts). It has two sections.

**Composer commands** come first. Each surface passes its own list. The session composer offers the agent-mode toggle, Stop, Clear, Multitask, Goal, Attach file, Changes, and Worktree. The launcher offers the modes, Goal, Attach file, Project, Branch, and the worktree toggle. Goal appears on both surfaces when Goals is enabled in Settings. Most entries are a keyboard route to a control that already exists in that toolbar. `/clear`, `/multitask`, and `/goal` are Argmax-owned actions whose home is the slash menu. Entries that would be a no-op right now are left out rather than shown disabled. Picking an action drops the `/token` it was summoned with, returns focus to the prompt, and runs the action. Goal and Multitask insert their command prefix for you to complete.

**Skills** follow under their own heading, queried from `skills:list` for the active provider and workspace, each badged with its source. Selecting one inserts `/{name} ` into the prompt, which the provider CLI evaluates at runtime. `/clear` never reaches the provider: Argmax intercepts it, even if you type it and press Enter.

Every `/token` naming a loaded skill is tinted as you type, wherever it sits in the draft ([slashHighlight.ts](../src/renderer/lib/slashHighlight.ts) behind a mirror overlay, since a textarea cannot colour a substring). Both composers and the sent bubble use the shared `.skill-token` highlight for leading and inline invocations. The literal `/name`, capitalization, spaces, and line breaks survive sending. The highlight uses accent ink in the composer and the message foreground in the bubble for contrast. The transcript has no skills list to check against, so token shape is its only guard — paths like `/tmp/logs` and `/Users/adam/dev` fail it and stay plain.

A query prefix-matches command names and labels but substring-matches skill names: commands are a short curated list invoked by name, and a substring rule would leave them crowding the top of a skill query long after the user stopped meaning them. Arrow keys and Enter/Tab run the whole list; Escape drops the `/token`; a click outside closes the menu and leaves the draft alone.
