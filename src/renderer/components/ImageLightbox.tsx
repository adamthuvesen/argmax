import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";

const PANE_SURFACE = ".conversation-surface, .launcher-surface";

/**
 * Centered preview of a single image. Open when `src` is set; closes on
 * Escape, on a click outside the image, or on the close button. `src` can
 * be a data URL (pending composer attachments) or an `argmax-attachment://`
 * URL (sent-message attachments).
 *
 * Portaled onto the pane surface (the same host as the provider-switch
 * confirmation) so the transcript scroller cannot clip a wide screenshot,
 * and so the overlay's box stays in the chat column. A window-fixed
 * `role="dialog"` would overlap the review panel and hide the native
 * browser webview, leaving a blank panel.
 */
export function ImageLightbox({
  src,
  alt,
  onClose
}: {
  src: string | null;
  alt: string;
  onClose: () => void;
}): JSX.Element | null {
  const contentRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [surface, setSurface] = useState<HTMLElement | null | undefined>(undefined);
  const open = src !== null;
  useDismissOnOutsideOrEscape(contentRef, open, onClose, undefined, { trapFocus: true });
  useRestoreFocus(open);

  useLayoutEffect(() => {
    if (!open) {
      setSurface(undefined);
      return;
    }
    setSurface(probeRef.current?.closest<HTMLElement>(PANE_SURFACE) ?? null);
  }, [open]);

  useEffect(() => {
    if (open && surface !== undefined) closeButtonRef.current?.focus();
  }, [open, surface]);

  if (!open) return null;

  const overlay = (
    <div className="image-lightbox-overlay" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="image-lightbox-content" ref={contentRef}>
        <img className="image-lightbox-image" src={src} alt={alt} />
        <button
          ref={closeButtonRef}
          type="button"
          className="image-lightbox-close"
          aria-label="Close image preview"
          title="Close"
          onClick={onClose}
        >
          <X size={18} />
        </button>
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
