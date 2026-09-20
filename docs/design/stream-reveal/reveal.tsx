/**
 * The real `StreamingMarkdown`, fed a scripted stream. This is the page the
 * fresh-run fade was tuned on: it renders the shipped component, the shipped
 * prose styles, and the shipped reveal cadence, so what it shows is what a
 * bubble does.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown } from "../../../src/renderer/components/StreamingMarkdown.js";

const TEXT = `Greg had been staring at the same line of the config for eleven minutes, which is roughly ten minutes longer than the line deserved, and he filled it with coffee, then more coffee, then a brief and unsuccessful **flirtation with tea** that ended after exactly one cup.

One Tuesday — it was always a Tuesday when things happened, that was just the pattern — a crow landed on Greg's windowsill and said, "Your destiny awaits." "Crows can't talk," said Greg, setting down his \`coffee.toml\` with the slow, deliberate motion of a man who has clearly seen a movie about this exact situation.

- The crow had a point about the config.
- The config did not have a point about the crow.

"This one can," said the crow, and then never spoke again, ever, for the rest of the afternoon, which Greg found both a relief and, somehow, a little disappointing.`;

type Cadence = "claude" | "cursor" | "codex";

const DELIVERY: Record<Cadence, { size: number; everyMs: number }> = {
  claude: { size: 130, everyMs: 700 },
  cursor: { size: 12, everyMs: 40 },
  codex: { size: TEXT.length, everyMs: 600 }
};

function Harness(): JSX.Element {
  const [cadence, setCadence] = useState<Cadence>("claude");
  const [run, setRun] = useState(0);
  const [delivered, setDelivered] = useState(0);
  const [streaming, setStreaming] = useState(true);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const { size, everyMs } = DELIVERY[cadence];
    setDelivered(0);
    setStreaming(true);
    let at = 0;
    timer.current = window.setInterval(() => {
      at = Math.min(at + size, TEXT.length);
      setDelivered(at);
      if (at >= TEXT.length) {
        setStreaming(false);
        if (timer.current !== null) window.clearInterval(timer.current);
      }
    }, everyMs);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [cadence, run]);

  return (
    <>
      <div className="harness-head">
        <h1>Streaming prose reveal — real component</h1>
        <select value={cadence} onChange={(event) => setCadence(event.target.value as Cadence)}>
          <option value="claude">Claude · 130 chars / 0.7s</option>
          <option value="cursor">Cursor · word deltas</option>
          <option value="codex">Codex · whole answer at once</option>
        </select>
        <button type="button" onClick={() => setRun((count) => count + 1)}>Replay</button>
      </div>
      <div id="stream-host">
        <StreamingMarkdown
          key={run}
          text={TEXT.slice(0, delivered)}
          streaming={streaming}
          revealKey={`harness-${run}`}
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
