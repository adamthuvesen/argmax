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

## Slash Commands

Typing `/` in the composer queries `skills:list` for the active provider and workspace. Selecting an item inserts `/{name} ` into the prompt, which the provider CLI evaluates at runtime.
