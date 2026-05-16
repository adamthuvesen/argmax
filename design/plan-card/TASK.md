# Plan Card — render plan-mode replies as a structured artifact

## Why

When the user is in **Plan** mode (`agentMode === "plan"`), the assistant returns a structured plan. Today it renders as plain markdown inside a normal `ChatBubble` — flat hierarchy, no visual identity, no clear "this is an artifact you act on" affordance.

We want plans to render as a self-contained **Plan Card**: a titled, sectioned card with hierarchy, code chips, top-right actions, and an inline approve/reject prompt at the bottom. Visual target lives next to this file.

## Visual target

[`plan-card.html`](./plan-card.html) — a standalone, dependency-free HTML mockup. Open it in a browser to see the final intent: warm paper palette, Fraunces display serif, Instrument Sans body, JetBrains Mono for chips, single rust accent. Match this look and feel.

Key visual moves to preserve:

- Two-column layout: left metadata rail (model, context, asked-questions, timestamp) + right content column
- Section markers (`01 — SUMMARY`, `02 — KEY CHANGES`) in tracked mono
- Hierarchical bullets with rust letter markers (A/B/C/D) and inset hairline-bordered sub-lists
- Inline code chips: pale sage background, rust text, JetBrains Mono
- Action prompt at the bottom: rust top-border, sage-wash hover on options, active state has a rust left-border + arrow, keyboard caps for ESC and ↩
- Top-right ghost icon buttons (download, copy, thumbs up/down, collapse)
- Restrained motion: staggered fade-up on first paint, 120–160ms hover transitions
- Rust L-bracket on the card's top-left corner, faint paper grain via SVG noise

## Integration plan

### 1. Detect plan-mode messages

In [`src/renderer/components/SessionConversation.tsx`](../../src/renderer/components/SessionConversation.tsx), the assistant message branch currently wraps the rendered markdown in a generic `ChatBubble`. Add a branch:

- If `agentMode === "plan"` **and** the message is from the assistant **and** the content parses as a structured plan, render `<PlanCard ... />` instead of `<ChatBubble ...>`.
- Otherwise fall through to the existing `ChatBubble` path.

Mode lives in [`src/renderer/lib/agentMode.ts`](../../src/renderer/lib/agentMode.ts). The decision needs the *message's* mode (the mode active when the assistant replied), not the live picker state — make sure that's threaded through the message model, not read from the current toggle.

### 2. Define the plan shape

Pick one of two paths — recommend (a) for v1:

**(a) Heuristic parse from markdown.** A plan reply already has predictable structure: `# Title`, an opening summary block, then `## Key Changes` (or similar) with nested bullets, optionally an `## Action` block. Parse the rendered markdown AST into:

```ts
type Plan = {
  title: string;
  summary: string[];        // 1–2 paragraphs
  sections: {
    label: string;          // "Key Changes", "Verification", "Out of scope"
    items: PlanItem[];
  }[];
  action?: {
    question: string;
    options: { label: string }[];
  };
};

type PlanItem = {
  title: string;            // markdown inline (chips, emphasis)
  children?: PlanItem[];    // nested bullets, one level deep is enough
};
```

If parse fails (no clear title, no sections), fall back to the regular `ChatBubble`. Don't show a half-rendered card.

**(b) Structured tool output.** Have the agent emit a typed plan via a tool call (`plan.respond({...})`) — the renderer never has to parse markdown. Cleaner long-term, but requires agent-side changes. Park as a follow-up.

### 3. Build the `PlanCard` component

New files:

- `src/renderer/components/PlanCard.tsx` — the component. Match the structure of the mockup's `<article class="plan-card">`. Reuse [`FileChip`](../../src/renderer/components/FileChip.tsx) if it gives you a sensible code-chip primitive; otherwise inline a small `<Chip>` styled per the mockup.
- `src/renderer/components/PlanCard.css` (or co-located styled rules in `styles.css`) — port the mockup's CSS. Replace any chat-app-conflicting global selectors with scoped classnames.

Specifics:

- The mockup uses Google Fonts (Fraunces, Instrument Sans, JetBrains Mono). Check `src/renderer/fonts/` — if the app already self-hosts a display serif and grotesque, reuse those instead of pulling Google Fonts at runtime (Electron should not block on external font CDNs).
- Use existing icon primitives where possible — the app likely already has copy/download/thumbs icons in [`src/renderer/components/`](../../src/renderer/components/). Don't ship duplicate SVGs.
- Color tokens (`--rust`, `--sage`, `--page`, `--card`, etc.) should live in the app's existing theme vars file, not be hardcoded in `PlanCard.css`. Add them as theme additions, not overrides.
- The mockup is single-theme (warm paper). If argmax has dark mode, design a dark variant before merging — *or* explicitly scope the card to light mode for v1 and flag a dark-mode follow-up. Don't ship a card that looks broken when the user toggles theme.

### 4. Wire the action prompt

The two options ("Yes, implement this plan" / "No, and tell Claude what to do differently") need real behavior:

- **Yes**: submit a follow-up turn that exits plan mode (`agentMode → "edit"`) and starts implementation. The exact mechanism is whatever the existing "exit plan mode" flow does — find it and reuse, don't reinvent.
- **No**: focus the chat input, prefill nothing, let the user write.
- Keyboard: `1` selects the first option, `2` the second, `↩` submits the selected, `ESC` dismisses (collapses card to summary).

### 5. Tests

Mirror the existing patterns. Look at `ChatBubble.test.tsx`, `ChangedFilesCard.test.tsx` for shape.

- `PlanCard.test.tsx` — renders title/summary/sections from a sample plan, hover/active states on options, keyboard nav, falls back gracefully on malformed input.
- Extend `SessionConversation.test.tsx` to assert: assistant message in plan mode renders `PlanCard`; same message in edit mode renders `ChatBubble`.

## Out of scope for v1

- Dark mode (see §3 caveat).
- Tool-driven structured plan output (path b above).
- Inline editing of plan sections.
- Persisting plan state across sessions beyond what `ChatBubble` already does.
- Animations beyond the first-paint fade-up and the hover transitions in the mockup. No scroll-triggered effects.

## Verification

1. Run the app (`npm run dev` or whatever the dev script is — see `package.json`).
2. Open a session, toggle to **Plan** mode, ask for a plan. The reply renders as a Plan Card matching the mockup.
3. Toggle back to **Edit** mode and ask anything — replies render as the normal `ChatBubble`.
4. In the Plan Card, hover and arrow-key through the two options; the rust accent and arrow indicator behave as in the mockup. `↩` submits.
5. Resize the window under ~760px wide — the metadata rail collapses above the content cleanly.
6. Send a malformed/empty plan (e.g. via a test fixture) — falls back to `ChatBubble`, no broken card.
7. `npm test` passes; new component test file is included.

## Files touched / added

**Added**
- `src/renderer/components/PlanCard.tsx`
- `src/renderer/components/PlanCard.css` (or merged into `styles.css`)
- `src/renderer/components/PlanCard.test.tsx`
- `src/renderer/lib/parsePlan.ts` (heuristic markdown → `Plan` parser)
- `src/renderer/lib/parsePlan.test.ts`

**Modified**
- `src/renderer/components/SessionConversation.tsx` — branch on plan mode + parsed plan
- `src/renderer/styles.css` or theme tokens file — add `--rust`, `--sage`, `--page-paper`, hairlines (light theme; dark variant TBD)
- Possibly the message model in `src/renderer/lib/` if mode-at-reply-time isn't currently captured

## Reference

- Mockup: [`plan-card.html`](./plan-card.html)
- Inspiration: Codex app's plan card (screenshot below — preserve the structural moves, diverge on aesthetic)
- Anti-pattern: rendering plans as plain markdown inside the default chat bubble
