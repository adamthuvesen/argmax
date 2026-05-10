import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface GitExecOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run a git invocation rooted at `cwd` and return stdout as a UTF-8 string.
 * Bounded so a runaway invocation cannot stall the IPC handler indefinitely.
 * On failure, throws `Error` with the captured stderr (truncated).
 */
export async function runGitText(cwd: string, args: string[], options: GitExecOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
      encoding: "utf8"
    });
    return stdout;
  } catch (error) {
    const stderrText = extractStderr(error);
    throw new Error(`git failed: ${stderrText.slice(0, 4096)}`);
  }
}

/**
 * Variant that returns stdout as a Buffer — used by checkpoint snapshots that
 * include base64-encoded binary patch hunks where utf-8 decoding would corrupt
 * bytes before the patch is written to disk.
 */
export async function runGitBuffer(cwd: string, args: string[], options: GitExecOptions = {}): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: options.maxBufferBytes ?? 256 * 1024 * 1024,
    encoding: "buffer"
  });
  return stdout;
}

/** Non-throwing variant — returns null when git exits non-zero. */
export async function runGitMaybe(cwd: string, args: string[], options: GitExecOptions = {}): Promise<string | null> {
  try {
    return await runGitText(cwd, args, options);
  } catch {
    return null;
  }
}

function extractStderr(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") return stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString("utf8");
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
