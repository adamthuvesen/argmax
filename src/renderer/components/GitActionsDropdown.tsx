import { GitBranch } from "lucide-react";
import { useCallback, useRef, useState, type JSX } from "react";
import type { GhPrRecord, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { GitActionsMenu } from "./GitActionsMenu.js";

export function GitActionsDropdown({
  prs,
  session,
  workspace,
  onPrsRefresh,
  onOpenCommitDialog
}: {
  prs: GhPrRecord[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onPrsRefresh?: () => void;
  onOpenCommitDialog?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((): void => {
    setOpen(false);
  }, []);

  useDismissOnOutsideOrEscape(anchorRef, open, close);

  const disabled = !workspace;
  const titleText = workspace
    ? `Git actions for ${workspace.branch}`
    : "Git actions (workspace required)";

  return (
    <div className="project-picker-anchor git-actions-anchor" ref={anchorRef}>
      <button
        className="small-icon"
        type="button"
        title={titleText}
        aria-label="Git actions"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <GitBranch size={16} />
      </button>
      {open && (
        <div
          className="project-picker-popover git-actions-popover"
          role="menu"
          aria-label="Git actions"
        >
          <GitActionsMenu
            prs={prs}
            session={session}
            workspace={workspace}
            onPrsRefresh={onPrsRefresh}
            onOpenCommitDialog={onOpenCommitDialog}
            onClose={close}
          />
        </div>
      )}
    </div>
  );
}
