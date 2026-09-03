import { useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { formatFileChipLabel } from "../lib/fileChipPath.js";
import { useFilePreview } from "../lib/filePreview.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import { FilePreviewPopover } from "./FilePreviewPopover.js";

export type FileChipOpenOptions = {
  line?: number | null;
  preferIde?: boolean;
};

const HOVER_INTENT_MS = 500;

export function FileChip({
  path,
  line,
  workspaceId,
  workspaceCwd,
  onOpen
}: {
  path: string;
  line: number | null;
  workspaceId?: string | null;
  workspaceCwd?: string | null;
  onOpen?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element {
  const label = formatFileChipLabel(path, workspaceCwd, line);
  const ariaLabel = line ? `Open ${path} at line ${line}` : `Open ${path}`;
  const title = onOpen
    ? `${ariaLabel} (⌘-click to open in IDE)`
    : ariaLabel;
  const handleOpen = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    const preferIde = event.metaKey || event.ctrlKey;
    if (onOpen) {
      onOpen(path, { line, preferIde });
      return;
    }
    if (!window.argmax) return;
    if (workspaceId) {
      // Use the workspace IDE shortcut so the file lands in the user's editor
      // (VS Code / Cursor / Zed), matching what the file list does on click.
      void window.argmax.workspaces.openInIde({ workspaceId, ide: "default" }).catch(() => undefined);
      return;
    }
    if (workspaceCwd) {
      void window.argmax.system.openPath({ path, cwd: workspaceCwd }).catch(() => undefined);
      return;
    }
    void window.argmax.system.openPath({ path }).catch(() => undefined);
  };

  // Hover-intent + popover wiring. The popover only mounts (and fetches) once
  // hover intent fires, so passive scroll-by doesn't trigger IPC.
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewRequestRef = useRef(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewResolutionError, setPreviewResolutionError] = useState<string | null>(null);
  const previewActive = anchorRect !== null && Boolean(workspaceId) && previewPath !== null;
  const preview = useFilePreview({
    workspaceId: workspaceId ?? null,
    path: previewPath ?? path,
    line,
    active: previewActive
  });

  const cancelHoverTimer = (): void => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    previewRequestRef.current += 1;
  };

  useEffect(() => {
    return () => cancelHoverTimer();
  }, [path, workspaceId]);

  const openPreview = async (): Promise<void> => {
    const node = chipRef.current;
    if (!node || !workspaceId) return;
    const request = ++previewRequestRef.current;
    const resolved = await resolveOpenablePath(window.argmax, workspaceId, path);
    if (previewRequestRef.current !== request) return;
    setPreviewPath(resolved);
    setPreviewResolutionError(resolved ? null : "File not found in this workspace.");
    setAnchorRect(node.getBoundingClientRect());
  };

  const handleMouseEnter = (): void => {
    if (!workspaceId) return;
    cancelHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      void openPreview();
    }, HOVER_INTENT_MS);
  };

  const handleMouseLeave = (): void => {
    cancelHoverTimer();
    setAnchorRect(null);
    setPreviewPath(null);
    setPreviewResolutionError(null);
  };

  const handleFocus = (): void => {
    if (!workspaceId) return;
    cancelHoverTimer();
    void openPreview();
  };

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="file-chip"
        title={title}
        aria-label={ariaLabel}
        onClick={handleOpen}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleFocus}
        onBlur={handleMouseLeave}
      >
        <span className="file-chip-path">{label}</span>
      </button>
      {anchorRect
        ? createPortal(
            <FilePreviewPopover
              anchorRect={anchorRect}
              data={preview.data}
              loading={preview.loading}
              error={previewResolutionError ?? preview.error}
              path={label}
            />,
            document.body
          )
        : null}
    </>
  );
}
