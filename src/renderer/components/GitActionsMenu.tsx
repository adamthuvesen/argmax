import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Github,
  Upload
} from "lucide-react";
import { useCallback, useState, type FormEvent, type JSX } from "react";
import type { GhPrRecord, SessionSummary, WorkspaceSummary } from "../../shared/types.js";

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

type Mode = "menu" | "create-branch";

interface Feedback {
  kind: "success" | "error";
  message: string;
}

function errorFeedback(error: unknown, fallback: string): Feedback {
  return { kind: "error", message: error instanceof Error ? error.message : fallback };
}

/**
 * Body of the git actions menu: Commit / Push / View-or-create PR /
 * Create branch (with inline form). Renders without an anchor or popover
 * wrapper — embed inside any container that already provides menu chrome.
 *
 * `onClose` is invoked after a Commit click (it opens an external dialog) so
 * the enclosing popover can dismiss itself. Push / PR / Create branch keep
 * the menu open to surface feedback.
 */
export function GitActionsMenu({
  prs,
  session,
  workspace,
  onPrsRefresh,
  onOpenCommitDialog,
  onClose
}: {
  prs: GhPrRecord[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onPrsRefresh?: () => void;
  onOpenCommitDialog?: () => void;
  onClose?: () => void;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("menu");
  const [branchName, setBranchName] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const hasPr = prs.length > 0;

  const runPush = useCallback(async (): Promise<void> => {
    if (!workspace || !window.argmax) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await window.argmax.git.push({ workspaceId: workspace.id });
      setFeedback({
        kind: "success",
        message: result.upstreamSet
          ? `Set upstream and pushed ${result.branch} to origin.`
          : `Pushed ${result.branch} to origin.`
      });
    } catch (error) {
      setFeedback(errorFeedback(error, "Push failed."));
    } finally {
      setBusy(false);
    }
  }, [workspace]);

  const runViewOrCreatePr = useCallback(async (): Promise<void> => {
    if (!session || !window.argmax) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await window.argmax.git.viewOrCreatePr({ sessionId: session.id });
      setFeedback({
        kind: "success",
        message:
          result.action === "created"
            ? `Created pull request — opening ${result.url}.`
            : `Opening pull request #${result.prNumber}.`
      });
      onPrsRefresh?.();
    } catch (error) {
      setFeedback(errorFeedback(error, "Could not open PR."));
    } finally {
      setBusy(false);
    }
  }, [session, onPrsRefresh]);

  const runCreateBranch = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!workspace || !window.argmax) return;
      const branch = branchName.trim();
      if (!branch || branch.startsWith("-") || !BRANCH_NAME_PATTERN.test(branch)) {
        setFeedback({
          kind: "error",
          message: "Branch name uses only letters, digits, '.', '_', '/', '-'."
        });
        return;
      }
      setBusy(true);
      setFeedback(null);
      void window.argmax.git
        .createBranch({ workspaceId: workspace.id, branch })
        .then((result) => {
          setBranchName("");
          setFeedback({ kind: "success", message: `Created and switched to ${result.branch}.` });
          setMode("menu");
        })
        .catch((error: unknown) => {
          setFeedback(errorFeedback(error, "Could not create branch."));
        })
        .finally(() => setBusy(false));
    },
    [workspace, branchName]
  );

  return (
    <>
      {mode === "menu" && (
        <ul className="git-actions-list">
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="project-picker-item"
              disabled={busy || !workspace || !onOpenCommitDialog}
              title={
                workspace?.dirty
                  ? "Select files and commit"
                  : "Select files and commit (worktree is currently clean)"
              }
              onClick={() => {
                setFeedback(null);
                onClose?.();
                onOpenCommitDialog?.();
              }}
            >
              <GitCommitHorizontal size={14} aria-hidden="true" />
              Commit
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="project-picker-item"
              disabled={busy || !workspace}
              onClick={() => void runPush()}
            >
              <Upload size={14} aria-hidden="true" />
              Push
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="project-picker-item"
              disabled={busy || !session}
              onClick={() => void runViewOrCreatePr()}
            >
              {hasPr ? (
                <Github size={14} aria-hidden="true" />
              ) : (
                <GitPullRequestArrow size={14} aria-hidden="true" />
              )}
              {hasPr ? "View pull request" : "Create pull request"}
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="project-picker-item"
              disabled={busy || !workspace}
              onClick={() => {
                setFeedback(null);
                setMode("create-branch");
              }}
            >
              <GitBranch size={14} aria-hidden="true" />
              Create branch
            </button>
          </li>
        </ul>
      )}
      {mode === "create-branch" && (
        <form className="git-actions-composer" onSubmit={runCreateBranch}>
          <button
            type="button"
            className="git-actions-back"
            aria-label="Back to git menu"
            onClick={() => setMode("menu")}
          >
            <ChevronLeft size={12} aria-hidden="true" />
            Back
          </button>
          <label className="git-actions-label" htmlFor="git-actions-branch-name">
            Branch name
          </label>
          <input
            id="git-actions-branch-name"
            className="git-actions-input"
            type="text"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            placeholder="feature/new-thing"
            disabled={busy}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button type="submit" className="git-actions-submit" disabled={busy || !branchName.trim()}>
            {busy ? "Creating…" : "Create branch"}
          </button>
        </form>
      )}
      {feedback && (
        <p
          className={`git-actions-feedback git-actions-feedback--${feedback.kind}`}
          role={feedback.kind === "error" ? "alert" : "status"}
          aria-live={feedback.kind === "error" ? "assertive" : "polite"}
        >
          {feedback.kind === "success" ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <AlertCircle size={14} aria-hidden="true" />
          )}
          <span>{feedback.message}</span>
        </p>
      )}
      {busy && (
        <p className="git-actions-busy" role="status" aria-live="polite">
          Working…
        </p>
      )}
    </>
  );
}
