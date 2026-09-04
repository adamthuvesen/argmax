# Plan: Subagent emblems

## Scope

**Objective.** Give every subagent a small geometric emblem, in the style of the Codex agent marks: a radially symmetric shape (trefoil, pinwheel, hourglass, diamond cluster, …) in one hue, shaded like a soft gem so it reads as an object rather than a line icon. The emblem is the agent's face everywhere the app shows it: the launch row in the chat, the tab in the Agents view, the pane masthead, and the workspace card's stack. Today those four surfaces show a muted dot, a generic `Bot` glyph, a `Bot` glyph again, and the codename's first letter.

**Decision.** Emblems are hand-rolled inline SVG, coloured through CSS tokens, not a bitmap sprite. Codex ships raster tiles, which is why theirs look slightly soft; SVG stays crisp at 13px and 18px on Retina, follows Light / Dark automatically through the existing `--session-icon-*` palette, and costs no asset pipeline. No new dependency: `lucide-react` has no shapes like these, and the whole set is a few hundred lines of path data.

**Binding constraints.** No inline `style={{}}` for static styling; geometry in SVG attributes, colour in CSS (`docs/styling.md`). Decorative colour never carries status: running / failed / done stay on the existing semantic tokens and the working nest. Renderer tests query by role and label. Three themes. Reduced motion honoured. Nothing changes in Rust or the schema: the emblem is derived in the renderer from data it already has.

**Out of scope.** Emblems for multitasks (the Split glyph is what names a multitask, see `docs/multitask.md`), emblems in the sidebar session icon picker, user-chosen emblems, phone remote surfaces beyond what falls out of shared components.

## What the reference does, and what we keep

From the three Codex screenshots:

- Every mark is one hue, with a lighter top face, a mid body, and a darker rim and underside. It reads as a bevelled sticker, not a flat glyph.
- Shapes are radially symmetric with 2-, 3-, 4-, 6- or 8-fold symmetry, so they sit centred in a list row and never look rotated wrong.
- Hue and shape are assigned independently, so two agents rarely share both, and one agent's identity survives even where colour fails (grayscale, colour-vision deficiency).
- Colour range is wide and pastel on charcoal: red, orange, yellow, green, mint, teal, blue, violet, purple.

Improvements we make over the reference:

- **Distinct silhouettes at 13px.** Codex's eight-petal rosette, eight-point star and sun are near twins at row size. Every shape in our set must survive a 13px grayscale test against every other shape.
- **One optical size.** Codex's marks vary in visual weight (the three-circle disc is heavy, the hourglass light). Ours are drawn on a 16-unit grid with a mass budget so a row of them reads as one family.
- **Theme-aware.** The same emblem lifts in Dark and deepens in Light through tokens that already exist, instead of one raster tuned for charcoal.
- **Stable identity.** An emblem is tied to the codename (below), so Gauss looks like Gauss in every session.

## Identity: how an agent gets its emblem

**Recommendation: tie the emblem to the codename, not to the spawn.** `assignAgentCodenames` already guarantees one distinct scientist per subagent within a session, probing past taken names. If each of the 100 names owns a fixed (shape, hue) pair, then uniqueness within a session is free, the emblem never shifts when a later agent spawns, and the same name looks the same across sessions and projects. A user learns "Gauss is the teal trefoil" the way they learn a colleague's face. The alternative, hashing the tool-use id into a second independent probe, gives more variety per session but no memory across sessions and a second thing that can shift.

With 12 shapes × 9 hues there are 108 pairs for 100 names. The table is hand-assigned, with three rules:

1. The ten headline names (Turing … Hopper) span nine distinct hues and ten distinct shapes, so a session's first few spawns are always maximally different.
2. Consecutive names in the list never share a hue, so a linear probe that lands on a neighbour still changes colour.
3. Every shape and hue is used roughly equally.

`fallbackCodename` (the pre-load fallback) resolves through the same table, so the emblem never flickers between fallback and assigned unless the name itself changes, which is the existing behaviour.

Multitasks keep the Split glyph and their hashed `iconColor`; the emblem is what says "subagent".

## The set

Twelve shapes on a 16×16 viewBox, centred at (8, 8), fitting a 14-unit circle. Three symmetry families so the eye groups them:

| Name | Symmetry | Silhouette | Reference |
|---|---|---|---|
| `trefoil` | 3 | three rounded leaves meeting at centre | screenshot 1, green |
| `hourglass` | 2 | two triangles tip to tip, slight waist | screenshot 1, teal |
| `orbit` | 3 | three overlapping discs inside a circle | screenshot 1, blue |
| `pinwheel` | 4 | four curved blades | screenshot 1, green |
| `cluster` | 4 | five rhombi in a plus | screenshot 1, purple |
| `clover` | 4 | four heart-shaped petals | screenshot 2, red |
| `bloom` | 4 | four pointed petals with a dark centre | screenshot 2, orange |
| `wreath` | 6 | ring of six ovals | screenshot 2, yellow |
| `quad` | 4 | four discs touching | screenshot 2, blue |
| `star` | 8 | eight-point star | screenshot 2, orange |
| `gem` | 6 | hexagon with three facets | new (replaces Codex's twin rosette) |
| `shell` | 2 | nautilus / comma pair, yin-yang mass | new (adds an asymmetric-feeling shape that is still 2-fold) |

Nine hues, straight from the existing picker palette so the sidebar, the workspace card and the emblems agree: `green teal blue violet plum clay amber pink red`. That is the same range as the reference (Codex's yellow ≈ amber, mint ≈ teal, purple ≈ plum).

Each shape must pass, before it enters the table:

- 13px grayscale contact sheet: no two shapes confusable.
- Mass budget: painted area between 55% and 70% of the 14-unit circle.
- Both themes on `--panel` and `--bg`.

## Rendering

**Shading without ids.** The reference's bevel is three tones of one hue. We get it by painting the same path three times, which needs no `<defs>`, gradient ids or clip paths (all of which break when the same emblem appears in several places on one page):

1. **Rim** — the path, translated 0.75 units down, in `--emblem-deep`.
2. **Face** — the path in place, in `--emblem-face`.
3. **Light** — the path scaled to ~70% about the centre and nudged 0.6 units up-left, in `--emblem-light`, opacity 0.55.

Tones derive from one hue token in CSS, so a theme switch or a palette tweak updates every emblem:

```css
.agent-emblem[data-hue="teal"] { --emblem-face: var(--session-icon-teal); }
.agent-emblem {
  --emblem-deep: color-mix(in oklab, var(--emblem-face) 68%, black);
  --emblem-light: color-mix(in oklab, var(--emblem-face) 50%, white);
}
```

Dark gets the lifted palette for free, which is exactly the pastel-on-charcoal look in the screenshots. Light gets the deeper palette, and the rim/light mix ratios may need one per-theme adjustment (`[data-theme="light"]`), decided on the contact sheet.

**Component.** `AgentEmblem({ shape, hue, size, muted? })` renders `<svg class="agent-emblem" data-shape data-hue aria-hidden="true">`. It is decorative: the codename beside it is the accessible name, so the emblem carries no label of its own. Three `<path class="agent-emblem-rim | -face | -light">` children; classes carry the fills, the component carries only geometry, per the usage chart precedent.

**Status modifiers** ride the existing semantic tokens, never the hue:

- `running` — the working nest, tinted with the emblem's face colour (the same `--working-nest-lead` trick the sidebar uses for a custom icon), lands, then the emblem fades in. The landing motion stays exactly as it is today.
- `done` — the emblem at full colour.
- `error` — the emblem with `--emblem-face: var(--muted)` and a small `--rose` corner dot, the pattern `.session-custom-icon-overlay` already uses. A failed agent is still that agent, just greyed.

## Surfaces

| Surface | File | Today | After | Size |
|---|---|---|---|---|
| Launch row mark | `AgentLaunchList.tsx` `AgentLaunchMark` | nest → 5px muted dot | nest → emblem | 14 |
| Agents view tab | `AgentsView.tsx` | nest / `Bot` | nest / emblem | 13 |
| Pane masthead | `AgentActivity.tsx` `AgentActivityHeader` | nest / `Bot` | nest / emblem | 18 |
| Workspace card stack | `WorkspaceCard.tsx` `SubagentsSection` | initial letter in a tinted ring | emblem on the same ring, overlap and `+N` kept | 18 |

Multitask entries in the tab strip and the card keep Split and the hashed colour.

## Phases

### Phase 0: Contact sheet and shape sign-off

**Deliverable.** A rendered contact sheet, both themes, saved under `docs/design/agent-emblems/` like the mascot concepts: all 12 shapes × 9 hues at 32px, plus the 13px grayscale row.

**Files.** `src/renderer/lib/agentEmblems.ts` (shape path data, names, hue list), `src/renderer/components/AgentEmblem.tsx`, `src/renderer/styles/agent-emblems.css`, a throwaway preview mounted through the existing renderer demo entry (not committed).

**Work.** Draw the twelve paths; render the sheet through the `ui-screenshot` rung in `docs/verification.md`; iterate on mass and silhouette until the grayscale row passes. This is the phase to pause on and look at together: shapes are a taste call, and swapping one later costs one path.

**Success check.** Contact sheet reviewed; every shape passes the three entry tests above.

### Phase 1: Identity table and component tests

**Deliverable.** `emblemForCodename(name)` returning `{ shape, hue }` for all 100 names, with the three table rules pinned.

**Files.** `agentEmblems.ts`, `agentEmblems.test.ts`; `agentNames.ts` gains nothing (the table keys on the name it already produces).

**Success check.** Tests: all 100 names map to distinct pairs; the ten headline names cover nine hues and ten shapes; no consecutive names share a hue; every shape and hue used at least 7 times; `AgentEmblem` renders with `aria-hidden` and the expected `data-shape` / `data-hue`.

### Phase 2: Wire the four surfaces

**Deliverable.** Emblems live in the launch row, tab strip, masthead and workspace card, with the three status states.

**Files.** `AgentLaunchList.tsx`, `AgentsView.tsx`, `AgentActivity.tsx`, `WorkspaceCard.tsx`, `subagentSummary.ts` (entries carry `emblem` next to `iconColor`; multitasks leave it null), `chat-turns.css`, `chat-workspace-card.css`, `agent-emblems.css` imported from `chat.css`; existing tests for those components updated where they asserted `Bot` or the initial letter.

**Work.** The launch row swap keeps the nest-landing sequencing in `AgentLaunchMark` exactly, replacing only the bullet branch. The card ring keeps its overlap and `+N`. Tab and masthead replace the `Bot` branch only.

**Success check.** `npm test` and `npm run lint` pass. A real subagent launch in a scratch instance (`ARGMAX_DATA_DIR`, bridge rung in `docs/verification.md`) shows the same emblem in all four places while running, after landing, and for a forced failure, in both themes. Screenshots in the PR.

### Phase 3: Docs

**Files.** `CONTEXT.md` (glossary: *Emblem*: the shape-and-hue mark tied to a subagent's codename; avoid avatar, icon, badge), `docs/chat-cards.md` (launch row mark, dock tab, masthead), `docs/styling.md` (emblem tones ride the session icon palette; decorative, never status), `docs/multitask.md` one line (multitasks keep Split).

## Decisions

Settled before Phase 0, and built that way.

1. **Codename-bound.** The emblem belongs to the name, not the spawn, for cross-session recognition. `emblemForCodename` reads a fixed 100-row table; an off-table label (never a scientist) falls back to the name's own hash so no row is ever left with an empty box.
2. **Running keeps the nest.** The nest and its landing are unchanged; the emblem takes the slot after `WORKING_NEST_SETTLE_MS`. The nest wears the emblem's hue while it runs (`--working-nest-lead` / `-rest`, the `.session-row[data-icon-color]` trick), so the landing ends in the colour the emblem is about to take.
3. **Twelve shapes, nine hues.** As drawn below.
4. **Error** greys `--emblem-face` to `--muted` and adds a small `--rose` corner dot. Status never rides the hue.
5. **Multitasks keep Split** and their hashed `iconColor`. A subagent's chip on the workspace card takes the emblem's hue instead of a second hash, so ring and mark agree.

## What shipped, against the entry tests

The contact sheets are `docs/design/agent-emblems/sheet-dark.png` and `sheet-light.png`: 12 x 9 at 32px, an 18px row and a 13px grayscale row on `--panel`, a states row (running / done / failed), and the 13px marks rasterised and magnified 8x, which is the test that actually decides legibility.

Painted area as a share of the 14-unit circle, measured by rasterising each face path at 512px:

| | | | | | |
|---|---|---|---|---|---|
| trefoil 62% | hourglass 66% | orbit 67% | pinwheel 67% | cluster 55% | clover 66% |
| bloom 55% | wreath 57% | quad 69% | star 59% | gem 68% | shell 51% |

The plan asked for 55-70%. Eleven land inside it; `shell` sits at 51% because a comma pair that reaches 55% closes its two gaps and reads as a plain disc. Two shapes moved during the sheet passes: `quad` turned 45 degrees off `bloom`, which it twinned with at 13px, and `wreath`'s ovals were separated into visible beads to pull it away from `clover`.

Two traps worth keeping:

- **Winding matters under `nonzero`.** `shell`'s tail was wound against its head and the overlap cancelled into a hole, which read as a mangled silhouette *and* held the measured mass flat across three edits. Only `orbit`, `bloom` and `gem` use `evenodd`, and their subpaths never overlap; the rest are unions wound the same way. Pinned by `agentEmblems.test.ts`.
- **The masthead tile.** `.agent-activity-mark` was filled with `--accent-soft`, which put a green tile behind a pink agent. It now tints from `--emblem-face`, except on failure where the rose tile is the point.

## Follow-up, not in this plan

Offer the emblems in the sidebar Edit Icon picker so a person can give a chat a gem too.
