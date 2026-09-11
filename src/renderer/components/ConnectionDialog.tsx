import { PlugZap, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PROVIDER_DISPLAY_NAMES } from "../../shared/providerModels.js";
import type { ProviderId } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import { ConnectionCatalog } from "./ConnectionCatalog.js";

export function ConnectionDialog({
  provider,
  workspaceId,
  anchorRef,
  onClose
}: {
  provider: ProviderId;
  workspaceId: string | null;
  /** The composer form: the dialog stands in its footprint, same edges and
      same baseline, and grows upward from there. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const probeRef = useRef<HTMLSpanElement | null>(null);
  const [surface, setSurface] = useState<HTMLElement | null | undefined>(undefined);
  useDismissOnOutsideOrEscape(dialogRef, true, onClose, undefined, { trapFocus: true });
  useRestoreFocus(true);

  useEffect(() => {
    setSurface(
      probeRef.current?.closest<HTMLElement>(".conversation-surface, .launcher-surface") ?? null
    );
  }, []);
  useEffect(() => {
    if (surface !== undefined) closeRef.current?.focus();
  }, [surface]);

  // The overlay spans whichever surface hosts it, so the composer's edges are
  // measured against the overlay and handed to CSS as offsets. Layout effect:
  // the first paint already has the dialog on the composer, no jump.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const anchor = anchorRef.current;
    if (!overlay || !anchor) return undefined;
    const place = (): void => {
      const anchorRect = anchor.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      overlay.style.setProperty("--anchor-left", `${anchorRect.left - overlayRect.left}px`);
      overlay.style.setProperty("--anchor-width", `${anchorRect.width}px`);
      overlay.style.setProperty("--anchor-bottom", `${overlayRect.bottom - anchorRect.bottom}px`);
    };
    place();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    observer.observe(overlay);
    return () => observer.disconnect();
  }, [anchorRef, surface]);

  const overlay = (
    <div
      className="connection-dialog-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className="connection-dialog" ref={dialogRef}>
        <header className="connection-dialog-header">
          <span className="connection-dialog-mark" aria-hidden="true">
            <PlugZap size={17} />
          </span>
          <span>
            <h2 id={titleId}>Connections</h2>
            <p>Available to this {PROVIDER_DISPLAY_NAMES[provider]} chat</p>
          </span>
          <button
            type="button"
            className="connection-dialog-close"
            ref={closeRef}
            onClick={onClose}
            aria-label="Close connections"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <ConnectionCatalog provider={provider} workspaceId={workspaceId} compact />
      </div>
    </div>
  );

  return (
    <>
      <span ref={probeRef} hidden />
      {surface === undefined ? null : surface ? createPortal(overlay, surface) : overlay}
    </>
  );
}
