#!/usr/bin/env node
// Boot an isolated Argmax instance for verification. The module API is used
// by scripts/verify.mjs; the CLI preserves the original foreground behavior.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { connectBridge } from "./bridge-client.mjs";
import { delay, runChecked, withTimeout } from "./verification/common.mjs";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseScratchArgs(argv) {
  const options = { dataDir: null, port: null, build: false, release: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--data-dir requires a value");
      options.dataDir = value;
    }
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--build") options.build = true;
    else if (arg === "--release") options.release = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    server.on("error", reject);
  });
}

export function scratchBinaryPath({ release = false, targetDir = null } = {}) {
  return path.join(targetDir ?? path.join(repoRoot, "src-tauri", "target"), release ? "release" : "debug", "argmax");
}

export async function buildScratchApp({
  release = false,
  features = ["custom-protocol"],
  env = process.env,
  targetDir = null,
  rendererOutDir = null,
  logDir = null
} = {}) {
  if (logDir) mkdirSync(logDir, { recursive: true });
  const rendererArgs = ["run", "build:renderer"];
  if (rendererOutDir) rendererArgs.push("--", "--outDir", rendererOutDir);
  await runChecked("npm", rendererArgs, {
    cwd: repoRoot,
    env,
    timeoutMs: 180_000,
    stdoutPath: logDir ? path.join(logDir, "renderer.stdout.log") : null,
    stderrPath: logDir ? path.join(logDir, "renderer.stderr.log") : null
  });
  const cargoArgs = ["build", "--manifest-path", "src-tauri/Cargo.toml"];
  if (targetDir) cargoArgs.push("--target-dir", targetDir);
  if (features.length) cargoArgs.push("--features", features.join(","));
  if (release) cargoArgs.push("--release");
  await runChecked("cargo", cargoArgs, {
    cwd: repoRoot,
    env,
    timeoutMs: 600_000,
    stdoutPath: logDir ? path.join(logDir, "cargo.stdout.log") : null,
    stderrPath: logDir ? path.join(logDir, "cargo.stderr.log") : null
  });
  return scratchBinaryPath({ release, targetDir });
}

function readRemoteConfig(configPath) {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

/** Launch a scratch instance and wait for a real bridge round trip. */
export async function startScratchApp(options = {}) {
  const {
    dataDir = path.join(tmpdir(), `argmax-scratch-${Date.now()}`),
    port: requestedPort = null,
    release = false,
    build = false,
    features = ["custom-protocol"],
    env = process.env,
    readyTimeoutMs = 60_000,
    stopTimeoutMs = 8_000
  } = options;
  if (build) await buildScratchApp({ release, features, env, targetDir: options.targetDir ?? null });
  const binary = options.binary ?? scratchBinaryPath({ release, targetDir: options.targetDir ?? null });
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}; run the scratch build first`);
  try {
    accessSync(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`binary is not executable: ${binary}`);
  }

  const absoluteDataDir = path.resolve(dataDir);
  mkdirSync(absoluteDataDir, { recursive: true });
  const remoteConfigPath = path.join(absoluteDataDir, "remote.json");
  const remoteConfig = readRemoteConfig(remoteConfigPath);
  const port = requestedPort ?? remoteConfig?.port ?? (await freePort());
  const token = remoteConfig?.token ?? randomUUID().replaceAll("-", "");
  writeFileSync(remoteConfigPath, `${JSON.stringify({ enabled: true, port, token }, null, 2)}\n`, { mode: 0o600 });

  const logPath = path.join(absoluteDataDir, "app.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(binary, [], {
    cwd: repoRoot,
    env: { ...env, ARGMAX_DATA_DIR: absoluteDataDir },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  let exitResult = null;
  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error.message;
    });
    child.once("close", (code, signal) => {
      exitResult = { code, signal, ...(spawnError ? { error: spawnError } : {}) };
      logStream.end();
      resolve(exitResult);
    });
  });

  const deadline = Date.now() + readyTimeoutMs;
  let lastError = null;
  while (Date.now() <= deadline && exitResult === null) {
    try {
      const bridge = await connectBridge({ port, token, timeoutMs: 2000, callTimeoutMs: 2000 });
      await bridge.call("health:ping", {});
      bridge.close();
      break;
    } catch (error) {
      lastError = error;
      await delay(300);
    }
  }
  if (exitResult !== null || Date.now() > deadline) {
    const timedOut = exitResult === null;
    if (exitResult === null) {
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([exited, delay(2000)]);
    throw new Error(
      timedOut
        ? `bridge did not become ready within ${readyTimeoutMs}ms: ${lastError?.message ?? "unknown error"}; log: ${logPath}`
        : `Argmax exited before readiness (code ${exitResult.code ?? "-"}, signal ${exitResult.signal ?? "-"}${exitResult.error ? `, error ${exitResult.error}` : ""}); log: ${logPath}`
    );
  }

  async function stop() {
    if (exitResult !== null) return { ...exitResult, forced: false };
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch {}
    try {
      const result = await withTimeout(exited, stopTimeoutMs, "scratch app shutdown");
      return { ...result, forced: false };
    } catch {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {}
      const result = await withTimeout(exited, 3000, "forced scratch app shutdown");
      return { ...result, forced: true };
    }
  }

  return {
    ready: true,
    port,
    token,
    dataDir: absoluteDataDir,
    pid: child.pid,
    log: logPath,
    binary,
    child,
    exited,
    stop
  };
}

async function main() {
  try {
    const options = parseScratchArgs(process.argv.slice(2));
    const app = await startScratchApp({ ...options, features: ["custom-protocol"] });
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    console.log(JSON.stringify({ ready: true, port: app.port, token: app.token, dataDir: app.dataDir, pid: app.pid, log: app.log }));
    const result = await app.exited;
    console.error(`argmax exited (code ${result.code ?? "-"}, signal ${result.signal ?? "-"}); log: ${app.log}`);
    process.exitCode = stopping ? 0 : (result.code ?? 1);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
