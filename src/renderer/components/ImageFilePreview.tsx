import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { workspaceAssetUrl } from "../../shared/assetProtocol.js";
import { formatBytes } from "../lib/formatBytes.js";

/**
 * Shows an image file in the Files panel. The bytes never travel through
 * `workspace:read-file` — that read reports every image as binary, and a big
 * one as too large — they come over `argmax-asset://`, which serves
 * whitelisted image extensions from inside a known project / workspace root.
 *
 * Fit-to-pane by default, and the image never upscales, so a favicon renders
 * at its own 16px rather than as a blurred poster. Switching to 1:1 scrolls
 * the frame, which is the only way to read a sprite sheet in a column this
 * narrow — clicking the image does it, and the footer button is the same
 * control for the keyboard.
 */
export function ImageFilePreview({
  absolutePath,
  label,
  sizeBytes
}: {
  absolutePath: string;
  /** File path, used as the image's alt text. */
  label: string;
  /** On-disk size when the read reported one; the footer drops it otherwise. */
  sizeBytes: number | null;
}): JSX.Element {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);

  // Selecting another image reuses this component, so clear the previous
  // file's measurements rather than captioning the new image with them.
  useEffect(() => {
    setNatural(null);
    setLoadFailed(false);
    setActualSize(false);
  }, [absolutePath]);

  if (loadFailed) {
    return <p className="review-empty">Could not load this image.</p>;
  }

  const toggleLabel = actualSize ? "Fit image to the panel" : "View image at actual size";
  const measurements = [
    natural ? `${natural.width} × ${natural.height}` : null,
    sizeBytes === null ? null : formatBytes(sizeBytes)
  ]
    .filter((part) => part !== null)
    .join(" · ");

  return (
    <div className="image-file-preview" data-zoom={actualSize ? "actual" : "fit"}>
      <div className="image-file-preview-frame">
        <img
          src={workspaceAssetUrl(absolutePath)}
          alt={label}
          title={toggleLabel}
          onClick={() => setActualSize((current) => !current)}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight
            })
          }
          onError={() => setLoadFailed(true)}
        />
      </div>
      <footer className="image-file-preview-meta">
        <span>{measurements}</span>
        <button
          type="button"
          className="small-icon"
          aria-pressed={actualSize}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setActualSize((current) => !current)}
        >
          {actualSize ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </footer>
    </div>
  );
}
