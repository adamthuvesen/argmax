# Styling

Pure CSS in [src/renderer/styles.css](../../src/renderer/styles.css). No CSS-in-JS, no Tailwind, no preprocessors.

## Hard constraints

- **Light theme only.** No dark mode, no `prefers-color-scheme: dark` block.
- **Lilex Nerd Font** is the only typeface. It's installed system-wide (Nerd Font patch); the renderer references it via `--font-ui` / `--font-mono` and falls back to `ui-monospace`. Do not add `@font-face` blocks or swap fonts.

## Tokens

Defined on `:root` in `styles.css`. Always reference these — don't hardcode hex values mid-file.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--sidebar`, `--panel`, `--panel-soft`, `--panel-sunken` |
| Lines | `--line`, `--line-soft`, `--line-strong` |
| Ink | `--text`, `--text-soft`, `--muted`, `--muted-strong`, `--ink`, `--ink-soft` |
| Status | `--sage` (running/online), `--amber` (waiting), `--rose` (error/risk) — each with a `*-soft` companion; plus `--sage-deep` for the Approve button |
| Elevation | `--shadow-1`, `--shadow-2`, `--shadow-3` |
| Radii | `--radius-sm/md/lg/xl` |
| Motion | `--ease` (cubic-bezier), `--duration-fast` (140ms), `--duration-base` (220ms) |

## Patterns

- **Status-driven coloring** — components carry `data-status` / `data-state` / `data-risk` attributes; CSS picks the color via attribute selectors. Don't conditionally swap classes in JSX.
- **Tool-type accent bars** — tool call items carry `data-tool-type` (`bash | edit | read | search | web | other`), set by `getToolTypeBucket()` in `App.tsx`. CSS uses this to apply a colored left `inset box-shadow` when the item is running or errored. Match the same logic when adding new tool types.
- **Motion is purposeful** — `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `tool-call-flash` on new tool arrivals, `detail-expand` when a tool call row opens, and the thinking indicator complex (`command-scan`, `command-caret`, `command-tick`, `command-trace`). New animations: define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering** — assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`).
- **Thinking indicator timing** — the thinking bubble is not a transcript item. Render it while a session is running and the latest user turn has no newer visible assistant output; raw provider output alone must not hide it. Remove it once a visible `message.delta`, `message.completed`, or `error` event arrives for that turn.

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff` — the grain is what gives the app its character. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Chat bubbles

User bubbles (`chat-bubble.user`) have a near-black background (`var(--ink)`) with white text — set `color: #ffffff` on both the bubble and its `p` descendants when targeting them. The dark mode override flips this to a white bubble with dark text. Do not revert to the light-gray style.

`::selection` uses a translucent sage tint (`rgba(90, 143, 114, 0.22)`) globally. Inside user bubbles, a separate `.chat-bubble.user ::selection` rule switches to a translucent white so the highlight is visible on the dark background.

## Conversation content width

`--session-inline-padding` is defined on `.conversation-surface` as `clamp(40px, calc((100vw - 272px - 980px) / 2), 400px)`. This keeps readable content at roughly 980px wide on typical screens while letting the scrollable container remain full-width (so the scrollbar stays at the window edge). The negative `margin-right` on `.conversation-list` uses the same variable to extend the list to the surface's right edge — both values must stay `vw`/`px` based (not `%`) or the math breaks.

## Don't

- Don't add color-mode toggles or theme picker UI.
- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` — the global rule already covers everything.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
- Don't change `--session-inline-padding` to use `%` units — see the content width note above.
