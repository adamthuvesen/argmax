# Styling

Argmax uses plain CSS, with no CSS-in-JS, Tailwind, or preprocessor. [styles.css](../src/renderer/styles.css) imports the modular stylesheets under `src/renderer/styles/`. Tokens live in [tokens.css](../src/renderer/styles/tokens.css), which is the source for every value. This doc holds the rules a stylesheet cannot state.

## Rules

- Import order defines the cascade. Aggregator files such as `chat.css` contain only imports.
- Keep each surface file under 1,000 lines.
- Do not add third-party UI component libraries.
- Do not use inline `style={{}}` for static styling. Use classes and tokens.
- Use `data-status`, `data-state`, and `data-risk` attributes for state styles, not dynamic class names.
- Use status tokens (`--sage`, `--amber`, `--rose`) for badges, checks, and diffs, not accent tokens.
- Every visual change ships light and dark screenshots ([verification.md](verification.md)).

`accentTokens.test.ts` pins the values listed here as pinned.

## Corner radii

Rounded UI uses `--radius-ui`. Size aliases such as `--radius-sm` and `--radius-2xl` all resolve to it. Do not introduce separate radii by component size until a new scale is agreed.

Two shapes differ: `--radius-chat` for workspace cards and chat bubbles, and `--radius-composer` for composers, their drop overlays, and queued trays. True circles, joined edges, diff lines, and chart geometry keep their required shape.

## Themes

Light, Dark, and System modes. System is the default. `lib/theme.ts` persists the choice in `localStorage` and `userData/theme.json`.

New installs use System, monochrome activity icons, the Halo activity mark, and neutral user bubbles. Saved choices take priority.

`background-intensity.css` and `sidebar-intensity.css` derive neutral surfaces from independent 0–100 numbers set on `<html>`. The original palette stays in `tokens.css`, so dark 70 and a page without the attribute keep their exact colors. Contrast (`--contrast`) moves only the three line tokens. Text weight stays with ink strength.

Surface tokens that invert or surprise:

- **`--composer-surface`** sits above `--panel` in dark, so the field reads as live. On paper `--panel` is already the brightest, so `--composer-edge` draws a hairline instead. It rides in `box-shadow`, so it costs no layout.
- **`--review-sidebar` and `--tool-block-surface`** step down on paper and up in dark. Do not use `--panel-sunken` for them. In dark it is the darkest surface in the app, so a column set from it reads as a hole.
- **`--popover`** paints every floating surface. A new floating surface uses it, never `--panel`. In dark it follows the lighter of the two intensity dials, so a menu stays above both grounds.
- **`--question-dock-row`** replaces `--row-selected` in the question dock. The dock sits on the composer surface, where `--row-selected` lands one value away from its ground and the selection disappears.

Ink tokens:

- Ink avoids pure white, to prevent bloom on dark backgrounds.
- `--chip-ink` is for the composers' secondary chips. Inside the model pill the label takes `--text`, because it is the headline of the only filled control in the row.
- `--prose-ink` runs brighter than `--text` in dark, because bloom is a weight problem at label size. `--prose-ink-strong` must stay on the far side of `--prose-ink` from the page in both themes, or bold reads dimmer than body. `docs/design/prose-ink` holds the comparison.

## Accents and bubbles

`lib/accent.ts` lists the accents. Use `--accent`, `--accent-soft`, and `--accent-deep` for interactive highlights, focus rings, and running indicators. Color alone must not distinguish risk from accent chrome, so errors keep rose and coral stays distinct from it.

Accent text, deep text, and bubble ink keep contrast floors, except the chosen light orange bubble ink. `docs/design/accents` holds the comparison.

User bubbles read `--user-message-bg` and `--user-message-fg`. The two `[data-user-bubble="neutral"]` blocks must stay last in `tokens.css`. They tie the dark per-accent blocks on specificity, so source order is what makes the opt-out win.

A running sidebar row with a custom icon uses the icon's color for its nest, so the animation keeps the row's identity.

## Provider and emblem colors

A provider's color follows its identity, not its rank. `.usage-series[data-provider]` sets `--usage-series` once, and every mark reads it, so a window that reorders rows never repaints them. The values were picked with the `dataviz` skill's validator. Re-measure when a `--usage-*` value changes. `--usage-codex` is a deliberate exception to the chroma floor, and it pays with the dot, the name, and the chart's hidden table.

Subagent emblems ride the session icon palette, and their color is never a status. [agent-emblems.css](../src/renderer/styles/agent-emblems.css) derives every shade from one `--emblem-face`, so a theme switch repaints all marks at once. Failure greys the face and adds a `--rose` corner dot, and it never recolors the hue, because the hue names the agent. The bevel is three passes over one path, because a `<defs>` gradient would make every copy share one id.

## Activity icons

Settings → Appearance → Activity icons chooses Monochrome (the default) or semantic Color. The legend is in [tool-activity.css](../src/renderer/styles/tool-activity.css) and is shared with the phone ([chat-cards.md](chat-cards.md#activity-rows)). It does not follow the accent. The gate does not recolor navigation, status, sidebar, or header icons.

Flattening a multicolor mascot to one color leaves a solid lump. [serverIcons.ts](../src/renderer/lib/serverIcons.ts) therefore tags its layers with a tone, and CSS turns those into depths of one ink. The ramp inverts between themes, because it runs away from the row the icon sits on. [export-ios-tool-icons.mjs](../scripts/export-ios-tool-icons.mjs) bakes the same ramp into `-mono` image sets for the phone.

## Typography

Roles: `--font-ui` for chrome, `--font-prose` for prose, `--font-code` for code and editor, `--font-mono` for the terminal. iPhone type resolves through [Typography.swift](../ios/Argmax/Sources/Design/Typography.swift) under the same `argmax.font.family` key.

- The font picker rewrites `--font-ui` and `--font-mono` only, so `--font-code` always names Geist Mono. `loadFontAssets` therefore loads the Geist Mono bundle with every choice.
- **Programming ligatures are off wherever the app renders text it did not author.** Use `--code-font-features`, not `font-variant-ligatures: none`. `:root` enables `calt` through `font-feature-settings`, which outranks font-variant, so only the same property reaches `calt`-based fonts. Pinned.
- Mono blocks in the transcript sit a step under the prose, because Geist Mono carries a wider advance and reads a size larger at equal points.
- Dark runs variable fonts slightly lighter, to compensate for bloom.
- Font heaviness adds `--font-weight-offset`. IBM Plex Mono is the one static family, so a vendored Text face fills 450–499. Otherwise small offsets would snap up.
- App font size and agent window font size scale independently. The workspace card and review panel use `data-type-scale="chrome"`. Session composers inherit the agent scale from `.session-multigrid`, and the standalone launcher writes it onto its form.

### Markdown

Agent answers render inside `.markdown`. Decisions and mockups are in `docs/design/prose-rhythm` and `docs/design/blockquote`.

- **The ink and weight ladder must stay monotonic.** Headings sit above bold, and bold sits above body. Painting headings from `--muted` puts them behind the paragraphs they introduce. Pinned.
- **A bold-only paragraph is a heading.** `isBoldOnlyLine` in [StreamingMarkdown.tsx](../src/renderer/components/StreamingMarkdown.tsx) promotes it, and the phone mirrors it. A bold ending in a colon, or a long one, stays a paragraph.
- **List gutters are em-based,** because the type step moves the body, and a pixel gutter overflows at large sizes.
- **List row gaps** must beat their own leading and stay under the paragraph gap.
- **A blockquote is a hairline, not a callout.** Agents use `>` for verbatim text, so the quote is the payload and must not be dimmed. The accent rule belongs to the live question.
- **A table scrolls in `.markdown-table-scroll`,** because `width: 100%` is a floor, not a cap. Its gap belongs to the wrapper, because a margin on the table adds inside the box rather than collapsing out.
- **Mobile allows `pan-x` on `.conversation-list`.** `touch-action` intersects down the ancestor chain, so a `pan-y` lock above would veto the table's sideways scroll.
- **A fenced block keeps its toolbar in flow,** with or without a language, so controls never cover a short first line.

Specificity traps cost real debugging here:

- `:where()` resets lose. `.markdown :where(h1, h2) + *` scores (0,1,0) and `.markdown pre` beats it. The heading reset uses `:is()`.
- A numeric table column must out-specify its cell reset. `.usage-table th, .usage-table td` scores (0,1,1) and beats a bare `.usage-table-num`.

## Layout

**The shell reflows by script, not by media query.** [useSidebarResize.ts](../src/renderer/hooks/useSidebarResize.ts) sizes the grid columns inline, down to a folded sidebar. `body` therefore has no `min-width`, and no stylesheet may hide `.sidebar` or re-template `.app-shell` at a viewport width. A `display: none` leaves the inline column as an empty band, and a `body` floor clips the composer.

**Container queries fold the composers.** The session composer folds at 600px, and the launcher at 720px, because its row also carries the project and branch pickers. Container queries do not reliably accept `var()`, so `accentTokens.test.ts` pins the literal.

**Settings is one row shape.** Add a setting as a `SettingRow` in a `SettingGroup` ([settingsPrimitives.tsx](../src/renderer/components/settings/settingsPrimitives.tsx)), not a new layout. `.settings-card > *` carries the row inset, so never add horizontal padding.

**Settings owns the sidebar column.** Opening settings swaps `Sidebar` for `SettingsRail`. Schedule, Usage, Activity, and Arc pages keep the app sidebar, so the current chat stays a click away.

**Scrollers dissolve, they do not clip.** Use `.scroll-fade` on a wrapper outside the overflow box ([scroll-fade.css](../src/renderer/styles/scroll-fade.css)). Do not mask the scroller itself, because sticky chrome inside it would fade with the rows. `--scroll-edge-fade-color` must match the fill behind it. Do not put `.scroll-fade` on a node that already has a `::before` or `::after`.

**Every dropdown is one picker primitive.** `.project-picker-popover` and `.project-picker-item` in [chat-chrome.css](../src/renderer/styles/chat-chrome.css) back model, project, and branch menus, settings pickers, and action menus. A chosen row is marked by weight and a check ([PickerLead.tsx](../src/renderer/components/PickerLead.tsx)), never a fill, because a fill means hover. The slash and `@file` menus are a sibling family in [chat-composer-chips.css](../src/renderer/styles/chat-composer-chips.css). Decision: `docs/design/pickers`.

**The composer bottom row is a chip floor.** `--composer-chip` fills every control, with one height and one gap per row, and no carets. A pressed toggle keeps `--accent-soft`, because on/off is the one state worth shouting. The phone mirrors this in [Controls.swift](../ios/Argmax/Sources/Design/Controls.swift).

**The connected timeline** in `chat-timeline.css` owns the activity connector. It never measures layout in JavaScript and never animates its geometry. Stable keyed wrappers keep disclosures open while streaming changes the rows around them.

**Failed user actions use the shared toast** in `state/toast.ts`. Do not also render the failure above a composer or inside a card. Field validation stays beside the input. Ongoing states, such as unsaved changes or uncertain delivery, stay in the affected surface.

## The transparent window

[tauri.conf.json](../src-tauri/tauri.conf.json) sets `transparent` with a macOS window effect, so a region the page leaves unpainted shows the desktop. Only the translucent-window opt-in uses that. Every surface otherwise paints its own ground, and nothing may rely on `body`'s background.

[window-translucency.css](../src/renderer/styles/window-translucency.css) owns everything the mode does. It rebinds tokens to thinned copies, so a surface that paints from a token needs nothing.

- A new menu or full-bleed pane needs one line in the matching list in that file.
- A token derived on `:root` from a thinned one must join the token list, because it inherits already resolved.
- `.workspace` keeps an empty `linear-gradient` background image. With a plain color, WebKit's compositor fills a scrolling page's layer a second time, which computed styles cannot show.
- The theme flip must not set an NSWindow background color, because an opaque one sits in front of the material.

## Usage page

The page widens `--settings-measure` to `--usage-measure`, because five tiles and a 30-day chart do not fit a form's column. Nothing shares a row with the chart, because a 30-day curve in half a window is a smear. Every card is one shape, drawn once in `usage-page.css`.

The chart is hand-rolled SVG with no inline styles ([usage-chart.css](../src/renderer/styles/usage-chart.css)). It is measured with a `ResizeObserver`, not scaled, so text and strokes stay honest. Curves use monotone cubic interpolation, so a quiet day cannot dip below zero. The numbers live in a `.usage-visually-hidden` table, clipped rather than `display: none`, so it stays in the accessibility tree.

## Motion

Transitions live in [motion.css](../src/renderer/styles/motion.css). Use `--motion-fast`, `--motion-base`, and `--motion-slow`, and keep the `prefers-reduced-motion` overrides. A surface that animates out stays mounted through `useMotionPresence`. An anchored popover reads `--popover-transform-origin`. Tablists with unequal labels use `SlidingTabIndicator`.

New infinite animations must animate `transform` or `opacity` on an HTML element ([performance.md](performance.md#animated-properties)).

**Waiting has three shapes** in [loading.css](../src/renderer/styles/loading.css): [SkeletonPane](../src/renderer/components/SkeletonPane.tsx), [LinesSkeleton](../src/renderer/components/LinesSkeleton.tsx), and [LoadingLine](../src/renderer/components/LoadingLine.tsx). No shape shows a "Loading…" phrase, because a phrase reads as content. Every shape takes a `label`, because `role="status"` does not take its name from content. Reuse these instead of adding another skeleton. A page with a strong shape of its own may draw that shape (`.usage-skeleton`).

**The activity mark** has seven styles, selected off `[data-mark]` in [working-nest.css](../src/renderer/styles/working-nest.css). [activityMark.ts](../src/renderer/lib/activityMark.ts) holds the value in a store, because the mark renders in about ten leaf components. Every style shares the box and settle, so a surface with its own identity color keeps tinting them.

**Accent textures** share [pixelField.ts](../src/renderer/lib/pixelField.ts). Do not invent another shader.

## Command palette

`.command-palette-overlay` centers on the window, because search is app-wide. [settingCommands.ts](../src/renderer/lib/settingCommands.ts) lists its direct settings. They apply the same saved preferences as Settings.

Search keeps an explicitly selected result stable as async results arrive, and it leaves Enter to active IME composition. ⌘A opens Actions outside text fields, so inputs, editors, terminals, and native pages keep Select All.
