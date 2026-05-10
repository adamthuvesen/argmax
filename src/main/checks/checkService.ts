import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { MaestroDatabase } from "../persistence/database.js";
import type { CheckRun } from "../../shared/types.js";
import { scheduleSigkillEscalation } from "../processControl.js";

export interface RunWorkspaceCheckInput {
  workspaceId: string;
  command: string;
  /** Forwarded streaming output. Does not affect persisted summary. */
  onOutput?: (chunk: string) => void;
  /** Optional caller-driven cancellation. Aborting kills the process tree. */
  signal?: AbortSignal;
  /**
   * Hard wall-clock cap. When elapsed, the entire process tree is killed and
   * the row is recorded as `cancelled` with a "[timed-out]" prefix on the
   * summary so a future EventType extension can promote it without a data
   * migration. Defaults to 5 minutes.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class CheckService {
  /**
   * Track in-flight children per workspace so callers can cancel an entire
   * workspace's running checks (e.g. when the workspace is archived) without
   * needing the individual run handles.
   */
  private readonly running = new Map<string, Set<ChildProcess>>();

  constructor(private readonly database: MaestroDatabase) {}

  async runWorkspaceCheck(input: RunWorkspaceCheckInput): Promise<CheckRun> {
    const workspace = this.database.getWorkspace(input.workspaceId);
    const check = this.database.persistCheck({
      id: randomUUID(),
      workspaceId: workspace.id,
      command: input.command,
      status: "running"
    });

    const output: string[] = [];
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let aborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      // detached: true puts the child in its own process group so we can
      // kill the whole subtree (e.g. a `bash -c "npm test"` that forks a
      // node worker) by signaling the negative pid.
      const child = spawn(input.command, {
        cwd: workspace.path,
        shell: true,
        env: process.env,
        detached: true
      });

      this.trackChild(workspace.id, child);

      const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        output.push(text);
        input.onOutput?.(text);
      };

      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);

      // Close stdin immediately so check binaries that wait for EOF on
      // stdin (e.g. `prettier --check < /dev/stdin` style) return rather
      // than hang. We swallow EPIPE because the child may legitimately
      // close its stdin before we reach this line.
      try {
        child.stdin?.on("error", () => {
          /* swallow EPIPE; child closed stdin before we did */
        });
        child.stdin?.end();
      } catch {
        /* ignore: stdin already closed */
      }

      const killTree = (): void => {
        if (typeof child.pid !== "number") return;
        const pid = child.pid;
        // Negative pid signals the entire process group created by detached: true.
        // SIGTERM first; SIGKILL after a 2s grace period to defeat children that ignore TERM.
        scheduleSigkillEscalation(
          () => process.kill(-pid, "SIGTERM"),
          () => process.kill(-pid, "SIGKILL")
        );
      };

      const onAbort = (): void => {
        aborted = true;
        killTree();
      };
      if (input.signal) {
        if (input.signal.aborted) {
          onAbort();
        } else {
          input.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      timer.unref();

      const finish = (code: number): void => {
        clearTimeout(timer);
        if (input.signal) input.signal.removeEventListener("abort", onAbort);
        this.untrackChild(workspace.id, child);
        resolve(code);
      };

      child.on("error", (error) => {
        output.push(error.message);
        finish(1);
      });
      child.on("exit", (code) => finish(code ?? 1));
    });

    let status: CheckRun["status"];
    let summaryPrefix = "";
    if (timedOut) {
      status = "cancelled";
      summaryPrefix = "[timed-out] ";
    } else if (aborted) {
      status = "cancelled";
      summaryPrefix = "[cancelled] ";
    } else {
      status = exitCode === 0 ? "passed" : "failed";
    }

    return this.database.updateCheck(check.id, {
      status,
      exitCode,
      summary: summaryPrefix + summarizeOutput(output.join(""))
    });
  }

  /**
   * Cancel every running check for a workspace. Used during workspace
   * archive so an in-flight `npm test` doesn't keep writing into a worktree
   * directory that's about to be removed.
   */
  cancelWorkspaceChecks(workspaceId: string): void {
    const children = this.running.get(workspaceId);
    if (!children || children.size === 0) return;
    for (const child of children) {
      if (typeof child.pid !== "number") continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  private trackChild(workspaceId: string, child: ChildProcess): void {
    let bucket = this.running.get(workspaceId);
    if (!bucket) {
      bucket = new Set();
      this.running.set(workspaceId, bucket);
    }
    bucket.add(child);
  }

  private untrackChild(workspaceId: string, child: ChildProcess): void {
    const bucket = this.running.get(workspaceId);
    if (!bucket) return;
    bucket.delete(child);
    if (bucket.size === 0) this.running.delete(workspaceId);
  }
}

function summarizeOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    return "No output.";
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n");
}
