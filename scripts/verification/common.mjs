import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";

const runningCommandGroups = new Set();

export function terminateRunningCommands(signal = "SIGTERM") {
  for (const pid of runningCommandGroups) {
    try {
      if (process.platform === "win32") process.kill(pid, signal);
      else process.kill(-pid, signal);
    } catch {}
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

export function runCommand(command, args, options = {}) {
  const { cwd, env, timeoutMs = 60_000, input, stdoutPath, stderrPath } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
    });
    if (child.pid !== undefined) runningCommandGroups.add(child.pid);
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const killTree = (signal) => {
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {}
    };
    let forceKillTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      forceKillTimer = setTimeout(() => killTree("SIGKILL"), 2000);
      forceKillTimer.unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      runningCommandGroups.delete(child.pid);
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      runningCommandGroups.delete(child.pid);
      const result = {
        command,
        args,
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      try {
        if (stdoutPath) await import("node:fs/promises").then(({ writeFile }) => writeFile(stdoutPath, result.stdout));
        if (stderrPath) await import("node:fs/promises").then(({ writeFile }) => writeFile(stderrPath, result.stderr));
      } catch (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function runChecked(command, args, options = {}) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `signal ${result.signal ?? "unknown"}`;
    const reason = result.timedOut ? ` timed out after ${options.timeoutMs ?? 60_000}ms:` : " failed:";
    throw new Error(`${command} ${args.join(" ")}${reason} ${detail}`);
  }
  return result;
}

export async function checkoutFingerprint(repoRoot) {
  const [head, files, status] = await Promise.all([
    runChecked("git", ["rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 10_000 }),
    runChecked("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      timeoutMs: 30_000
    }),
    runChecked("git", ["status", "--short", "--untracked-files=all"], { cwd: repoRoot, timeoutMs: 30_000 })
  ]);
  const names = files.stdout.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    const absolute = path.join(repoRoot, name);
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch {
      hash.update(`missing\0${name}\0`);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      hash.update(`symlink\0${name}\0${await readlink(absolute)}\0`);
      continue;
    }
    if (!metadata.isFile()) continue;
    hash.update(`file\0${name}\0${metadata.mode}\0${metadata.size}\0`);
    hash.update(await readFile(absolute));
  }
  return {
    head: head.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
    status: status.stdout.trim().split("\n").filter(Boolean),
    fileCount: names.length,
    sha256: hash.digest("hex")
  };
}

export async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export function uniqueRunId(now = new Date()) {
  return `${now.toISOString().replaceAll(":", "-").replace(".", "-")}-${randomUUID().slice(0, 8)}`;
}

export function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}
