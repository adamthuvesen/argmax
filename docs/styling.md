# Styling

Pure CSS in [src/renderer/styles.css](../../src/renderer/styles.css). No CSS-in-JS, no Tailwind, no preprocessors. The look is hand-built on purpose — see the [hard constraints](#hard-constraints) before touching it.

| Want to… | Look here |
|---|---|
| Add a color or surface | [Tokens](#tokens) — define on `:root`, never inline hex |
| Add a status color | `data-status` / `data-state` / `data-risk` attribute selectors |
| Add an animation | [Patterns](#patterns) — reuse `--ease`, respect `prefers-reduced-motion` |
| Add a font | `src/renderer/lib/fonts.ts` + matching `:root[data-font="…"]` block |
| Style markdown | `.markdown <selector>` rules (defined for headings, lists, code, etc.) |
| Style overlays (⌘K, ⌘P, review, session chrome) | [overlays-*.css](#overlay-stylesheets) — keep import order in `overlays.css` |
| Style app shell / sidebar | [shell-*.css](#shell-stylesheets) — `shell.css` aggregator |
| Style Settings | [settings-*.css](#settings-stylesheets) — `settings.css` aggregator |
| Style chat / composer / tools | [chat-*.css](#chat-stylesheets) — `chat.css` aggregator |

## Shell stylesheets

`styles.css` imports [shell.css](../../src/renderer/styles/shell.css) (aggregator only). **Import order is part of the cascade contract.**

| File | Scope |
|---|---|
| `shell-layout.css` | `.app-shell`, sidebar chrome, projects rail, margin-notes nameplate/CTA |
| `shell-sessions.css` | Session rows, pin/archive menus, sidebar search, launcher wrapper hooks |

## Settings stylesheets

`styles.css` imports [settings.css](../../src/renderer/styles/settings.css) (aggregator only).

| File | Scope |
|---|---|
| `settings-layout.css` | Settings shell — left rail, hero, sections, cards, account, metrics |
| `settings-controls.css` | Segmented controls, toggles, font/theme pickers, refresh |
| `settings-diagnostics.css` | Providers list, diagnostics tiles, logs, tables, MCP |

## Chat stylesheets

`styles.css` imports [chat.css](../../src/renderer/styles/chat.css) (aggregator only).

| File | Scope |
|---|---|
| `chat-chrome.css` | Footer ribbon, pickers, git/session header menus, `.session-scroll` |
| `chat-conversation.css` | Multi-pane grid, conversation surface, bubbles, `.markdown`, scroll-to-bottom FAB |
| `chat-composer.css` | Composer footer chips, approvals banner, file/code preview popovers |
| `chat-turns.css` | `TurnBlock`, thinking indicator, tool-call rows and groups |
| `chat-tools.css` | In-chat file-change cards, diff hunks, expanded tool detail |
| `chat-composer-chips.css` | Model/mode/context chip grouping in composer toolbar |

Keep each module under **1000 lines**. Add rules to the matching surface file; do not grow aggregators beyond imports and a short header.

## Overlay stylesheets

`styles.css` imports [overlays.css](../../src/renderer/styles/overlays.css), which is only an aggregator (<200 lines). Surface rules live in sibling files under `src/renderer/styles/`; **import order in `overlays.css` is part of the cascade contract** (mirrors the old monolithic file).

| File | Scope |
|---|---|
| `overlays-inkwell.css` | Command palette (⌘K), cheat sheet, file/workspace search modals — shared `.command-palette-overlay` / `.search-overlay` backdrop uses `--modal-backdrop` from `tokens.css` |
| `overlays-review.css` | Review panel chrome — toolbar, diff list, commit dialog, mode tabs, composer toolbar overrides in review |
| `overlays-review-files.css` | Review file surface — workspace tree, file tabs, file preview (CodeMirror), diff blocks, project-knowledge rows |
| `overlays-launcher.css` | Launcher/session shell — session rows, sidebar tree chrome, approval surface, diff line gutters |
| `overlays-launcher-composer.css` | Composer affordances — mascot/send buttons, empty state, bridge banner, toasts |
| `overlays-launcher-panels.css` | Session panels — debug log, integrated terminal, responsive review/log stacking |
| `overlays-launcher-cards.css` | Chat cards in session — plan card and question card |

Keep each stylesheet module under **1000 lines**. Split further by surface if a file grows past the cap. Add new rules to the matching surface file. Do not grow aggregator files (`overlays.css`, `shell.css`, `settings.css`, `chat.css`) beyond imports and a short header comment.

## Hard constraints

- **Four themes: Light / Dark / System / Purple.** System is the default and tracks `prefers-color-scheme` live. Dark is **warm charcoal** — yellow-leaning grays (`oklch(15% 0.005 80)` family), never cool/midnight blue. Purple ("Nebula") is a dark-family theme — deep amethyst canvas, a gold-spark hero action, aurora glow. Tokens live in `:root` (light), `:root[data-theme="dark"]`, and `:root[data-theme="purple"]`. Purple resolves to the **dark** palettes for code/terminal via `themeAppearance()` in [theme.ts](../../src/renderer/lib/theme.ts). Active mode persists under `argmax.theme.mode` localStorage and `userData/theme.json` (Tauri-side for no-flash startup). See [src/renderer/lib/theme.ts](../../src/renderer/lib/theme.ts).
- **Fonts flow through `--font-ui` / `--font-mono`.** Never hardcode a family — chrome reads `--font-ui`, code and the terminal read `--font-mono`. Mono font picks set both variables to the same stack; sans picks keep a system mono stack for code/terminal.
- **Inter is the default** (`@fontsource-variable/inter`, loaded on cold launch since it's the default). Lilex remains available, kept Nerd-Font–patched so terminal-style glyphs still render. Mono alternates (JetBrains Mono, Fira Code, Geist Mono, IBM Plex Mono) and the other sans options (Geist Sans, IBM Plex Sans, Manrope) are lazy-loaded via `@fontsource` / `@fontsource-variable` only when picked, and selected from Settings → Appearance. System fonts (System Mono, Menlo, Monaco) need no JS asset load. New fonts live in [src/renderer/lib/fonts.ts](../../src/renderer/lib/fonts.ts) and get a matching `:root[data-font="…"]` block in `styles.css`. The active choice persists under the `argmax.font.family` localStorage key.

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
- **Status edges, not per-type colors** — a running `.tool-call-item` gets one amber left `inset box-shadow`; an errored one gets rose. The tool *type* is signalled by the icon, not color. `data-tool-type` (`bash | edit | read | search | web | other`, set by `getToolTypeBucket()` in `App.tsx`) is still carried for the icon and the agent-row treatment (`.tool-call-row[data-tool-type="agent"]`), but no longer drives a per-type accent bar — that was redundant noise.
- **Motion is purposeful** — `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `tool-call-flash` on new tool arrivals, `detail-expand` when a tool call row opens, and the thinking indicator complex (`command-scan`, `command-caret`, `command-tick`, `command-trace`). New animations: define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering** — assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`).
- **Thinking indicator timing** — the thinking bubble is not a transcript item. Render it while a session is running and the latest user turn has no newer visible assistant output; raw provider output alone must not hide it. Remove it once a visible `message.delta`, `message.completed`, or `error` event arrives for that turn.

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff` — the grain is what gives the app its character. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Chat bubbles

User bubbles (`chat-bubble.user`) use `--user-bubble-bg` / `--user-bubble-fg`. In light mode those map to the near-black `--ink` treatment; in dark mode they shift to a softer warm gray so long user prompts do not become bright slabs.

`::selection` uses a translucent sage tint (`rgba(90, 143, 114, 0.22)`) globally. Inside user bubbles, `.chat-bubble.user ::selection` uses `--selection-bg-on-ink` so the highlight stays visible against each theme's user-bubble color.

## Conversation content width

`--session-inline-padding` is defined on `.session-main-column` as `clamp(36px, calc((100% - 920px) / 2), 2000px)`, with tighter variants when the review or log panel is open (`clamp(18px, calc((100% - 860px) / 2), 2000px)` and `clamp(10px, calc((100% - 780px) / 2), 2000px)`). This keeps readable content at roughly 920px wide while letting the scrollable container remain full-width (so the scrollbar stays at the panel edge). `.conversation-list` consumes the token as its inline padding.

## Dark theme — Warm Charcoal Editorial

Same room with the lights off. Five rules:

1. **Warm blacks, never blue.** Hues sit around 80° (yellow side of neutral), chroma stays very low.
2. **Paper-inversion.** The body grain SVG references `var(--grain-color)` so it flips polarity automatically.
3. **Accents lifted, not loud.** Sage / amber / rose gain ~10pp lightness and shed ~15% chroma — warm and confident, never neon.
4. **Depth from edges, not shadows.** Dark elevation uses a 1px inset top-highlight + heavier drop in `--shadow-1/2/3`. The pixel of warm light at the top of an elevated card is the signature detail.
5. **`color-scheme` follows.** `:root` declares `light`, `:root[data-theme="dark"]` declares `dark`, so native form controls + scrollbars track.

Status colors keep semantic meaning across modes; values differ. Add new tokens to all three theme blocks (`:root`, `[data-theme="dark"]`, `[data-theme="purple"]`) at the same time.

## Purple theme — Nebula

Cosmic, premium, dark-family. Same room, lit by a violet nebula:

1. **Warm royal-purple surfaces.** `--bg #5c4187` → `--panel #6d509b` (a clearly-visible true violet — red lifted so it reads purple, not indigo/blue; matched to the reference's lit canvas, not near-black); lines and overlays are violet-tinted, text is lavender-white.
2. **Purple + gold, no green.** This theme has no green accent (matching the reference). The `--sage` slot — running / online / success / approve / selected-glow — is a luminous golden **yellow**; `--amber` (waiting) stays a warmer orange so the two hues stay distinct. The primary submit blooms gold on hover via a `:root[data-theme="purple"]` polish block. Diff add/delete keep conventional green/red (code-review signal), and the few hard-coded status reds (checks-failed, delete-hover) are re-pointed at `--rose` in a purple-scoped block so they stay legible on violet.
3. **Aurora canvas.** `--grain-image` layers violet-tinted film grain over two radial blooms (it has one consumer, `body`), so the workspace glows at the top edge.
4. **Bloom, not just drop.** `--shadow-2/3` keep dark's inset top-highlight + drop and add a soft violet outer glow so panels float in the nebula.
5. **Dark-family for code.** `color-scheme: dark`; native window chrome maps to `tauri::Theme::Dark` with a `PURPLE_BG` (#5c4187) cold-start color; shiki/xterm use the dark palettes through `themeAppearance()`. The window uses an **Overlay** titlebar (`tauri.conf.json`) so the app's own chrome (and bg) fills the top — no native title bar — matching whatever theme is active.

`--ink` stays light (lavender-white), like dark, so every `var(--ink)` fill/border/text usage keeps its contrast — the violet identity comes from rings/selection/glow/grain + retuned accents, not from repurposing `--ink`.

## Don't

- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` — the global rule already covers everything.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
