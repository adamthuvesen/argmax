import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

/**
 * @deprecated Arc now opens in the workspace column with the session sidebar
 * still visible, like Browser. Kept only until any lingering imports are removed.
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
