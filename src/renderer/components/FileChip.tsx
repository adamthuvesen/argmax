import { useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatFileChipLabel } from "../lib/fileChipPath.js";
import { useFilePreview } from "../lib/filePreview.js";
import { resolveOpenablePath } from "../lib/openableFile.js";
import { isExternalFilePath } from "../lib/reviewIpc.js";
import { withToast } from "../lib/withToast.js";
import { showToast } from "../state/toast.js";
import { FilePreviewPopover } from "./FilePreviewPopover.js";

export type FileChipOpenOptions = {
  line?: number | null;
  preferIde?: boolean;
};

const HOVER_INTENT_MS = 500;

type FileChipProps = {
  path: string;
  line: number | null;
  workspaceId?: string | null;
  workspaceCwd?: string | null;
  onOpen?: (path: string, opts?: FileChipOpenOptions) => void;
};

/** Paths confirmed to be files. A miss is not cached: the agent may create the
 *  file after mentioning it. */
const confirmedFiles = new Set<string>();

async function isFileOnDisk(path: string, workspaceId: string | null | undefined): Promise<boolean> {
  const api = window.argmax;
  if (!api) return false;
  try {
    if (isExternalFilePath(path)) {
      await api.workspace.statExternalFile(path);
    } else if (workspaceId) {
      await api.workspace.statFile({ kind: "workspace", id: workspaceId }, path);
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A FileChip for a path that could as easily be something else, such as
 * `/api/users`: it shows `fallback` until the path is confirmed to be a file.
 */
export function CheckedFileChip({ fallback, ...props }: FileChipProps & { fallback: ReactNode }): JSX.Element {
  const key = `${props.workspaceId ?? ""}:${props.path}`;
  const [isFile, setIsFile] = useState(() => confirmedFiles.has(key));
  useEffect(() => {
    if (confirmedFiles.has(key)) {
      setIsFile(true);
      return;
    }
    let cancelled = false;
    void isFileOnDisk(props.path, props.workspaceId).then((exists) => {
      if (exists) confirmedFiles.add(key);
      if (!cancelled) setIsFile(exists);
    });
    return () => {
      cancelled = true;
    };
  }, [key, props.path, props.workspaceId]);
  return isFile ? <FileChip {...props} /> : <>{fallback}</>;
}

export function FileChip({ path, line, workspaceId, workspaceCwd, onOpen }: FileChipProps): JSX.Element {
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
    const api = window.argmax;
    if (!api) return;
    // `workspaces.openInIde` takes no path and would open the whole repo, so
    // hand the file itself to the system, resolved against the workspace.
    void withToast(
      () => api.system.openPath(workspaceCwd ? { path, cwd: workspaceCwd } : { path }),
      showToast,
      "Could not open this file."
    );
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
    setPreviewResolutionError(resolved ? null : "No single matching file in this workspace.");
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
