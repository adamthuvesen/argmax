# Styling

Pure CSS in [src/renderer/styles.css](../src/renderer/styles.css). No CSS-in-JS, no Tailwind, no preprocessors. The look is hand-built on purpose — see the [hard constraints](#hard-constraints) before touching it.

| Want to… | Look here |
|---|---|
| Add a color or surface | [Tokens](#tokens) — define on `:root`, never inline hex |
| Add a status color | `data-status` / `data-state` / `data-risk` attribute selectors |
| Add configurable chrome tint | `--accent`, `--accent-soft`, `--accent-deep` in [Tokens](#tokens) |
| Add an animation | [Patterns](#patterns) — reuse `--ease`, respect `prefers-reduced-motion` |
| Add a font | `src/renderer/lib/fonts.ts` + matching `:root[data-font="…"]` block |
| Adjust the font-size setting | `src/renderer/lib/fonts.ts` + matching `:root[data-font-size="…"]` block |
| Style markdown | `.markdown <selector>` rules (defined for headings, lists, code, etc.) |
| Style overlays (⌘K, ⌘P, review, session chrome) | [overlays-*.css](#overlay-stylesheets) — keep import order in `overlays.css` |
| Style app shell / sidebar | [shell-*.css](#shell-stylesheets) — `shell.css` aggregator |
| Style Settings | [settings-*.css](#settings-stylesheets) — `settings.css` aggregator |
| Style chat / composer / tools | [chat-*.css](#chat-stylesheets) — `chat.css` aggregator |

## Shell stylesheets

`styles.css` imports [shell.css](../src/renderer/styles/shell.css) (aggregator only). **Import order is part of the cascade contract.**

| File | Scope |
|---|---|
| `shell-layout.css` | `.app-shell`, sidebar chrome, projects rail, margin-notes nameplate/CTA |
| `shell-sessions.css` | Session rows, pin/archive menus, sidebar search, launcher wrapper hooks |

## Settings stylesheets

`styles.css` imports [settings.css](../src/renderer/styles/settings.css) (aggregator only).

| File | Scope |
|---|---|
| `settings-layout.css` | Settings shell — left rail, hero, sections, cards, account, metrics |
| `settings-controls.css` | Segmented controls, toggles, font/theme pickers, refresh |
| `settings-diagnostics.css` | Providers list, diagnostics tiles, logs, tables, MCP |

## Chat stylesheets

`styles.css` imports [chat.css](../src/renderer/styles/chat.css) (aggregator only).

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

`styles.css` imports [overlays.css](../src/renderer/styles/overlays.css), which is only an aggregator (<200 lines). Surface rules live in sibling files under `src/renderer/styles/`; **import order in `overlays.css` is part of the cascade contract**.

| File | Scope |
|---|---|
| `overlays-inkwell.css` | Command palette (⌘K), cheat sheet, file/workspace search modals — shared `.command-palette-overlay` / `.search-overlay` backdrop uses `--modal-backdrop` from `tokens.css` |
| `overlays-review.css` | Review panel chrome — toolbar, diff list, commit dialog, mode tabs, composer toolbar overrides in review |
| `overlays-review-files.css` | Review file surface — workspace tree, file tabs, file preview (CodeMirror), diff blocks, project-knowledge rows |
| `overlays-launcher.css` | Launcher/session shell — session rows, sidebar tree chrome, approval surface, diff line gutters |
| `overlays-launcher-composer.css` | Composer affordances — send buttons, empty state, bridge banner, toasts |
| `overlays-launcher-panels.css` | Session panels — debug log, integrated terminal, responsive review/log stacking |
| `overlays-launcher-cards.css` | Chat cards in session — plan card and question card |

Keep each stylesheet module under **1000 lines**. Split further by surface if a file grows past the cap. Add new rules to the matching surface file. Do not grow aggregator files (`overlays.css`, `shell.css`, `settings.css`, `chat.css`) beyond imports and a short header comment.

## Hard constraints

- **Three themes: Light / Dark / System.** System is the default and tracks `prefers-color-scheme` live. Dark is **warm charcoal** — yellow-leaning grays (`oklch(15% 0.005 80)` family), never cool/midnight blue. Tokens live in `:root` (light) and `:root[data-theme="dark"]`. Active mode persists under `argmax.theme.mode` localStorage and `userData/theme.json` (Tauri-side for no-flash startup). See [src/renderer/lib/theme.ts](../src/renderer/lib/theme.ts).
- **Accent tint is chrome-only.** Settings → Appearance lets users pick `green`, `purple`, `neutral`, `orange`, or `blue`; the choice persists under `argmax.accent.tint` and sets `<html data-accent="…">`. Use `--accent`, `--accent-soft`, and `--accent-deep` for decorative brand/chrome tint: focus rings, selection, picker states, command palette selection, launcher decoration, and transcript metadata.
- **Fonts flow through tokens.** Never hardcode a family — chrome reads `--font-ui`, long-form chat prose and the session composer read `--font-prose`, terminal reads `--font-mono`, and review/editor code plus inline markdown code/file refs and transcript tool targets read `--font-code` (Codex-like system mono by default). Mono font picks set UI/mono variables to the same stack while chat prose stays proportional; sans picks keep a system mono stack for code/terminal.
- **Font sizes flow through tokens.** Never hardcode a text `font-size` in px. Use the type scale on `:root`; Settings → Appearance exposes Small / Default / Large whole-app modes by flipping `<html data-font-size="small|default|large">`, persisted under `argmax.font.size`. Terminal/xterm surfaces must resolve `--text-terminal` through the helpers in `src/renderer/lib/fonts.ts`, because canvas text cannot inherit CSS variables directly.
- **Inter is the default** (`@fontsource-variable/inter`, loaded on cold launch since it's the default). Lilex remains available, kept Nerd-Font–patched so terminal-style glyphs still render. Mono alternates (JetBrains Mono, Fira Code, Geist Mono, IBM Plex Mono) and the other sans options (Geist Sans, IBM Plex Sans, Manrope) are lazy-loaded via `@fontsource` / `@fontsource-variable` only when picked, and selected from Settings → Appearance. System fonts (System Mono, Menlo, Monaco) need no JS asset load. New fonts live in [src/renderer/lib/fonts.ts](../src/renderer/lib/fonts.ts) and get a matching `:root[data-font="…"]` block in `styles.css`. The active choice persists under the `argmax.font.family` localStorage key.

## Tokens

Defined on `:root` in `styles.css`. Always reference these — don't hardcode hex values mid-file.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--sidebar`, `--panel`, `--panel-soft`, `--panel-sunken` |
| Lines | `--line`, `--line-soft`, `--line-strong` |
| Ink | `--text`, `--text-soft`, `--muted`, `--muted-strong`, `--ink`, `--ink-soft` |
| Fonts | `--font-ui`, `--font-prose`, `--font-mono`, `--font-code` |
| Chrome accent | `--accent`, `--accent-soft`, `--accent-deep` — configurable brand/decorative tint, defaults to the green `--sage*` values |
| Scrollbars | `--scrollbar-thumb`, `--scrollbar-thumb-hover` — global scrollbar thumb colors; light mode stays pale gray, dark-family themes keep contrast |
| Status | `--sage` (running/online/success/approve), `--amber` (waiting), `--rose` (error/risk) — each with a `*-soft` companion. Keep status chips, running/error states, diffs, checks, file-change cards, code additions, and logs on semantic tokens; do not migrate them to `--accent*`. |
| Syntax | `--syntax-keyword`, `--syntax-definition`, `--syntax-string`, `--syntax-type`, `--syntax-constant`, `--syntax-variable`, `--syntax-comment` for CodeMirror file previews |
| Elevation | `--shadow-1`, `--shadow-2`, `--shadow-3` |
| Radii | `--radius-xs` (3px), `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (10px). Prefer tokens; reserve `999px` / `50%` for truly circular elements only (status dots, toggle knobs). |
| Motion | `--ease` (cubic-bezier), `--duration-fast` (140ms), `--duration-base` (220ms); newer code prefers `--motion-fast` (120ms), `--motion-base` (180ms), `--motion-slow` (240ms), `--ease-out`, `--ease-in-out` |
| Spacing | `--space-1` (4px) through `--space-8` (32px). Use these for paddings, gaps, and margins; reserve raw `px` for one-off optical adjustments. |
| Type | `--text-4xs` (9px), `--text-3xs` (9.5px), `--text-2xs` (10px), `--text-xs` (11px), `--text-sm` (12px), `--text-base` (13px), `--text-md` (15px), `--text-lg` (18px), `--text-xl` (20px), `--text-2xl` (22px), `--text-display` (23px), and `--text-terminal` (13px). Half-step `*-plus` / `*-tight` tokens support dense surfaces. |
| Focus | `--ring` — single source of truth for every `:focus-visible` ring. |

Future text-size changes should update the type tokens or the `data-font-size` mode blocks, not individual component rules. Reduced-motion users get a zero override on the motion tokens via `@media (prefers-reduced-motion: reduce)`.

## Patterns

- **Status-driven coloring** — components carry `data-status` / `data-state` / `data-risk` attributes; CSS picks the color via attribute selectors. Don't conditionally swap classes in JSX.
- **Status edges, not per-type colors** — a running `.tool-call-item` gets one amber left `inset box-shadow`; an errored one gets rose. The tool *type* is signalled by the icon, not color. `data-tool-type` (`bash | edit | read | search | web | other`, set by `getToolTypeBucket()` in `App.tsx`) is still carried for the icon and the agent-row treatment (`.tool-call-row[data-tool-type="agent"]`), but no longer drives a per-type accent bar — that was redundant noise.
- **Motion is purposeful** — `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `status-marker-working-pulse` on the sidebar row's working marker while a turn is in flight, `tool-call-flash` on new tool arrivals, `detail-expand` when a tool call row opens, and the thinking indicator pulse/typing affordances. New animations: define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering** — assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`). Keep prose on `--font-prose`; reserve `--font-code` for inline code, file refs, fenced code, transcript tool targets, and editor surfaces so agent output reads like writing with code in it, not a terminal transcript. Top-level prose blocks are capped to a readable measure while tables and fenced code keep the full available width. Inline file refs are text-only `FileChip` buttons — no leading code icon in prose.
- **Thinking indicator timing** — the thinking bubble is not a transcript item. Render it during silent gaps in a running turn: before the first answer, after completed answer chunks, and after completed tool rows while the model chooses the next step. Hide it while text is actively streaming, while a visible tool row is running, or while an interactive card is waiting on the user; raw provider output alone must not hide it. The initial empty beat appears immediately. Most mid-turn gaps wait 700 ms before showing; gaps after completed assistant text wait 1800 ms so the terminal session-state delta can land without a bogus tail flash. Once shown, the label stays visible for at least 600 ms.

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff` — the grain is what gives the app its character. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Chat bubbles

User message bubbles (`chat-bubble.user`) use `--user-message-bg` / `--user-message-fg` / `--user-message-shadow`. Light mode uses a borderless light gray surface; dark swaps in a theme-matched elevated surface so long user prompts do not become harsh slabs.

`::selection` uses a translucent accent tint globally. Inside user bubbles, `.chat-bubble.user ::selection` uses `--user-message-selection-bg` so the highlight stays visible against each theme's user-message surface.

## Conversation content width

Settings → Appearance exposes Chat width as Narrow, Standard, or Wide, persisted under `argmax.chat.width` and mirrored on `.app-shell[data-chat-width]`. The modes set `--chat-content-width` / `--chat-content-width-docked` / `--chat-content-width-tight` to `640/600/560px`, `780/740/680px`, or `940/900/840px`. `--session-inline-padding` is defined on `.session-main-column` as `clamp(28px, calc((100% - var(--chat-content-width)) / 2), 2000px)`, with tighter gutters when the review or log panel is open (`22px`) or both are open (`20px`). This keeps readable content centered in wide panes while preserving a real gutter in narrow grid panes. `.conversation-list` consumes the token as its inline padding.

Side-by-side pane resizing bottoms out at `MIN_RESIZABLE_CELL_WIDTH_PX` in `SessionMultiGrid.tsx`; the session composer switches to its compact container layout before that floor so the controls settle before the app stops shrinking. When a review/log panel is docked, that cell's floor becomes `CHAT_PANE_MIN_WIDTH_PX + <active panel width>`, so window resizing shrinks the chat pane first while preserving the side panel width. The app also sets a live window/sidebar minimum from the grid row width, so an existing row cannot be squeezed below its active pane floors.

## Dark theme — Warm Charcoal Editorial

Same room with the lights off. Five rules:

1. **Warm blacks, never blue.** Hues sit around 80° (yellow side of neutral), chroma stays very low.
2. **Paper-inversion.** The body grain SVG references `var(--grain-color)` so it flips polarity automatically.
3. **Accents lifted, not loud.** Sage / amber / rose gain ~10pp lightness and shed ~15% chroma — warm and confident, never neon.
4. **Depth from edges, not shadows.** Dark elevation uses a 1px inset top-highlight + heavier drop in `--shadow-1/2/3`. The pixel of warm light at the top of an elevated card is the signature detail.
5. **`color-scheme` follows.** `:root` declares `light`, `:root[data-theme="dark"]` declares `dark`, so native form controls + scrollbars track.

Status colors keep semantic meaning across modes; values differ. Add new tokens to both theme blocks (`:root`, `[data-theme="dark"]`) at the same time.

## Don't

- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` — the global rule already covers everything.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
