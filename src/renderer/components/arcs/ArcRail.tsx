import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

/**
 * The Arc page takes over the sidebar column the same way Settings and
 * Schedule do: this rail replaces `Sidebar` for as long as the page is open.
 * There is nothing to navigate within one arc, so the rail is a way back and
 * the window-drag strip.
 */
export function ArcRail({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <aside className="settings-rail" aria-label="Arc">
      <div className="window-controls" data-window-drag />
      <button type="button" className="settings-rail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back</span>
      </button>
    </aside>
  );
}
