import { ArrowLeft } from "lucide-react";
import type { JSX } from "react";

/**
 * The rail for Hacking, the section that holds Activity and Usage. Both take
 * over the sidebar column the way settings and schedule do, and both answer a
 * question about the same work — what came out the other end, and what the
 * agents cost — so the sidebar carries one entry and this rail picks the view.
 * It is the way between them, and the way back.
 *
 * It renders outside `Suspense`, so which view is active lives in `App` (the
 * overlays store) rather than in either lazily-mounted panel — the same
 * reason settings' active group does.
 */
export type LedgerPage = "usage" | "activity";

const PAGES: ReadonlyArray<{ id: LedgerPage; label: string }> = [
  { id: "activity", label: "Activity" },
  { id: "usage", label: "Usage" }
];

export function UsageRail({
  active,
  onBack,
  onNavigate
}: {
  active: LedgerPage;
  onBack: () => void;
  onNavigate: (page: LedgerPage) => void;
}): JSX.Element {
  return (
    <aside className="settings-rail" aria-label="Hacking">
      <div className="window-controls" data-window-drag />
      <button type="button" className="settings-rail-back" onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" />
        <span>Back</span>
      </button>
      <ul className="settings-rail-list ledger-rail-list">
        {PAGES.map((page) => (
          <li key={page.id}>
            <button
              type="button"
              className="settings-rail-link"
              aria-pressed={page.id === active}
              aria-current={page.id === active ? "page" : undefined}
              onClick={() => onNavigate(page.id)}
            >
              {page.label}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
