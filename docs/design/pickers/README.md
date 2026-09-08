# Pickers — mockups

The dropdown menus (model, project, branch, the settings list pickers, and the
dozen action menus that share `.project-picker-popover`) read as plain: one type
size, hairlines instead of names, no mark on the chosen row, and a cap that
makes the 35-model list scroll from the first pixel. This page puts the shipped
menu next to three candidates so the choice is made by looking.

```bash
npx vite --port 5241 --strictPort            # from the repo root
open http://127.0.0.1:5241/docs/design/pickers/index.html
```

It loads the real `tokens.css`, `chat-chrome.css`, `settings-controls.css`, and
the Geist faces the app bundles. The **Shipped** column uses the app's own class
names, so it is the real CSS. The variants use their own `.pk-*` classes so the
cascade cannot leak either way; the winner gets ported into `chat-chrome.css`.

Header controls: theme, app font size (the `data-font-size` steps), row height
(26 / 28 / 30 / 32, the size axis on its own), accent, and a "filter typed"
state. Query parameters do the same for capture:
`?theme=light&size=6&rowh=30&filter=1`, and `?frame=a` renders section 5 alone.

## What is wrong today

Measured from the shipped rules, at the default font size:

| | Shipped |
| --- | --- |
| Row type | `--text-xs-plus`, 11.5px |
| Row height | 25px (5px padding + 1.35 line) |
| Menu padding / radius | 5px inside a 14px corner, so the first row's 4px corner sits in a 9px void |
| Model list | 220px wide, capped at 320px: ten of 35 rows visible, providers marked by hairlines only, Cursor rows alone carry their provider in the label |
| Project / branch list | 200px wide, capped at `min(260px, 22dvh)`: about 180px on a 13-inch screen, six rows; long branch names wrap to two lines |
| Chosen row | a fill one step off the panel (`--row-selected`); in the settings picker it is `--panel-sunken`, the darkest surface in dark mode |
| Leading column | 13px glyph on project and branch rows, nothing on model rows, so labels start at different x across the menus |

## The variants

All three share one base: 12px rows (`--text-sm`) on a 28px min-height, a 5px
inset inside a 10px corner with 6px row corners, a fixed 16px leading cell that
holds the glyph or a check on the chosen row so every label sits on the same
column, named groups instead of bare hairlines, `--shadow-3` under the menu, and
a cap of `min(440px, 60dvh)`. The settings trigger goes 26 → 28px and 11 → 12px
to match.

- **A · Tune** — only the base. Group names are text. The smallest change that
  fixes the hierarchy.
- **B · Two lines** — a quieter second line where the data already exists:
  provider, context window and list price on models (`providerModels.ts`), the
  path on projects. Group headers carry the provider's Usage-page dot. 44px
  model rows; the 13-inch frame shows ten rows where A shows fourteen.
- **C · Ledger** — one line, a right-hand column for the context window (or the
  "needs login" / "not installed" annotation), and provider headers with the dot
  that stay put while the list scrolls.

Not in scope here: the composer chips that open these menus, and the effort
slider. The Speed row keeps its submenu in every variant.

## Captures

Dark unless the name says otherwise, default font size, 28px rows.

- `model-dark.png`, `model-light.png` — section 1.
- `model-dark-filter.png` — section 1 with a query typed.
- `project-dark.png`, `branch-dark.png`, `settings-dark.png` — sections 2–4.
- `frame-*.png` — section 5, 1280 × 832: the launcher with the model menu
  open. The composer sits mid-window, so Floating UI flips the menu upward and
  clamps it to the room above; the frame mirrors that.

## Decision

**C · Ledger at 28px rows**, shipped 2026-09-08 into the shared primitive
(`.project-picker-popover` / `.project-picker-item` in `chat-chrome.css`) so
every menu on it changed at once, plus the settings trigger in
`settings-controls.css`. The lead cell is `PickerLead.tsx`. Project rows took
B's one good idea as their trailing column: the parent folder, so two checkouts
of one repository read apart. Group headers are one class everywhere now — the
sidebar's sort menu dropped its private copy. The slash and `@file` autocomplete
menus in the composer are a different family (full-width, in the input's slot)
and were left alone.
