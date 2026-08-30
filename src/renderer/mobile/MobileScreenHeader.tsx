import { ChevronLeft } from "lucide-react";
import type { JSX, ReactNode } from "react";

/**
 * The bar every phone screen wears: a back chevron, a centre, and optional
 * trailing controls. When there are no controls a spacer takes their place so
 * the centre stays centred against the chevron.
 */
export function MobileScreenHeader({
  onBack,
  backLabel,
  title,
  actions
}: {
  onBack: () => void;
  /** What the back chevron announces — the screen it returns to. */
  backLabel: string;
  /** A string renders as the screen title; the review screen passes its own
   *  mode tablist here instead. */
  title: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="mobile-session-header">
      <button type="button" className="mobile-back" onClick={onBack} aria-label={backLabel}>
        <ChevronLeft size={22} aria-hidden />
      </button>
      {typeof title === "string" ? (
        <span className="mobile-session-header-title">{title}</span>
      ) : (
        title
      )}
      {actions ?? <span className="mobile-header-spacer" aria-hidden />}
    </header>
  );
}
