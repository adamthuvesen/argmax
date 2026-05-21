# Styling

Pure CSS in [src/renderer/styles.css](../../src/renderer/styles.css). No CSS-in-JS, no Tailwind, no preprocessors. The look is hand-built on purpose — see the [hard constraints](#hard-constraints) before touching it.

| Want to… | Look here |
|---|---|
| Add a color or surface | [Tokens](#tokens) — define on `:root`, never inline hex |
| Add a status color | `data-status` / `data-state` / `data-risk` attribute selectors |
| Add an animation | [Patterns](#patterns) — reuse `--ease`, respect `prefers-reduced-motion` |
| Add a font | `src/renderer/lib/fonts.ts` + matching `:root[data-font="…"]` block |
| Style markdown | `.markdown <selector>` rules (defined for headings, lists, code, etc.) |

## Hard constraints

- **Three themes: Light / Dark / System.** System is the default and tracks `prefers-color-scheme` live. Dark is **warm charcoal** — yellow-leaning grays (`oklch(15% 0.005 80)` family), never cool/midnight blue. Tokens live in `:root` (light) and `:root[data-theme="dark"]`. Active mode persists under `argmax.theme.mode` localStorage and `userData/theme.json` (Electron-side for no-flash startup). See [src/renderer/lib/theme.ts](../../src/renderer/lib/theme.ts).
- **Monospace everywhere.** The UI and code use the same font family — both read from `--font-ui` / `--font-mono`. Don't introduce a separate sans for chrome.
- **Lilex is the default**, kept Nerd-Font–patched so terminal-style glyphs still render. Mono alternates (JetBrains Mono, Fira Code, Geist Mono, IBM Plex Mono) and proportional sans options (Inter, Geist Sans, IBM Plex Sans, Manrope) are lazy-loaded via `@fontsource` / `@fontsource-variable` only when picked, and selected from Settings → Appearance. System fonts (System Mono, Menlo, Monaco) need no JS asset load. New fonts live in [src/renderer/lib/fonts.ts](../../src/renderer/lib/fonts.ts) and get a matching `:root[data-font="…"]` block in `styles.css`. The active choice persists under the `argmax.font.family` localStorage key.

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
| Motion | `--ease` (cubic-bezier), `--duration-fast` (140ms), `--duration-base` (220ms); newer code prefers `--motion-fast` (120ms), `--motion-base` (180ms), `--motion-slow` (240ms), `--ease-out`, `--ease-in-out` |
| Spacing | `--space-1` (4px) through `--space-8` (32px). Use these for paddings, gaps, and margins; reserve raw `px` for one-off optical adjustments. |
| Type | `--text-xs` (11px) → `--text-sm` (12px) → `--text-base` (13px) → `--text-md` (15px) → `--text-lg` (18px). |
| Focus | `--ring` — single source of truth for every `:focus-visible` ring. |

A loop-wide sweep replacing every existing raw value would land 700+ line edits. The tokens above were introduced in the 2026-05-14 quality sweep; future changes should reach for the token first, and legacy raw values get migrated incrementally as files are touched. Reduced-motion users get a zero override on the motion tokens via `@media (prefers-reduced-motion: reduce)`.

## Patterns

- **Status-driven coloring** — components carry `data-status` / `data-state` / `data-risk` attributes; CSS picks the color via attribute selectors. Don't conditionally swap classes in JSX.
- **Tool-type accent bars** — tool call items carry `data-tool-type` (`bash | edit | read | search | web | other`), set by `getToolTypeBucket()` in `App.tsx`. CSS uses this to apply a colored left `inset box-shadow` when the item is running or errored. Match the same logic when adding new tool types.
- **Motion is purposeful** — `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `tool-call-flash` on new tool arrivals, `detail-expand` when a tool call row opens, and the thinking indicator complex (`command-scan`, `command-caret`, `command-tick`, `command-trace`). New animations: define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering** — assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`).
- **Thinking indicator timing** — the thinking bubble is not a transcript item. Render it while a session is running and the latest user turn has no newer visible assistant output; raw provider output alone must not hide it. Remove it once a visible `message.delta`, `message.completed`, or `error` event arrives for that turn.

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff` — the grain is what gives the app its character. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Chat bubbles

User bubbles (`chat-bubble.user`) have a near-black background (`var(--ink)`) with white text — set `color: #ffffff` on both the bubble and its `p` descendants when targeting them. Do not revert to the light-gray style.

`::selection` uses a translucent sage tint (`rgba(90, 143, 114, 0.22)`) globally. Inside user bubbles, a separate `.chat-bubble.user ::selection` rule switches to a translucent white so the highlight is visible on the dark background.

## Conversation content width

`--session-inline-padding` is defined on `.session-main-column` as `clamp(36px, calc((100% - 920px) / 2), 2000px)`, with tighter variants when the review or log panel is open (`clamp(18px, calc((100% - 860px) / 2), 2000px)` and `clamp(10px, calc((100% - 780px) / 2), 2000px)`). This keeps readable content at roughly 920px wide while letting the scrollable container remain full-width (so the scrollbar stays at the panel edge). `.conversation-list` consumes the token as its inline padding.

## Dark theme — Warm Charcoal Editorial

Same room with the lights off. Five rules:

1. **Warm blacks, never blue.** Hues sit around 80° (yellow side of neutral), chroma stays very low.
2. **Paper-inversion.** The body grain SVG references `var(--grain-color)` so it flips polarity automatically.
3. **Accents lifted, not loud.** Sage / amber / rose gain ~10pp lightness and shed ~15% chroma — warm and confident, never neon.
4. **Depth from edges, not shadows.** Dark elevation uses a 1px inset top-highlight + heavier drop in `--shadow-1/2/3`. The pixel of warm light at the top of an elevated card is the signature detail.
5. **`color-scheme` follows.** `:root` declares `light`, `:root[data-theme="dark"]` declares `dark`, so native form controls + scrollbars track.

Status colors keep semantic meaning across modes; values differ. Add new tokens to both `:root` blocks at the same time.

## Don't

- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` — the global rule already covers everything.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
