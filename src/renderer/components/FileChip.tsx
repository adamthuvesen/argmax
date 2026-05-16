import { Code2 } from "lucide-react";
import type { JSX, MouseEvent as ReactMouseEvent } from "react";

export type FileChipOpenOptions = {
  line?: number | null;
  preferIde?: boolean;
};

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
  const label = line ? `${path}:${line}` : path;
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

  return (
    <button
      type="button"
      className="file-chip"
      title={title}
      aria-label={ariaLabel}
      onClick={handleOpen}
    >
      <Code2 size={11} aria-hidden="true" />
      <span className="file-chip-path">{label}</span>
    </button>
  );
}
