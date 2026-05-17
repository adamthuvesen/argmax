import type { ArgmaxDatabase } from "../persistence/database.js";
import type {
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitPushInput,
  GitPushResult,
  GitViewOrCreatePrInput,
  GitViewOrCreatePrResult
} from "../../shared/types.js";
import type { GhRunner, GhService } from "../gh/ghService.js";
import { defaultGhRunner } from "../gh/ghService.js";
import { errorMessage } from "../../shared/error.js";
import { runGitText } from "./exec.js";

/**
 * Runs `git` rooted at `cwd` and returns stdout. Injectable so tests can stub
 * git invocations the same way `GhRunner` lets us stub `gh`. Default wraps
 * `runGitText` so production callers don't double-wrap.
 */
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const defaultGitRunner: GitRunner = (cwd, args) => runGitText(cwd, args);

/**
 * Argmax's "do something with this branch" service. Owns the four operations
 * the renderer's git dropdown drives: stage+commit-all, push (with first-time
 * `-u origin <branch>` upgrade), create-and-checkout-branch, and the
 * view-or-create PR flow.
 *
 * `gh` is invoked via the same `GhRunner` shape `GhService` uses so the test
 * surface stays identical. Branch-name validation lives in the IPC schema; we
 * still pass `--` as a defense-in-depth separator on every git invocation that
 * accepts user-controlled refs.
 */
export class GitOpsService {
  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly ghService: GhService,
    private readonly gitRunner: GitRunner = defaultGitRunner,
    private readonly ghRunner: GhRunner = defaultGhRunner
  ) {}

  async commitAll(input: GitCommitInput): Promise<GitCommitResult> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    if (!workspace.path) {
      throw new Error("Workspace has no path on disk yet.");
    }
    const message = input.message.trim();
    // When the caller passes `selectedFiles`, stage only those paths with a
    // `--` separator so a filename starting with `-` can't be misparsed as a
    // flag. Empty/missing array falls back to `git add -A` (stage everything),
    // which keeps the dropdown's old "commit all" behavior for any caller that
    // doesn't care about per-file selection.
    const selected = input.selectedFiles?.filter((path) => path.trim().length > 0) ?? [];
    if (selected.length > 0) {
      await this.gitRunner(workspace.path, ["add", "--", ...selected]);
    } else {
      await this.gitRunner(workspace.path, ["add", "-A"]);
    }
    // Refuse messages whose trimmed form begins with '-' — `git commit -m`
    // with `-m -- msg` is not valid syntax and a message that looks like a
    // flag (`--gpg-sign=evil`) would be parsed as a flag, not body.
    // (audit-2026-05-17 M13)
    if (message.startsWith("-")) {
      throw new Error("Commit message cannot start with '-'");
    }
    await this.gitRunner(workspace.path, ["commit", "-m", message]);
    const sha = (await this.gitRunner(workspace.path, ["rev-parse", "HEAD"])).trim();
    const branch = (await this.gitRunner(workspace.path, ["branch", "--show-current"])).trim();
    return { commitSha: sha, branch: branch || workspace.branch };
  }

  async push(input: GitPushInput): Promise<GitPushResult> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    if (!workspace.path) {
      throw new Error("Workspace has no path on disk yet.");
    }
    const branch =
      (await this.gitRunner(workspace.path, ["branch", "--show-current"])).trim() || workspace.branch;
    try {
      await this.gitRunner(workspace.path, ["push"]);
      return { branch, upstreamSet: false };
    } catch (error) {
      if (!isMissingUpstreamError(error)) throw error;
      // First push for this branch — set upstream so subsequent pushes work
      // without -u. Pass `--` is not valid for `git push`; the branch name is
      // already validated by the schema.
      await this.gitRunner(workspace.path, ["push", "-u", "origin", branch]);
      return { branch, upstreamSet: true };
    }
  }

  async createBranch(input: GitCreateBranchInput): Promise<GitCreateBranchResult> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    if (!workspace.path) {
      throw new Error("Workspace has no path on disk yet.");
    }
    await this.gitRunner(workspace.path, ["checkout", "-b", input.branch]);
    return { branch: input.branch };
  }

  async viewOrCreatePr(input: GitViewOrCreatePrInput): Promise<GitViewOrCreatePrResult> {
    const session = this.database.getSession(input.sessionId);
    const workspace = this.database.getWorkspace(session.workspaceId);
    if (!workspace.path) {
      throw new Error("Workspace has no path on disk yet.");
    }

    const existing = this.database.listGhPrForSession(input.sessionId);
    const top = mostRecent(existing);
    if (top) {
      const remote = this.database.getProjectRemote(workspace.projectId);
      if (remote) {
        return {
          action: "opened",
          url: `https://github.com/${remote.owner}/${remote.name}/pull/${top.prNumber}`,
          prNumber: top.prNumber
        };
      }
    }

    // No PR record yet — create one. `--fill` reuses the branch's commit
    // messages for the title/body so the user doesn't have to retype them.
    const stdout = await this.ghRunner(workspace.path, ["pr", "create", "--fill"]);
    const url = extractPrUrl(stdout);
    if (!url) {
      throw new Error(`gh pr create did not return a PR URL: ${stdout.slice(0, 256)}`);
    }
    // Refresh so the gh_pr table picks up the new PR for the next invocation.
    const refreshed = await this.ghService.refresh(input.sessionId);
    const created = refreshed.find((row) => urlMatchesPr(url, row.prNumber)) ?? mostRecent(refreshed);
    return {
      action: "created",
      url,
      prNumber: created?.prNumber ?? null
    };
  }
}

function isMissingUpstreamError(error: unknown): boolean {
  return /no upstream branch|set-upstream|has no upstream/i.test(errorMessage(error));
}

function mostRecent<T extends { updatedAt: string }>(rows: T[]): T | undefined {
  if (rows.length === 0) return undefined;
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function urlMatchesPr(url: string, prNumber: number): boolean {
  return new RegExp(`/pull/${prNumber}(?:[/?#]|$)`).test(url);
}

/**
 * gh prints the new PR URL on its own line as the last meaningful line of
 * stdout. Match a github.com pull URL — anchoring to `https://github.com/`
 * keeps a hijacked or compromised gh binary from printing a malicious URL
 * that would then be passed to `shell.openExternal`.
 */
function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\S*/);
  return match ? match[0].trim() : null;
}
