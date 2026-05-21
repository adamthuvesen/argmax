import { useLayoutEffect, useRef, useState, type JSX } from "react";
import type { FilePreviewData } from "../lib/filePreview.js";

interface FilePreviewPopoverProps {
  anchorRect: DOMRect;
  data: FilePreviewData | null;
  loading: boolean;
  error: string | null;
  path: string;
}

const PREVIEW_GAP_PX = 8;
const PREVIEW_MAX_W = 520;
const PREVIEW_MIN_W = 280;

export function FilePreviewPopover({
  anchorRect,
  data,
  loading,
  error,
  path
}: FilePreviewPopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "above" | "below" }>(
    () => ({ left: anchorRect.left, top: anchorRect.bottom + PREVIEW_GAP_PX, placement: "below" })
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const fitsBelow = anchorRect.bottom + PREVIEW_GAP_PX + rect.height < viewportH - 12;
    const top = fitsBelow
      ? anchorRect.bottom + PREVIEW_GAP_PX
      : Math.max(12, anchorRect.top - PREVIEW_GAP_PX - rect.height);
    let left = anchorRect.left;
    if (left + rect.width > viewportW - 12) {
      left = Math.max(12, viewportW - 12 - rect.width);
    }
    setPosition({ left, top, placement: fitsBelow ? "below" : "above" });
  }, [anchorRect, data, loading, error]);

  const lines = data ? data.snippet.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return (
    <div
      ref={ref}
      className="file-preview-popover"
      data-placement={position.placement}
      role="tooltip"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
        maxWidth: `${PREVIEW_MAX_W}px`,
        minWidth: `${PREVIEW_MIN_W}px`
      }}
    >
      <div className="file-preview-popover-header">
        <span className="file-preview-popover-path" title={path}>{path}</span>
        {data ? (
          <span className="file-preview-popover-range">
            {data.startLine}–{data.endLine}
            {data.totalLines > data.endLine ? <span className="file-preview-popover-more">·{data.totalLines}</span> : null}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="file-preview-popover-state">Loading…</div>
      ) : error ? (
        <div className="file-preview-popover-state file-preview-popover-state--error">{error}</div>
      ) : data ? (
        <pre className="file-preview-popover-snippet">
          {lines.map((line, idx) => {
            const lineNum = data.startLine + idx;
            const isTarget = data.targetLine !== null && lineNum === data.targetLine;
            return (
              <span
                key={idx}
                className={`file-preview-popover-line${isTarget ? " is-target" : ""}`}
              >
                <span className="file-preview-popover-gutter">{lineNum}</span>
                <span className="file-preview-popover-code">{line || " "}</span>
              </span>
            );
          })}
        </pre>
      ) : null}
    </div>
  );
}
