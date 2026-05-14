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
import { useCallback, useRef, useState, type FormEvent, type JSX } from "react";
import type { GhPrRecord, SessionSummary, WorkspaceSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

type Mode = "menu" | "commit" | "create-branch";

interface Feedback {
  kind: "success" | "error";
  message: string;
}

function errorFeedback(error: unknown, fallback: string): Feedback {
  return { kind: "error", message: error instanceof Error ? error.message : fallback };
}

export function GitActionsDropdown({
  prs,
  session,
  workspace,
  onPrsRefresh
}: {
  prs: GhPrRecord[];
  session: SessionSummary | null;
  workspace: WorkspaceSummary | null;
  onPrsRefresh?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((): void => {
    setOpen(false);
    setMode("menu");
    setFeedback(null);
  }, []);

  useDismissOnOutsideOrEscape(anchorRef, open, close);

  const hasPr = prs.length > 0;
  const disabled = !workspace;

  const toggle = useCallback((): void => {
    if (open) {
      close();
    } else {
      setMode("menu");
      setFeedback(null);
      setOpen(true);
    }
  }, [open, close]);

  const runCommit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (!workspace || !window.argmax) return;
      const message = commitMessage.trim();
      if (!message) {
        setFeedback({ kind: "error", message: "Enter a commit message." });
        return;
      }
      setBusy(true);
      setFeedback(null);
      void window.argmax.git
        .commit({ workspaceId: workspace.id, message })
        .then((result) => {
          setCommitMessage("");
          setFeedback({
            kind: "success",
            message: `Committed ${result.commitSha.slice(0, 7)} on ${result.branch}.`
          });
          setMode("menu");
        })
        .catch((error: unknown) => {
          setFeedback(errorFeedback(error, "Commit failed."));
        })
        .finally(() => setBusy(false));
    },
    [workspace, commitMessage]
  );

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
        onClick={toggle}
      >
        <GitBranch size={16} />
      </button>
      {open && (
        <div
          className="project-picker-popover git-actions-popover"
          role="menu"
          aria-label="Git actions"
        >
          {mode === "menu" && (
            <ul className="git-actions-list">
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="project-picker-item"
                  disabled={busy || !workspace}
                  title={
                    workspace?.dirty
                      ? "Stage and commit all changes"
                      : "Stage and commit all changes (worktree is currently clean)"
                  }
                  onClick={() => {
                    setFeedback(null);
                    setMode("commit");
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
          {mode === "commit" && (
            <form className="git-actions-composer" onSubmit={runCommit}>
              <button
                type="button"
                className="git-actions-back"
                aria-label="Back to git menu"
                onClick={() => setMode("menu")}
              >
                <ChevronLeft size={12} aria-hidden="true" />
                Back
              </button>
              <label className="git-actions-label" htmlFor="git-actions-commit-message">
                Commit message
              </label>
              <textarea
                id="git-actions-commit-message"
                className="git-actions-textarea"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                rows={3}
                placeholder="Describe the change"
                disabled={busy}
                autoFocus
              />
              <button type="submit" className="git-actions-submit" disabled={busy || !commitMessage.trim()}>
                {busy ? "Committing…" : "Commit"}
              </button>
            </form>
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
        </div>
      )}
    </div>
  );
}
