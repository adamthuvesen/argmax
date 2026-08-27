# Skills

Argmax does not inject skill bodies into provider prompts. Each CLI loads skills from its own discovery roots when Argmax launches it. The slash autocomplete in the composer and launcher is a read-only listing of those same roots via `skills:list`.

## Discovery

[src-tauri/src/skills/registry.rs](../src-tauri/src/skills/registry.rs) walks provider-specific directories, then the shared skills-CLI catalog. First name wins: a workspace copy beats a user copy, and a Claude/Codex/Cursor-specific directory beats `~/.agents/skills` when the same name exists in both.

Personal skills installed by `npx skills add -g` (dotfiles `agents/skills/`) live in `~/.agents/skills`. Claude also gets per-skill symlinks under `~/.claude/skills`. Codex and Cursor load `~/.agents/skills` natively, so Argmax has to scan that folder too. Listing only `~/.cursor/skills` or `~/.codex/skills` misses the catalog.

| Provider | Workspace | User | Also |
|---|---|---|---|
| Claude | `.claude/skills`, `.agents/skills` | `~/.claude/skills`, `~/.agents/skills` | `~/.claude/plugins/cache` |
| Codex | `.codex/skills`, `.agents/skills` | `~/.codex/skills`, `~/.agents/skills` | `~/.codex/prompts`, `~/.codex/skills/.system`, plugins |
| Cursor | `.cursor/skills`, `.agents/skills` | `~/.cursor/skills`, `~/.agents/skills` | `~/.cursor/plugins/cache` |

Dot-directories under the user skill folders are skipped so Codex's `~/.codex/skills/.system` is not double-counted as user skills.

## Slash commands

Typing `/` in the composer or launcher calls `skills:list` for the current provider and workspace. Selecting a row inserts `/{name} `. The provider CLI then resolves that name through its own skill or prompt machinery.
