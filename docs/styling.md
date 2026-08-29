# Styling

Pure CSS in [src/renderer/styles.css](../src/renderer/styles.css). No CSS-in-JS, no Tailwind, no preprocessors. The look comes from hand-built CSS. Read the [hard constraints](#hard-constraints) before touching it.

| Want to… | Look here |
|---|---|
| Add a color or surface | [Tokens](#tokens): define on `:root`, never inline hex |
| Add a status color | `data-status` / `data-state` / `data-risk` attribute selectors |
| Add configurable chrome tint | `--accent`, `--accent-soft`, `--accent-deep` in [Tokens](#tokens) |
| Add an animation | [Patterns](#patterns): reuse `--ease`, respect `prefers-reduced-motion` |
| Add a font | `src/renderer/lib/fonts.ts` + matching `:root[data-font="…"]` block |
| Adjust a font-size setting | `src/renderer/lib/fonts.ts` + the `--type-step` block in `tokens.css` |
| Style markdown | `.markdown <selector>` rules (defined for headings, lists, code, etc.) |
| Style overlays (⌘K / ⌘P / ⌘F palette, review, session chrome) | [overlays-*.css](#overlay-stylesheets): keep import order in `overlays.css` |
| Style app shell / sidebar | [shell-*.css](#shell-stylesheets): `shell.css` aggregator |
| Style Settings | [settings-*.css](#settings-stylesheets): `settings.css` aggregator |
| Style chat / composer / tools | [chat-*.css](#chat-stylesheets): `chat.css` aggregator |

## Shell stylesheets

`styles.css` imports [shell.css](../src/renderer/styles/shell.css) (aggregator only). **Import order is part of the cascade contract.**

| File | Scope |
|---|---|
| `shell-layout.css` | `.app-shell`, sidebar chrome, projects rail, margin-notes nameplate/CTA |
| `shell-sessions.css` | Session rows, pin/archive menus, sidebar search, launcher wrapper hooks |
| `shell-session-icons.css` | Per-row custom icon glyph (with its status overlay dot) and the Edit Icon popover |

## Settings stylesheets

`styles.css` imports [settings.css](../src/renderer/styles/settings.css) (aggregator only).

| File | Scope |
|---|---|
| `settings-layout.css` | Settings shell: left rail, hero, sections, cards, account, metrics |
| `settings-controls.css` | Segmented controls, toggles, font/theme pickers, refresh |
| `settings-diagnostics.css` | Providers list, diagnostics tiles, logs, tables, integrations |

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
| `chat-workspace-card.css` | Floating workspace card in the conversation's right gutter, including the per-chat-width `@container` thresholds that decide whether it fits |

Keep each module under **1000 lines**. Add rules to the matching surface file; do not grow aggregators beyond imports and a short header.

## Overlay stylesheets

`styles.css` imports [overlays.css](../src/renderer/styles/overlays.css), which is only an aggregator (<200 lines). Surface rules live in sibling files under `src/renderer/styles/`; **import order in `overlays.css` is part of the cascade contract**.

| File | Scope |
|---|---|
| `overlays-inkwell.css` | Unified search palette (⌘K / ⌘P / ⌘F / ⌘⇧F) including its `.command-palette-scopes` filter tabs, and the cheat sheet. The `.command-palette-overlay` backdrop uses `--modal-backdrop` from `tokens.css` |
| `overlays-review.css` | Review panel chrome: toolbar, diff list, commit dialog, mode tabs, composer toolbar overrides in review |
| `overlays-review-files.css` | Review file surface: workspace tree, file tabs, file preview (CodeMirror), diff blocks, project-knowledge rows |
| `overlays-launcher.css` | Launcher/session shell: session rows, sidebar tree chrome, approval surface, diff line gutters |
| `overlays-launcher-composer.css` | Composer affordances: send buttons, empty state, bridge banner, toasts |
| `overlays-launcher-panels.css` | Session panels: debug log, integrated terminal, responsive review/log stacking |
| `overlays-launcher-cards.css` | Chat cards in session: plan card and question card |

The palette sits **centered on the work area**, both axes: the `.command-palette-overlay` backdrop covers the whole window but insets its left padding by `--work-area-left-inset` (the shell's sidebar column, `0px` while the sidebar is collapsed), so the dialog lines up with the conversation and composer underneath rather than sitting half a sidebar to their left. The dialog caps at `70vh` so a long result list scrolls inside itself instead of running past the window edges, and its width caps at the work area so a narrow window with a wide sidebar shrinks it instead of pushing it off-screen. Do not reintroduce a top offset.

Palette rows are **one line each**: icon, title at weight 400, secondary text inline (`subtitle`) or pinned right (`meta`, e.g. a session's project). Unselected titles sit on `--text-soft` and the selected row brightens to `--text` — selection changes tone, never weight. Message hits are the one stacked row, because their snippet is the result. Content-search rows swap the glyph column for a right-aligned line number (`.command-palette-line`), which indents each match under its file.

**Every search chord is this one dialog.** ⌘K opens it on All, ⌘P on Files, ⌘F on Messages, ⌘⇧F on Contents, and Tab cycles the tabs from any of them. Do not add a second search modal.

Keep each stylesheet module under **1000 lines**. Split further by surface if a file grows past the cap. Add new rules to the matching surface file. Do not grow aggregator files (`overlays.css`, `shell.css`, `settings.css`, `chat.css`) beyond imports and a short header comment.

## Hard constraints

- **Three themes: Light / Dark / System.** Dark is the default. System tracks `prefers-color-scheme` live when chosen. Dark is **deep charcoal**: near-neutral grays (`#131312` well, only a whisper warm) in the Cursor-dark register — never cool/midnight blue and never pure black. In dark, `--bg` is the darkest well (main view), `--review-panel` (the right review sidebar) sits just above it, `--sidebar` a step above that, and `--panel` is the elevated card surface. Tokens live in `:root` (light) and `:root[data-theme="dark"]`. Active mode persists under `argmax.theme.mode` localStorage and `userData/theme.json` (Tauri-side for no-flash startup). See [src/renderer/lib/theme.ts](../src/renderer/lib/theme.ts).
- **Accent tint is chrome-only.** Settings → Appearance lets users pick `green`, `purple`, `neutral`, `orange`, or `blue`. The choice persists under `argmax.accent.tint` and sets `<html data-accent="…">`. Use `--accent`, `--accent-soft`, and `--accent-deep` for decorative brand/chrome tint: focus rings, selection, picker states, command palette selection, launcher decoration, and transcript metadata. The live-work marks ride the accent too. The mascot, the sidebar's working nest, and a running sub-agent's nest all wear the chosen tint, so "something is running" reads in the app's own color.
- **Text weight flows through tokens too.** `:root` sets `font-weight: var(--weight-ui)` so all chrome inherits one value; chat bubbles and `.markdown` opt up to `--weight-prose`. Variable picks expose a `wght` axis, so dark mode runs both slightly under regular (`380` / `390` against light's `400` / `400`) because light-on-dark strokes bloom and read as semi-bold. The default Geist Sans ships static weights, so the browser clamps the shave to `400` for it; the under-regular values are a real render only for variable picks like Inter or Manrope. `body` also asks for grayscale antialiasing for the same reason. Regular UI labels and body prose stay on the tokens; list labels and section titles top out at `500`, real emphasis (`.markdown strong`, risk copy, dirty markers, approval CTAs) sits at `520`–`700`. Don't reintroduce `font-weight: 600` on a list label. Mono surfaces pin `400` instead of inheriting, since their stacks have no axis to shave.
- **Fonts flow through tokens.** Never hardcode a family. Chrome reads `--font-ui`, long-form chat prose and the session composer read `--font-prose`, terminal reads `--font-mono`, and review/editor code plus inline markdown code/file refs and transcript tool targets read `--font-code` (Codex-like system mono by default). Mono font picks set UI/mono variables to the same stack while chat prose stays proportional; sans picks keep a system mono stack for code/terminal except the default Geist Sans, which pairs Geist Mono.
- **Font sizes flow through tokens.** Never hardcode a text `font-size` in px. There is one type scale in `tokens.css`, shifted whole pixels by `--type-step`: `[data-font-size="1"]`…`="5"` set the step (`-2px`…`+2px`), and the token block is declared on `:root, [data-font-size]` rather than `:root` alone, so any subtree carrying the attribute recomputes every size from its own step. Levels 2, 3 and 4 are the sizes the old Small / Default / Large setting shipped. 3 is the default. Two independent sizes exist, both on the 1–5 scale in Settings → Appearance:
  - **App font size** flips `<html data-font-size="…">` and covers app chrome: sidebar, titlebar, settings, the full-screen launcher, and global overlays such as the command palette. Persisted under `argmax.font.size`.
  - **Agent window font size** flips `data-font-size` on the session grid root (`.session-multigrid` in `SessionMultiGrid.tsx`), so conversations, composers, tool and thinking cards, and agent activity panes re-resolve the type tokens on their own. Persisted under `argmax.font.size.chat`, and an install with no chat key inherits the app value so nothing jumps on upgrade.

  Every size setting stores a level from [scaleLevel.ts](../src/renderer/lib/scaleLevel.ts). A setting still holding a pre-scale id (`small` / `large`, `narrow` / `wide`) migrates onto its level on read, and the next persist writes the level back.

  Neither size has a keyboard shortcut. Settings is the only entry point. Terminal/xterm surfaces must resolve `--text-terminal` through the helpers in `src/renderer/lib/fonts.ts`, because canvas text cannot inherit CSS variables directly. That resolution reads `documentElement`, so the terminal keeps its own size and follows app chrome rather than the agent-window setting.
- **Geist Sans + Geist Mono is the default pairing** (`@fontsource/geist-sans` + `@fontsource-variable/geist-mono`, loaded on cold launch since Geist Sans is the default; the sans pick pairs Geist Mono into `--font-mono` / `--font-code`). Lilex remains available, with Nerd Font glyphs patched in so terminal-style glyphs still render. Mono alternates (JetBrains Mono, Fira Code, IBM Plex Mono) and the other sans options (Inter, IBM Plex Sans, Manrope) are lazy-loaded via `@fontsource` / `@fontsource-variable` only when picked, and selected from Settings → Appearance. System fonts (System Mono, Menlo, Monaco) need no JS asset load. New fonts live in [src/renderer/lib/fonts.ts](../src/renderer/lib/fonts.ts) and get a matching `:root[data-font="…"]` block in `tokens.css`. The active choice persists under the `argmax.font.family` localStorage key.

## Tokens

Defined on `:root` in [tokens.css](../src/renderer/styles/tokens.css). Always reference these; don't hardcode hex values mid-file.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--sidebar`, `--panel`, `--review-panel`, `--panel-soft`, `--panel-sunken` |
| Lines | `--line`, `--line-soft`, `--line-strong` |
| Ink | `--text`, `--text-soft`, `--muted`, `--muted-strong`, `--ink`, `--ink-soft` |
| Fonts | `--font-ui`, `--font-prose`, `--font-mono`, `--font-code` |
| Weight | `--weight-ui` (chrome, applied on `:root`), `--weight-prose` (chat bubbles and `.markdown`) |
| Chrome accent | `--accent`, `--accent-soft`, `--accent-deep`: configurable brand/chrome tint, defaults to the green `--sage*` values |
| Scrollbars | `--scrollbar-thumb`, `--scrollbar-thumb-hover`: global scrollbar thumb colors. Light mode stays pale gray; dark-family themes keep contrast |
| Session icon palette | `--session-icon-green`, `-teal`, `-blue`, `-violet`, `-plum`, `-clay`, `-amber`, `-pink`: decorative palette behind the sidebar's Edit Icon picker. Never use these for status. |
| Status | `--sage` (online/success/approve), `--amber` (waiting), `--rose` (error/risk), each with a `*-soft` companion. Keep status chips, diffs, checks, file-change cards, code additions, and logs on semantic tokens. Do not migrate them to `--accent*`. The working nests are the deliberate exception (see accent tint above). |
| Syntax | `--syntax-keyword`, `--syntax-definition`, `--syntax-string`, `--syntax-type`, `--syntax-constant`, `--syntax-variable`, `--syntax-comment` for CodeMirror file previews |
| Elevation | `--shadow-1`, `--shadow-2`, `--shadow-3` |
| Radii | `--radius-xs` (3px), `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (8px), `--radius-xl` (10px). Prefer tokens; reserve `999px` / `50%` for truly circular elements only (status dots, toggle knobs). |
| Motion | `--ease` (cubic-bezier), `--duration-fast` (140ms), `--duration-base` (220ms); newer code prefers `--motion-fast` (120ms), `--motion-base` (180ms), `--motion-slow` (240ms), `--ease-out`, `--ease-in-out` |
| Spacing | `--space-1` (4px) through `--space-8` (32px). Use these for paddings, gaps, and margins; reserve raw `px` for one-off optical adjustments. |
| Type | `--text-4xs` (9px), `--text-3xs` (9.5px), `--text-2xs` (10px), `--text-xs` (11px), `--text-sm` (12px), `--text-base` (13px), `--text-md` (15px), `--text-lg` (18px), `--text-xl` (20px), `--text-2xl` (22px), `--text-display` (23px), and `--text-terminal` (13px). Half-step `*-plus` / `*-tight` tokens support dense surfaces. |
| Focus | `--ring`: stronger per-component focus rings layered on top of the global inset `--line-strong` rule. |

Future text-size changes should update the shared token block or `--type-step`, not individual component rules. A nested container that sets `data-font-size` re-derives every type token for its subtree. Reduced-motion users get a zero override on the motion tokens via `@media (prefers-reduced-motion: reduce)`.

## Patterns

- **Status-driven coloring.** Components carry `data-status` / `data-state` / `data-risk` attributes; CSS picks the color via attribute selectors. Don't conditionally swap classes in JSX.
- **Status edges.** A running `.tool-call-item` stays quiet: a softened border (`--line-soft`) on `--panel-soft`; an errored one keeps the normal border on the same soft panel ([chat-turns.css](../src/renderer/styles/chat-turns.css)). Status color rides the icon instead — `--accent` running, `--rose` error. The icon signals the tool *type*, while color signals state. `data-tool-type` (`bash | edit | read | search | web | agent | other`, set by `getToolTypeBucket()` in [toolCalls.tsx](../src/renderer/lib/toolCalls.tsx)) is still carried for the icon and the agent-row treatment (`.tool-call-row[data-tool-type="agent"]`), but no longer drives a per-type accent bar.
- **Motion.** Use `surface-in` / `fade-in` on mount, `msg-in` (and `msg-in-right` for user bubbles) on chat additions, `status-pulse` on running indicators, `working-nest-pulse` on the shared four-dot working nest ([WorkingNest.tsx](../src/renderer/components/WorkingNest.tsx), [working-nest.css](../src/renderer/styles/working-nest.css)). It is one mark for every live surface: the sidebar row's marker while a turn is in flight (shown in place of any custom icon), a running agent launch row, an agent tab, and the agent pane header, all staggering their dots a quarter of `--working-nest-cycle` apart. Use `tool-call-flash` on new tool arrivals, `detail-expand` when a tool call row opens, and the thinking indicator pulse/typing affordances. New animations define a keyframe, reuse `--ease`, and respect the `prefers-reduced-motion` block at the bottom of the file.
- **Markdown rendering.** Assistant bubbles render via `react-markdown` inside a `.markdown` wrapper. Style markdown elements through `.markdown <selector>` rules (already defined for `p`, `ul/ol`, `code`, `pre`, `a`, `blockquote`, `hr`, `table`, `h1-h4`). Keep prose on `--font-prose`; reserve `--font-code` for inline code, file refs, fenced code, transcript tool targets, and editor surfaces so agent output reads like writing with code in it, not a terminal transcript. Top-level prose blocks are capped to a readable measure while tables and fenced code keep the full available width. The review-files markdown preview (`.file-preview-markdown`, [overlays-review-files.css](../src/renderer/styles/overlays-review-files.css)) is the exception: it caps *every* top-level block at `--file-preview-measure` (720px) and centers the column, so a whole file read top-to-bottom keeps one set of edges instead of letting short code blocks and tables span the review pane. Inline file refs are text-only `FileChip` buttons, with no leading code icon in prose.
- **Thinking indicator timing.** The thinking bubble is not a transcript item. Render it during silent gaps in a running turn: before the first answer, after completed answer chunks, and after completed tool rows while the model chooses the next step. Hide it while text is actively streaming, while a visible tool row is running, or while an interactive card is waiting on the user; raw provider output alone must not hide it. The initial empty beat appears immediately. Most mid-turn gaps wait 700 ms before showing; gaps after completed assistant text wait 1800 ms so the terminal session-state delta can land without a bogus tail flash. Once shown, the label stays visible for at least 600 ms.

## Background atmosphere

`body` carries a low-opacity SVG fractal-noise data-uri for paper grain. Don't replace surfaces with flat `#fff`; the grain is part of the app's texture. Surfaces should still feel layered (panel over sidebar over bg) via the `--panel-*` scale, not through borders alone.

## Chat bubbles

User message bubbles (`chat-bubble.user`) use `--user-message-bg` / `--user-message-fg` / `--user-message-shadow`. Light mode uses a borderless light gray surface; dark swaps in a theme-matched elevated surface so long user prompts do not become harsh slabs.

`::selection` uses a translucent accent tint globally. Inside user bubbles, `.chat-bubble.user ::selection` uses `--user-message-selection-bg` so the highlight stays visible against each theme's user-message surface.

## Conversation content width

Settings → Appearance exposes Chat width on the same 1–5 scale, persisted under `argmax.chat.width` and mirrored on `.app-shell[data-chat-width]`. The levels set `--chat-content-width` / `--chat-content-width-docked` / `--chat-content-width-tight` to `520/480/440px`, `640/600/560px`, `780/740/680px` (the default), `940/900/840px`, or `1100/1060/1000px`. Levels 2 to 4 are the widths the old Narrow / Default / Wide setting shipped. The full new-session launcher ignores the selected content width and caps its shell at `760px` (`.launcher-shell`, `width: min(100%, 760px)`) so its control row has room. Embedded launchers remain capped to their grid cell. `--session-inline-padding` is defined on `.session-main-column` as `clamp(28px, calc((100% - var(--chat-content-width)) / 2), 2000px)`, with tighter gutters when the review or log panel is open (`22px`) or both are open (`20px`). This keeps readable content centered in wide panes while preserving a real gutter in narrow grid panes. `.conversation-list` consumes the token as its inline padding.

Settings → Appearance also exposes Files panel side, persisted under `argmax.review.panelSide` and mirrored on `.app-shell[data-review-panel-side]`. The default `right` keeps the Review // Files panel docked right of the conversation; `left` docks it IDE-style on the left via left-scoped grid variants and `order: -1` in `chat-conversation.css` — DOM order is unchanged, so both `SessionPane` and the launcher overlay render paths are unaffected. Left mode flips the panel's divider to `border-right`, moves the resize handle to the panel's right edge, and (with the sidebar collapsed) shifts the macOS traffic-light clearance from the conversation heading to the review toolbar. The debug log panel stays right-docked in both modes.

Side-by-side pane resizing bottoms out at `MIN_RESIZABLE_CELL_WIDTH_PX` in `SessionMultiGrid.tsx`; the session composer switches to its compact container layout before that floor so the controls settle before the app stops shrinking. When a review/log panel is docked, that cell's floor becomes `CHAT_PANE_MIN_WIDTH_PX + <active panel width>`, so window resizing shrinks the chat pane first while preserving the side panel width. The app also sets a live window/sidebar minimum from the grid row width, so an existing row cannot be squeezed below its active pane floors.

## Dark Theme: Warm Charcoal Editorial

Dark mode follows six rules:

1. **Warm blacks, never blue.** Hues sit around 80° (yellow side of neutral), chroma stays very low.
2. **Paper-inversion.** The body grain SVG references `var(--grain-color)` so it flips polarity automatically.
3. **Accents lifted, not loud.** Sage / amber / rose gain ~10pp lightness and shed ~15% chroma. They should read warm and confident, never neon.
4. **Depth from edges, not shadows.** Dark elevation uses a 1px inset top-highlight + heavier drop in `--shadow-1/2/3`. The pixel of warm light at the top of an elevated card is the signature detail.
5. **`color-scheme` follows.** `:root` declares `light`, `:root[data-theme="dark"]` declares `dark`, so native form controls + scrollbars track.
6. **Ink stops short of paper-white.** `--text` is `#e3e0d8`, not `#f4f2ec`: full white on dark charcoal blooms and reads bold even at regular weight. Pair it with the lowered `--weight-ui` / `--weight-prose` rather than reaching for a brighter hex.

Status colors keep semantic meaning across modes; values differ. Add new tokens to both theme blocks (`:root`, `[data-theme="dark"]`) at the same time.

## Don't

- Don't introduce a UI library (shadcn, Radix, MUI, Tailwind). The whole point is a hand-built feel.
- Don't add focus rings beyond the global `:focus-visible` rule — `outline: none` plus `box-shadow: inset 0 0 0 1.5px var(--line-strong)` in [tokens.css](../src/renderer/styles/tokens.css), with `input`/`textarea`/`[contenteditable]` opting back out. It already covers everything; component rules that need a stronger ring use `var(--ring)`.
- Don't write inline `style={{}}` props in JSX for anything beyond truly dynamic values; everything else belongs in `styles.css`.
