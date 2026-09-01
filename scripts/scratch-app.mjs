#!/usr/bin/env node
// Boot an isolated Argmax instance for verification.
//
// Points `ARGMAX_DATA_DIR` at a scratch profile so the instance gets its own
// database, instance lock, and `remote.json` — it runs alongside the real app
// instead of colliding with it. The scratch `remote.json` is written with the
// bridge enabled on a free port, and readiness is probed through a real
// bridge handshake (`health:ping`), so when this prints its ready line the
// instance is drivable via `scripts/bridge.mjs`.
//
// Usage:
//   node scripts/scratch-app.mjs [--data-dir <dir>] [--port <n>] [--build] [--release]
//
// The binary must be built with the `custom-protocol` feature — without it a
// debug build tries to load the vite dev server instead of its bundled
// renderer. `--build` runs the renderer build and the cargo build for you.
//
// Prints one JSON line on stdout when ready:
//   {"ready":true,"port":…,"token":"…","dataDir":"…","pid":…,"log":"…"}
// then stays in the foreground owning the app process; SIGINT/SIGTERM stop it.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectBridge } from "./bridge-client.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { dataDir: null, port: null, build: false, release: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--build") options.build = true;
    else if (arg === "--release") options.release = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  if (options.port !== null && !Number.isInteger(options.port)) {
    console.error("--port must be an integer");
    process.exit(1);
  }
  return options;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

const options = parseArgs(process.argv.slice(2));
const profile = options.release ? "release" : "debug";
const binary = path.join(repoRoot, "src-tauri", "target", profile, "argmax");

if (options.build) {
  run("npm", ["run", "build:renderer"]);
  const cargoArgs = ["build", "--manifest-path", "src-tauri/Cargo.toml", "--features", "custom-protocol"];
  if (options.release) cargoArgs.push("--release");
  run("cargo", cargoArgs);
}
if (!existsSync(binary)) {
  console.error(
    `no binary at ${binary}\n` +
      `build one first (bundled renderer included):\n` +
      `  npm run build:renderer && cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol` +
      (options.release ? " --release" : "")
  );
  process.exit(1);
}

const dataDir = path.resolve(options.dataDir ?? path.join(tmpdir(), `argmax-scratch-${Date.now()}`));
mkdirSync(dataDir, { recursive: true });

// Reuse an existing scratch profile's credentials so a stable --data-dir keeps
// a stable token across restarts; otherwise seed a fresh enabled config.
const remoteConfigPath = path.join(dataDir, "remote.json");
let remoteConfig = null;
if (existsSync(remoteConfigPath)) {
  try {
    remoteConfig = JSON.parse(readFileSync(remoteConfigPath, "utf8"));
  } catch {
    remoteConfig = null;
  }
}
const port = options.port ?? remoteConfig?.port ?? (await freePort());
const token = remoteConfig?.token ?? randomUUID().replaceAll("-", "");
writeFileSync(remoteConfigPath, `${JSON.stringify({ enabled: true, port, token }, null, 2)}\n`);

const logPath = path.join(dataDir, "app.log");
const logStream = createWriteStream(logPath, { flags: "a" });
const child = spawn(binary, [], {
  cwd: repoRoot,
  env: { ...process.env, ARGMAX_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

let stopping = false;
function stop(signal) {
  stopping = true;
  child.kill(signal);
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code, signal) => {
  console.error(`argmax exited (code ${code ?? "-"}, signal ${signal ?? "-"}); log: ${logPath}`);
  process.exit(stopping ? 0 : (code ?? 1));
});

const READY_TIMEOUT_MS = 60_000;
const deadline = Date.now() + READY_TIMEOUT_MS;
let bridge = null;
while (bridge === null) {
  if (Date.now() > deadline) {
    console.error(`bridge did not come up within ${READY_TIMEOUT_MS / 1000}s; log: ${logPath}`);
    stop("SIGTERM");
    process.exit(1);
  }
  try {
    bridge = await connectBridge({ port, token, timeoutMs: 2000 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
await bridge.call("health:ping", {});
bridge.close();

console.log(JSON.stringify({ ready: true, port, token, dataDir, pid: child.pid, log: logPath }));
