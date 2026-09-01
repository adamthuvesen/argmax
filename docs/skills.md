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

**Composer commands** come first. Each surface passes its own list — the session composer offers the agent-mode toggle, Stop, Attach file, Changes, and Worktree; the launcher offers the modes, Attach file, Project, Branch, and the worktree toggle. Every entry is a control that already exists in that toolbar, so the menu is a keyboard route to them and never a second set of features. Entries that would be a no-op right now are left out rather than shown disabled. Picking one drops the `/token` it was summoned with, returns focus to the prompt, and runs the action.

**Skills** follow under their own heading, queried from `skills:list` for the active provider and workspace, each badged with its source. Selecting one inserts `/{name} ` into the prompt, which the provider CLI evaluates at runtime.

A query prefix-matches command names and labels but substring-matches skill names: commands are a short curated list invoked by name, and a substring rule would leave them crowding the top of a skill query long after the user stopped meaning them. Arrow keys and Enter/Tab run the whole list; Escape drops the `/token`; a click outside closes the menu and leaves the draft alone.
