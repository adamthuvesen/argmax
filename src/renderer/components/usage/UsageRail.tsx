import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

/**
 * Usage takes over the sidebar column the same way settings and schedule do:
 * this rail replaces `Sidebar` for as long as the page is open. There is
 * nothing to navigate between, so the rail is a way back and the drag strip.
 */
export function UsageRail({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <aside className="settings-rail" aria-label="Usage">
      <div className="window-controls" data-window-drag />
      <button type="button" className="settings-rail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back</span>
      </button>
    </aside>
  );
}
