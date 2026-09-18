import type { JSX } from "react";
import { showActivityPage, showUsagePage } from "../../state/overlays.js";
import { SegmentedControl } from "../settings/settingsPrimitives.js";

/**
 * Hacking is one sidebar entry with two views — what the agents cost, and
 * what came out the other end — so each view carries the switch to the other
 * where its title would be. Which view is open lives in the overlays store,
 * because both panels stay mounted and only one is on screen.
 */
export type LedgerPage = "usage" | "activity";

const PAGES: ReadonlyArray<{ value: LedgerPage; label: string }> = [
  { value: "usage", label: "Usage" },
  { value: "activity", label: "Activity" }
];

export function LedgerSwitch({ active }: { active: LedgerPage }): JSX.Element {
  return (
    <div className="ledger-switch">
      <SegmentedControl
        ariaLabel="Hacking view"
        name="hacking-view"
        value={active}
        onChange={(next) => (next === "activity" ? showActivityPage() : showUsagePage())}
        options={PAGES}
      />
    </div>
  );
}
