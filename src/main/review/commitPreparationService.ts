import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CommitPreparation, PrepareCommitInput } from "../../shared/types.js";

/**
 * Argv-shaped commit plan. Execution callers spawn each entry directly via
 * `execFile` / `spawn` without `shell: true`, so a filename containing a
 * shell metacharacter cannot fan out into a second command.
 *
 * The renderer-facing `CommitPreparation.commands` is derived from these
 * argvs by `formatPlanForDisplay` for human consumption only.
 */
export interface CommitPlanStep {
  argv: string[];
}

export interface CommitPlan {
  workspaceId: string;
  branch: string;
  selectedFiles: string[];
  message: string;
  steps: CommitPlanStep[];
}

export class CommitPreparationService {
  constructor(private readonly database: ArgmaxDatabase) {}

  prepareCommit(input: PrepareCommitInput): CommitPreparation {
    const plan = this.preparePlan(input);
    return {
      workspaceId: plan.workspaceId,
      branch: plan.branch,
      selectedFiles: plan.selectedFiles,
      message: plan.message,
      commands: plan.steps.map((step) => formatStepForDisplay(step.argv))
    };
  }

  /**
   * Build the executable plan as argv arrays. Callers that intend to actually
   * run the steps should `spawn(argv[0], argv.slice(1))` (no shell). The
   * `--` separator between flags and pathspec/positional args defends
   * against a future filename starting with `-` that would otherwise be
   * parsed as a flag.
   */
  preparePlan(input: PrepareCommitInput): CommitPlan {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const selectedFiles = [...new Set(input.selectedFiles.map((file) => file.trim()).filter(Boolean))];
    const message = input.message.trim();

    if (selectedFiles.length === 0) {
      throw new Error("Select at least one file before preparing a commit.");
    }
    if (!message) {
      throw new Error("Enter a commit message before preparing a commit.");
    }

    const steps: CommitPlanStep[] = [
      { argv: ["git", "add", "--", ...selectedFiles] },
      { argv: ["git", "commit", "-m", message] }
    ];

    return {
      workspaceId: workspace.id,
      branch: workspace.branch,
      selectedFiles,
      message,
      steps
    };
  }
}

/**
 * Format an argv array as a human-readable display string. NOT shell-safe —
 * never feed the result back into a shell. For display only.
 */
export function formatPlanForDisplay(plan: CommitPlan): string[] {
  return plan.steps.map((step) => formatStepForDisplay(step.argv));
}

function formatStepForDisplay(argv: string[]): string {
  return argv.map(displayQuote).join(" ");
}

function displayQuote(value: string): string {
  // Display-only quoting: wrap in single quotes if the value contains
  // whitespace or shell metacharacters; escape embedded single quotes the
  // POSIX way so the rendered string is at least readable.
  if (/^[A-Za-z0-9_./@:=+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}
