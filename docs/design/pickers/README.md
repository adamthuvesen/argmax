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
of one repository read apart. Group headers are one class everywhere now. The
sidebar's sort menu dropped its private copy. The slash and `@file` autocomplete
menus in the composer are a different family (full-width, in the input's slot)
and were left alone.

The shared row type was refined to `--text-xs` on 2026-09-15 so picker labels
match the app's compact controls. The 28px row height remains unchanged.

## Revision: Cursor-style ink and groups (2026-10-18)

Compared with Cursor's chat menu, ours read as faded. The cause was not
spacing: Cursor's rows are about 26px against our 28px. These differences
were the cause:

- Our labels were `--text-soft` at the light weight, and our glyphs were
  `--muted`. Both sat close to the panel colour, so the menu looked washed out.
- Cursor splits its actions into groups with dividers. Ours
  was one flat list.
- Our labels mixed title case ("Edit Icon") and sentence case ("Copy ids").
- Cursor's menu box has a soft two-layer shadow and a faint border.

The changes, all in the shared primitive in `chat-chrome.css`:

| | Before | After |
| --- | --- | --- |
| Label ink | `--text-soft` | `--text` |
| Glyph | 14px, `--muted`, stroke 2 | 15px, `--muted-strong`, stroke 1.75; `--text` on hover |
| Row inset / gap | 0 9px 0 7px, 8px | 0 12px 0 9px, 10px |
| Menu inset | 5px | 6px |
| Menu edge | 1px `--line`, `--shadow-3` | 0.5px `--line-strong` at 70%, `--picker-shadow` (a contact shadow under a wide soft drop; dark mode adds a top light) |
| Divider inset | 4px 6px | 5px 10px |

Row height stays 28px. The radii come from the semantic tokens in
`docs/styling.md` (`--radius-surface` for the menu, `--radius-row` for rows).

Action menus now split into groups with `MenuSections.tsx`, which drops a group
whose conditional rows all render null. Every action label is title case. Rows
that move a chat out of its place (Mark Done, Add to Priority, Snooze) sit in
the last group, away from Rename. A destructive row (Remove Project) sits alone
after a divider. Submenus were not adopted: a submenu with one row is worse
than the row.

Captures: `action-menus-light.png` and `action-menus-dark.png` show, left to
right, the sidebar right-click menu, the chat actions menu, the project
actions menu, the identity menu, the sidebar view options, the review tab menu,
and the model picker.
