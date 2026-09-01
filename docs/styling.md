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
  - In dark mode the palette is two-tone: `--bg` is neutral charcoal (`#141414`) and the chrome surfaces — `--sidebar`, `--panel`, `--review-panel` — share one lighter fill (`#1a1a1a`), so the app reads as a background plus a surface rather than a staircase of near-blacks.
  - `--review-sidebar` (the review panel's file-tree column) steps *down* from `--review-panel` on paper and *up* in dark, the same inversion `--tool-block-surface` uses. Do not reach for `--panel-sunken` here: in dark it is the darkest surface in the app, and a column set from it reads as a hole punched in the panel.
  - Ink uses `#e3e0d8` rather than pure white to avoid bloom on dark backgrounds.
  - Rendered prose is the exception: `--prose-ink` / `--prose-ink-strong` (agent answers, plan cards, file previews) run *brighter* than `--text` in dark, because bloom is a weight problem at label size and prose already offsets it with `--weight-prose` and an open line box. `--prose-ink-strong` must stay on the far side of `--prose-ink` from the page in both themes, or bold prose reads dimmer than the body around it. Agent paragraphs are painted by `.chat-bubble p`, which beats the inherited `.markdown` ink, so both rules name the same token.
- **Accent Tints:** Settings → Appearance allows selecting `green`, `purple`, `neutral`, `orange`, `blue`, or `coral` (`<html data-accent="...">`). `coral` sits at the same hue as the `--rose` error token, so it is the one tint where risk states read less distinctly from brand chrome. Use `--accent`, `--accent-soft`, and `--accent-deep` for interactive highlights, focus rings, brand chrome, and running indicators (`WorkingNest`). User-message bubbles read `--user-message-bg` / `--user-message-fg`: in dark, green/orange/blue/neutral use a deeper fill with white ink so `--accent` can stay lifted for chrome. Purple still fills the bubble with `--accent`.
- **User bubble tint:** Settings → Appearance → Your message bubbles takes user bubbles off the accent (`<html data-user-bubble="accent" | "neutral">`, stored in `localStorage.argmax.chat.bubbleTint`). `neutral` fills with `--panel-sunken` on paper and `--panel-soft` in dark, so an un-tinted bubble sits one surface step off the page rather than carrying a fill of its own. The two `[data-user-bubble="neutral"]` blocks must stay last in [tokens.css](../src/renderer/styles/tokens.css) — they tie the dark per-accent blocks on specificity, so source order is what makes the opt-out win. Filled transcript cards share `--radius-2xl` with `.session-input` and `.composer`: `.chat-bubble.user`, `.plan-card` (and QuestionCard, which reuses it), and the subagent instructions/result cards.
- **Typography:**
  - Chrome: `--font-ui` (Geist Sans default).
  - Prose: `--font-prose`.
  - Code & Editor: `--font-code` (Geist Mono / system mono). The font picker rewrites `--font-ui` and `--font-mono` only, so `--font-code` names Geist Mono whatever is picked — `loadFontAssets` therefore loads the Geist Mono bundle alongside every choice. It used to ship only with the two Geist options, which left every code surface on a non-Geist font silently rendering the `ui-monospace` fallback.
  - Terminal: `--font-mono`.
  - **Programming ligatures are off wherever the app renders text it did not author** (tool output, command lines, diffs, log output, markdown code, terminal transcript) via `font-feature-settings: var(--code-font-features)`. A pytest banner's run of `=` otherwise fuses into a solid bar that reads as struck-through output. Reach for that token, not `font-variant-ligatures: none`: `:root` enables `calt` through `font-feature-settings` for the UI sans, and that property is step 5 of [font feature resolution](https://drafts.csswg.org/css-fonts-3/#feature-precedence) against font-variant's step 3, so only the same property reaches the `calt`-based fonts (Fira Code, JetBrains Mono, Lilex). Geist Mono ligates through `liga`. Pinned by `accentTokens.test.ts`.
  - Mono blocks in the transcript sit a step under the prose they interrupt (`--text-xs` against the `--text-base` answer): diff cards, tool output, and command lines. Geist Mono is drawn on the same x-height as Geist Sans, so equal point sizes do not read as equal — mono spans 1.30em of ink to the sans 1.14em and carries a wider advance, and a block set at the prose size looks a size larger than it is.
  - Text weights use `--weight-ui` (`:root`) and `--weight-prose` (chat bubbles and `.markdown`). Variable font stacks run slightly lighter in dark mode (`380`/`390`) to compensate for dark-background bloom.
- **Type Scale:** Controlled via `[data-font-size="1"]` through `="10"` on `:root` and `.session-multigrid`. App font size (`argmax.font.scale`) and agent window font size (`argmax.font.scale.chat`) scale independently.
  - The workspace card and review panel use `data-type-scale="chrome"` so control chips and sidebars stay at app-chrome scale.
  - Both composers (launcher and session) use `data-type-scale="composer"`, one step above chrome, so the prompt text and its chips read comfortably. Like `chrome`, it is anchored to the app font size rather than the surrounding container's.
  - Terminal surfaces resolve `--text-terminal` in pixels via helpers in `src/renderer/lib/fonts.ts` using `@property` length registrations.
- **Focus Rings:** Global focus uses `outline: none` and `box-shadow: inset 0 0 0 1.5px var(--line-strong)`. Specific controls use `var(--ring)`.

## Tokens

Defined in [tokens.css](../src/renderer/styles/tokens.css):

| Category | Tokens | Description |
|---|---|---|
| Surfaces | `--bg`, `--sidebar`, `--panel`, `--review-panel`, `--review-sidebar`, `--panel-soft`, `--panel-sunken` | Base backgrounds and elevated panels |
| Lines | `--line`, `--line-soft`, `--line-strong` | Borders and dividers |
| Text | `--text`, `--text-soft`, `--muted`, `--muted-strong` | Primary, secondary, and disabled text |
| Fonts | `--font-ui`, `--font-prose`, `--font-mono`, `--font-code` | Font stacks |
| Accent | `--accent`, `--accent-soft`, `--accent-deep` | User-configured theme accent |
| Status | `--sage` (success/approve), `--amber` (warning/waiting), `--rose` (error/risk) | Semantic state colors (with `*-soft` variants) |
| Radii | `--radius-xs` (3px), `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (10px), `--radius-xl` (14px), `--radius-2xl` (20px) | Corner radii |
| Spacing | `--space-1` (4px) to `--space-8` (32px) | Standard layout spacing steps |

## Component Patterns

- **Attribute-Driven Styling:** Use `data-status`, `data-state`, and `data-risk` attributes for state styles instead of dynamic JSX class names.
- **Settings is one row shape.** Every setting is a `SettingRow` — label, optional one-line description, control on the right — stacked inside a `SettingGroup`'s card ([settingsPrimitives.tsx](../src/renderer/components/settings/settingsPrimitives.tsx)). Add a setting by adding a row, not by inventing a layout: no per-control legend, no caption block under a control, no section eyebrow. A control that needs full width (a path, a command list) is a `.settings-field` inside the same card and borrows `.settings-row-label`'s typography. `.settings-card > *` carries the row inset, so any block dropped into a card is aligned automatically — never add horizontal padding of your own. Wide controls wrap onto their own line under the label (the row is `flex-wrap: wrap` with `justify-content: space-between`), so a five-option segmented never crushes the description beside it.
- **Settings owns the sidebar column.** Opening settings swaps `Sidebar` for `SettingsRail` and stamps `data-settings-open` on `.app-shell`; the rail is a fixed `--settings-rail-width` and shows even when the app sidebar is collapsed. The active group lives in `App`, not in the lazily-mounted panel, because the rail renders outside `Suspense`.
- **Motion:** Use `--motion-fast` (120ms), `--motion-base` (180ms), and `--motion-slow` (240ms). Respect `@media (prefers-reduced-motion: reduce)` overrides.
- **Markdown:** Assistant messages render via `react-markdown` inside `.markdown` containers. Prose blocks are constrained to a readable measure while code blocks and tables expand to full width. A table renders inside a `.markdown-table-scroll` block ([MarkdownTable.tsx](../src/renderer/components/MarkdownTable.tsx)) because a table is sized by its content: `width: 100%` is a floor, not a cap, so a wide one otherwise overflows the column and the transcript's own scroller starts moving sideways with every message in it. `.conversation-list` scrolls on the vertical axis only, and mobile allows `pan-x` on it so the boxed table can still be dragged across — `touch-action` intersects down the ancestor chain, so a `pan-y` lock above would veto the child's sideways scroll.
- **The markdown ink/weight ladder must stay monotonic.** `h1`–`h3` on `--prose-ink-strong` at 570–600, `strong` at 520 on the same ink, body on `--prose-ink` at `--weight-prose`. Painting headings from `--text-soft`/`--muted` puts them *behind* the paragraphs they introduce and lets bold body text win the page, which reads as one flat river in a heading-heavy answer. Size does little of the work — the range is one token wider than the body (`--text-lg-tight` → `--text-sm`) so an answer full of `##` never shouts inside a 780px column. Heading space is asymmetric: generous above, tight below, with `:where(h1, h2, h3, h4) + *` zeroing the following block's top margin. `h4` is the only small-caps step. Pinned by `accentTokens.test.ts`.
- **Markdown vertical rhythm is one system.** Paragraphs 15px apart; a lead-in tightens to 8px and marks its list by proximity alone (a weight lift there reads as a wall of semibold heavier than the real heading above it). List rows carry no margin of their own — `li + li` sets 9px, nested 6px — because a row's gap has to beat its own 20.8px leading or a wrapped continuation reads as the next bullet. `pre`, `blockquote` and `.markdown-table-scroll` share one 18px gap. List gutters are **em-based**: `--type-step` runs the body from 10px to 19px, and a px gutter sized for `11.` at 13px is overflowed at 19px.
- **The table's gap belongs to `.markdown-table-scroll`, never to `table`.** The wrapper is a BFC (`overflow-x: auto`), so a margin on the table adds inside the box instead of collapsing out of it.
- **Zero-specificity resets silently lose.** `.markdown :where(h1, h2, h3, h4) + *` scores (0,1,0) and is beaten by `.markdown pre` (0,1,1), so it does nothing. The heading reset uses `:is()` with an explicit target list — (0,1,2) — and leaves headings out of that list so a subheading keeps its own space under its parent.
- **Reasoning is secondary text.** `.thought-block-body .markdown` re-inherits the muted color for headings and for the single-item-`ol` pseudo-heading, which paint their ink on the element and so escape a container-level `color: inherit`.
- **Command Palette:** The search modal (`.command-palette-overlay`) is centered on the window, like the commit dialog — search is app-wide, so it is not offset past the sidebar onto the work area. ⌘K opens All, ⌘P on Files, ⌘F on Messages, ⌘⇧F on Contents. It sits on `--overlay-panel` and marks the active row and filter pill with `--overlay-panel-raised`: in dark the dialog is darker than `--panel` and the active row is the raised one, in light both invert. Result rows set `data-group`, which picks the `--palette-icon-hue` their glyph reads; file rows drop the hue and render the type-colored `@react-symbols` glyph the review file tree uses.

## Guidelines

- Avoid adding third-party UI component libraries (shadcn, Radix, Tailwind).
- Avoid inline `style={{}}` attributes in JSX for static styling; use classes and tokens.
- Use semantic status tokens (`--sage`, `--amber`, `--rose`) for status badges, checks, and diffs rather than accent tint tokens.
