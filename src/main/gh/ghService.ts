import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { GhCheckState, GhPrRecord } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Runs `gh` with the given args in `cwd`, returns stdout. Throws on non-zero
 * exit. Injectable so tests can stub the call without spawning a real `gh`.
 */
export type GhRunner = (cwd: string, args: string[]) => Promise<string>;

export const defaultGhRunner: GhRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync("gh", args, {
    cwd,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
    encoding: "utf8"
  });
  return stdout;
};

interface RepoViewResponse {
  owner?: { login?: string } | null;
  name?: string | null;
}

interface PrViewResponse {
  number?: number;
  headRefOid?: string;
  // gh CLI exposes statusCheckRollup as an array of per-check rows. We collapse
  // it to a single state by precedence: failure > pending > success.
  statusCheckRollup?: Array<{ state?: string | null; status?: string | null; conclusion?: string | null }>;
}

/**
 * Stage 1 of the CI feedback loop (P8.01). Detects the workspace's GitHub
 * remote and persists per-session PR status snapshots so Stage 2 can poll for
 * check failures and queue a follow-up session.
 *
 * Live behavior only — no polling timer here. The renderer (P8.02) drives
 * refreshes via the `prs:refresh` IPC for now.
 */
export class GhService {
  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly runner: GhRunner = defaultGhRunner
  ) {}

  /**
   * Reads `owner` and `name` for the project's repoPath from `gh repo view`
   * and stores them on the project row. Returns null if `gh` is unavailable
   * or the directory has no GitHub remote — non-fatal.
   */
  async detectAndStoreRemote(projectId: string): Promise<{ owner: string; name: string } | null> {
    const project = this.database.findProjectById(projectId);
    if (!project) return null;
    let stdout: string;
    try {
      stdout = await this.runner(project.repoPath, ["repo", "view", "--json", "owner,name"]);
    } catch {
      return null;
    }
    const parsed = safeJsonObject<RepoViewResponse>(stdout);
    const owner = parsed?.owner?.login ?? null;
    const name = parsed?.name ?? null;
    if (!owner || !name) return null;
    this.database.updateProjectRemote(projectId, { owner, name });
    return { owner, name };
  }

  /**
   * Returns the cached `gh_pr` rows for a session. Cheap — read-only DB hit.
   */
  listForSession(sessionId: string): GhPrRecord[] {
    return this.database.listGhPrForSession(sessionId);
  }

  /**
   * Runs `gh pr view --head <branch>` against the session's workspace and
   * upserts the resulting row(s). Returns the freshly persisted records so the
   * caller (IPC handler) can return them without a second read.
   *
   * If the session has no open PR (gh exits non-zero with "no pull requests
   * found"), this is a no-op and returns the existing cached rows. We never
   * delete rows here — historical PRs (closed/merged) stay in `gh_pr` so the
   * timeline can render them.
   */
  async refresh(sessionId: string): Promise<GhPrRecord[]> {
    const session = this.database.getSession(sessionId);
    const workspace = this.database.getWorkspace(session.workspaceId);
    if (!workspace.path) {
      return this.database.listGhPrForSession(sessionId);
    }
    let stdout: string;
    try {
      stdout = await this.runner(workspace.path, [
        "pr",
        "view",
        "--json",
        "number,headRefOid,statusCheckRollup"
      ]);
    } catch {
      // No PR for this branch yet, or gh is unavailable. Don't bubble — the
      // caller treats absence as "still no PR" and the timeline stays empty.
      return this.database.listGhPrForSession(sessionId);
    }
    const parsed = safeJsonObject<PrViewResponse>(stdout);
    if (!parsed || typeof parsed.number !== "number" || !parsed.headRefOid) {
      return this.database.listGhPrForSession(sessionId);
    }
    const record: GhPrRecord = {
      sessionId,
      prNumber: parsed.number,
      headSha: parsed.headRefOid,
      lastSeenCheckState: collapseRollup(parsed.statusCheckRollup),
      updatedAt: new Date().toISOString()
    };
    this.database.upsertGhPr(record);
    return this.database.listGhPrForSession(sessionId);
  }
}

function safeJsonObject<T>(text: string): T | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as T;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * gh's statusCheckRollup is an array of per-check entries. The state we care
 * about is the worst non-skipped state across them:
 *   failure / cancelled > pending / in_progress / queued > success / neutral / skipped
 */
function collapseRollup(rollup: PrViewResponse["statusCheckRollup"]): GhCheckState {
  if (!rollup || rollup.length === 0) return "unknown";
  let hasPending = false;
  for (const entry of rollup) {
    const state = (entry.conclusion ?? entry.state ?? entry.status ?? "").toLowerCase();
    if (state === "failure" || state === "failed" || state === "timed_out" || state === "action_required") {
      return "failure";
    }
    if (state === "cancelled" || state === "cancel") {
      return "cancelled";
    }
    if (state === "pending" || state === "in_progress" || state === "queued" || state === "waiting") {
      hasPending = true;
    }
  }
  if (hasPending) return "pending";
  // Everything else is a non-failing terminal state.
  let allSkipped = true;
  for (const entry of rollup) {
    const state = (entry.conclusion ?? entry.state ?? entry.status ?? "").toLowerCase();
    if (state !== "skipped" && state !== "neutral") {
      allSkipped = false;
      break;
    }
  }
  if (allSkipped) return "skipped";
  return "success";
}
