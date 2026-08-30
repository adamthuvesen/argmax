# Styling

Argmax uses plain CSS in [src/renderer/styles.css](../src/renderer/styles.css) without CSS-in-JS, Tailwind, or preprocessors.

## File Organization

`styles.css` imports modular stylesheets under `src/renderer/styles/`. **Import order defines the cascade:**

| Area | Aggregator | Modules |
|---|---|---|
| Shell | `shell.css` | `shell-layout.css`, `shell-sessions.css`, `shell-session-icons.css` |
| Settings | `settings.css` | `settings-layout.css`, `settings-controls.css`, `settings-diagnostics.css` |
| Chat | `chat.css` | `chat-chrome.css`, `chat-conversation.css`, `chat-composer.css`, `chat-turns.css`, `chat-tools.css`, `chat-composer-chips.css`, `chat-workspace-card.css` |
| Overlays | `overlays.css` | `overlays-inkwell.css` (command palette), `overlays-review.css`, `overlays-review-files.css`, `overlays-launcher.css`, `overlays-launcher-composer.css`, `overlays-launcher-panels.css`, `overlays-launcher-cards.css` |

Keep individual surface files under 1,000 lines. Aggregator files should only contain imports.

## Core Design Constraints

- **Themes:** Light, Dark, and System modes. Dark is the default. Tokens are declared in `:root` (light) and `:root[data-theme="dark"]` in [tokens.css](../src/renderer/styles/tokens.css). Theme choice persists in `localStorage.argmax.theme.mode` and `userData/theme.json`.
  - In dark mode, `--bg` is dark charcoal (`#131312`), `--review-panel` sits just above it, `--sidebar` a step higher, and `--panel` is the elevated card surface.
  - Ink uses `#e3e0d8` rather than pure white to avoid bloom on dark backgrounds.
- **Accent Tints:** Settings → Appearance allows selecting `green`, `purple`, `neutral`, `orange`, or `blue` (`<html data-accent="...">`). Use `--accent`, `--accent-soft`, and `--accent-deep` for interactive highlights, focus rings, brand chrome, and running indicators (`WorkingNest`).
- **Typography:**
  - Chrome: `--font-ui` (Geist Sans default).
  - Prose: `--font-prose`.
  - Code & Editor: `--font-code` (Geist Mono / system mono).
  - Terminal: `--font-mono`.
  - Text weights use `--weight-ui` (`:root`) and `--weight-prose` (chat bubbles and `.markdown`). Variable font stacks run slightly lighter in dark mode (`380`/`390`) to compensate for dark-background bloom.
- **Type Scale:** Controlled via `[data-font-size="1"]` through `="10"` on `:root` and `.session-multigrid`. App font size (`argmax.font.scale`) and agent window font size (`argmax.font.scale.chat`) scale independently.
  - The session composer, workspace card, and review panel use `data-type-scale="chrome"` so control chips and sidebars stay at app-chrome scale.
  - Terminal surfaces resolve `--text-terminal` in pixels via helpers in `src/renderer/lib/fonts.ts` using `@property` length registrations.
- **Focus Rings:** Global focus uses `outline: none` and `box-shadow: inset 0 0 0 1.5px var(--line-strong)`. Specific controls use `var(--ring)`.

## Tokens

Defined in [tokens.css](../src/renderer/styles/tokens.css):

| Category | Tokens | Description |
|---|---|---|
| Surfaces | `--bg`, `--sidebar`, `--panel`, `--review-panel`, `--panel-soft`, `--panel-sunken` | Base backgrounds and elevated panels |
| Lines | `--line`, `--line-soft`, `--line-strong` | Borders and dividers |
| Text | `--text`, `--text-soft`, `--muted`, `--muted-strong` | Primary, secondary, and disabled text |
| Fonts | `--font-ui`, `--font-prose`, `--font-mono`, `--font-code` | Font stacks |
| Accent | `--accent`, `--accent-soft`, `--accent-deep` | User-configured theme accent |
| Status | `--sage` (success/approve), `--amber` (warning/waiting), `--rose` (error/risk) | Semantic state colors (with `*-soft` variants) |
| Radii | `--radius-xs` (3px), `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (10px) | Corner radii |
| Spacing | `--space-1` (4px) to `--space-8` (32px) | Standard layout spacing steps |

## Component Patterns

- **Attribute-Driven Styling:** Use `data-status`, `data-state`, and `data-risk` attributes for state styles instead of dynamic JSX class names.
- **Motion:** Use `--motion-fast` (120ms), `--motion-base` (180ms), and `--motion-slow` (240ms). Respect `@media (prefers-reduced-motion: reduce)` overrides.
- **Markdown:** Assistant messages render via `react-markdown` inside `.markdown` containers. Prose blocks are constrained to a readable measure while code blocks and tables expand to full width.
- **Command Palette:** The search modal (`.command-palette-overlay`) is centered over the work area by accounting for `--work-area-left-inset`. ⌘K opens All, ⌘P on Files, ⌘F on Messages, ⌘⇧F on Contents.

## Guidelines

- Avoid adding third-party UI component libraries (shadcn, Radix, Tailwind).
- Avoid inline `style={{}}` attributes in JSX for static styling; use classes and tokens.
- Use semantic status tokens (`--sage`, `--amber`, `--rose`) for status badges, checks, and diffs rather than accent tint tokens.
