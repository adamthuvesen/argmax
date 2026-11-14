import type { JSX } from "react";
import { useBridgeQuery } from "../../data/useBridgeQuery.js";
import type { TurnWaterfall } from "../../../shared/types.js";

const SHOWN_TURNS = 20;

// The steps that split a turn into Argmax before spawn, CLI boot, model
// time, and Argmax after content. Every stamp is in the row's tooltip.
const COLUMNS = [
  ["spawn", "Spawn"],
  ["cli_init", "CLI init"],
  ["first_content", "Content"],
  ["first_hint_emitted", "Hint"],
  ["first_painted", "Painted"],
] as const;

function offset(turn: TurnWaterfall, name: string): string {
  const stamp = turn.stamps.find((candidate) => candidate.name === name);
  return stamp ? `${Math.round(stamp.offsetMs)}` : "–";
}

function allStamps(turn: TurnWaterfall): string {
  return turn.stamps.map((stamp) => `${stamp.name} ${Math.round(stamp.offsetMs)}`).join(" · ");
}

/** The newest turns' latency waterfalls, in ms from the send reaching the backend. */
export function TurnWaterfallsCard(): JSX.Element | null {
  const { data } = useBridgeQuery({
    key: ["session.turnWaterfalls", SHOWN_TURNS],
    read: (api) => api.session.turnWaterfalls({ limit: SHOWN_TURNS }),
  });
  if (!data?.length) return null;
  return (
    <div className="settings-card">
      <h4 className="settings-card-title">Turn waterfalls</h4>
      <p className="settings-note">
        Milliseconds from the send reaching the backend. Submit is the click, before it. Hover a row
        for every step.
      </p>
      <table className="settings-startup-table" aria-label="Turn waterfalls">
        <thead>
          <tr>
            <th scope="col">Turn</th>
            <th scope="col">Submit</th>
            {COLUMNS.map(([name, label]) => (
              <th key={name} scope="col">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((turn) => (
            <tr key={turn.id} title={allStamps(turn)}>
              <td>
                <code>{turn.provider ?? "?"}</code> {new Date(turn.createdAt).toLocaleTimeString()}
              </td>
              <td>{offset(turn, "submit")}</td>
              {COLUMNS.map(([name]) => (
                <td key={name}>{offset(turn, name)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
