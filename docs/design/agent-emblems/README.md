# Agent emblems

The mark a subagent's codename owns. Twelve shapes on a 16x16 grid inside a
14-unit circle, nine hues from the session icon palette, drawn by
[AgentEmblem.tsx](../../../src/renderer/components/AgentEmblem.tsx) and painted
by [agent-emblems.css](../../../src/renderer/styles/agent-emblems.css). The
table and the rules it holds to live in
[agentEmblems.ts](../../../src/renderer/lib/agentEmblems.ts), pinned by its test.

| Sheet | What it shows |
|---|---|
| `sheet-dark.png` / `sheet-light.png` | All 12 x 9 at 32px, an 18px row and a 13px grayscale row on `--panel`, the three states, and the 13px marks rasterised and magnified 8x — the size the launch row and the dock tab actually draw them at. |
| `demo-dark.png` / `demo-light.png` | The demo transcript with a subagent open: the launch row mark, the dock tab and the pane masthead. |
| `card-dark.png` / `card-light.png` | The workspace card's subagent stack, where each chip is an emblem on a ring in its own hue. |

Everything here is generated: re-render it rather than editing a PNG. See
[docs/plan/subagent-emblems.md](../../plan/subagent-emblems.md) for the entry
tests each shape had to pass and the measured mass of the set.
