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
- **Motion is purposeful** — `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `stream-shimmer` under the thinking indicator. New animations: define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering** — assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`).

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff` — the grain is what gives the app its character. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Don't

- Don't add color-mode toggles or theme picker UI.
- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` — the global rule already covers everything.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
