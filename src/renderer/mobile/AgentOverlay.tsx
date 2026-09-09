import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";

/**
 * A subagent or multitask peek, raised over the transcript.
 *
 * Deliberately not a screen: the delegated work is something you glance at and
 * act on in the chat that spawned it, so the parent stays visible above and its
 * composer stays live below. The backdrop stops at the composer's top edge, so
 * a reply is one tap away without dismissing anything — on a phone that is the
 * difference between reading a result and answering it.
 */
export function AgentOverlay({
  label,
  onClose,
  children
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  // The composer grows as a follow-up is typed, so its height is watched rather
  // than read once.
  useLayoutEffect(() => {
    const root = hostRef.current?.closest(".session-main-column");
    const composer = root?.querySelector(".session-input");
    if (!(composer instanceof HTMLElement)) return;
    const measure = (): void => setComposerHeight(composer.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="mobile-agent-overlay"
      ref={hostRef}
      style={{ bottom: `${composerHeight}px` }}
    >
      <div className="mobile-agent-overlay-scrim" role="presentation" onClick={onClose} />
      <div className="mobile-agent-overlay-panel" role="dialog" aria-modal="false" aria-label={label}>
        <div className="mobile-agent-overlay-grip">
          <span className="mobile-sheet-grabber" aria-hidden="true" />
          <button
            type="button"
            className="mobile-agent-overlay-close"
            aria-label={`Close ${label}`}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="mobile-agent-overlay-body">{children}</div>
      </div>
    </div>
  );
}
