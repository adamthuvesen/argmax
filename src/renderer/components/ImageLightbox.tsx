import { X } from "lucide-react";
import { useRef, type JSX } from "react";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";

/**
 * Full-screen, centered preview of a single image. Open when `src` is set;
 * closes on Escape, on a click outside the image, or on the close button.
 * `src` can be a data URL (pending composer attachments) or an
 * `argmax-attachment://` URL (sent-message attachments).
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
  const open = src !== null;
  useDismissOnOutsideOrEscape(contentRef, open, onClose);
  useRestoreFocus(open);
  if (!open) return null;
  return (
    <div className="image-lightbox-overlay" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="image-lightbox-content" ref={contentRef}>
        <img className="image-lightbox-image" src={src} alt={alt} />
        <button
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
}
