import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

/**
 * Schedule takes over the sidebar column the same way settings does: this rail
 * replaces `Sidebar` for as long as the page is open. There are no groups to
 * list, so the rail is a way back and the window-drag strip.
 */
export function ScheduleRail({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <aside className="settings-rail" aria-label="Schedule">
      <div className="window-controls" data-window-drag />
      <button type="button" className="settings-rail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back</span>
      </button>
    </aside>
  );
}
