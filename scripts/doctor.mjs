#!/usr/bin/env node

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runCommand, uniqueRunId, withTimeout } from "./verification/common.mjs";
import { writeJson } from "./verification/evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Arc.app/Contents/MacOS/Arc"
];

export function parseDoctorArgs(argv) {
  const options = { output: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error("--out requires a value");
      options.output = value;
    }
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
}

async function executable(name, args = ["--version"]) {
  try {
    const result = await runCommand(name, args, { cwd: repoRoot, timeoutMs: 15_000 });
    return {
      ok: result.code === 0,
      detail: (result.stdout.trim() || result.stderr.trim()).split("\n")[0] || `exit ${result.code}`,
      remediation: result.code === 0 ? null : `Install ${name} and make it available on PATH.`
    };
  } catch (error) {
    return { ok: false, detail: error.message, remediation: `Install ${name} and make it available on PATH.` };
  }
}

async function localhostCapability() {
  const server = createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("argmax-doctor");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server had no TCP address");
    const response = await withTimeout(fetch(`http://127.0.0.1:${address.port}/`), 5000, "loopback fetch");
    return { ok: response.ok && (await response.text()) === "argmax-doctor", detail: `bound 127.0.0.1:${address.port}` };
  } catch (error) {
    return { ok: false, detail: error.message, remediation: "Allow the agent host to bind and fetch loopback HTTP ports." };
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function browserCapability() {
  let browser = null;
  for (const candidate of browserCandidates) {
    try {
      await access(candidate, constants.X_OK);
      browser = candidate;
      break;
    } catch {}
  }
  if (!browser) {
    return { ok: false, remediation: "Install a Chromium-based browser in /Applications." };
  }
  const profile = await mkdtemp(path.join(tmpdir(), "argmax-doctor-browser-"));
  try {
    try {
      const result = await runCommand(
        browser,
        ["--headless=new", "--no-first-run", `--user-data-dir=${profile}`, "--dump-dom", "data:text/html,argmax-doctor"],
        { timeoutMs: 20_000 }
      );
      return {
        ok: result.code === 0 && result.stdout.includes("argmax-doctor"),
        detail: browser,
        remediation: result.code === 0 ? null : "Allow this agent host to launch the browser, then rerun doctor."
      };
    } catch (error) {
      return {
        ok: false,
        detail: error.message,
        remediation: "Allow this agent host to launch the browser, then rerun doctor."
      };
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

async function repositoryWriteCapability() {
  const directory = path.join(repoRoot, "scratch", `.doctor-${uniqueRunId()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "probe"), "ok\n");
    return { ok: true, detail: "scratch/ is writable" };
  } catch (error) {
    return { ok: false, detail: error.message, remediation: `Grant write access to ${path.join(repoRoot, "scratch")}.` };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function macosPermissions() {
  if (process.platform !== "darwin") {
    return {
      screenRecording: { status: "not-applicable" },
      accessibility: { status: "not-applicable" }
    };
  }
  const source = [
    "import ApplicationServices",
    "import CoreGraphics",
    "print(\"screen=\\(CGPreflightScreenCaptureAccess())\")",
    "print(\"accessibility=\\(AXIsProcessTrusted())\")"
  ].join("\n");
  let result;
  try {
    result = await runCommand("/usr/bin/swift", ["-"], { input: source, timeoutMs: 30_000 });
  } catch (error) {
    return {
      screenRecording: { status: "unverified", detail: error.message },
      accessibility: { status: "unverified", detail: error.message }
    };
  }
  if (result.code !== 0) {
    return {
      screenRecording: { status: "unverified", detail: result.stderr.trim() },
      accessibility: { status: "unverified", detail: result.stderr.trim() }
    };
  }
  const values = Object.fromEntries(result.stdout.trim().split("\n").map((line) => line.split("=")));
  return {
    screenRecording: {
      status: values.screen === "true" ? "granted" : "missing",
      remediation: values.screen === "true" ? null : "Grant Screen Recording to the app that runs Codex, then restart it."
    },
    accessibility: {
      status: values.accessibility === "true" ? "granted" : "missing",
      remediation: values.accessibility === "true" ? null : "Grant Accessibility to the app that runs Codex, then restart it."
    }
  };
}

async function nativeCapability() {
  try {
    const desktop = await import("./verification/desktop.mjs");
    const hasApi = [desktop.connectDesktop, desktop.verifyDesktopSession, desktop.sendDesktopMessage, desktop.stopDesktopSession]
      .every((entry) => typeof entry === "function");
    const requiredTools = {};
    for (const toolPath of ["/usr/sbin/lsof", "/usr/bin/swift"]) {
      try {
        await access(toolPath, constants.X_OK);
        requiredTools[toolPath] = { available: true };
      } catch {
        requiredTools[toolPath] = { available: false };
      }
    }
    const missingTools = Object.entries(requiredTools)
      .filter(([, result]) => !result.available)
      .map(([toolPath]) => toolPath);
    const available = process.platform === "darwin" && hasApi && missingTools.length === 0;
    const remediation = [];
    if (process.platform !== "darwin" || !hasApi) remediation.push("Install the native verification dependencies on macOS.");
    if (missingTools.includes("/usr/bin/swift")) remediation.push("Install Xcode Command Line Tools so /usr/bin/swift is available.");
    if (missingTools.includes("/usr/sbin/lsof")) remediation.push("Restore the macOS lsof utility at /usr/sbin/lsof.");
    return {
      ok: available,
      detail: {
        platform: process.platform,
        toolingLoaded: hasApi,
        requiredTools,
        runtimeVerified: false,
        runtimeProof: "npm run verify"
      },
      remediation: remediation.length ? remediation.join(" ") : null
    };
  } catch (error) {
    return { ok: false, detail: error.message, remediation: "Install the repository's native verification tooling." };
  }
}

function versionAtLeast(actual, minimum) {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

async function runtimeRequirements(node, rustc) {
  const nodeMinimum = process.versions.node.split(".")[0] === "20" ? "20.19.0" : "22.12.0";
  node.requirement = `Node 20.19+ or 22.12+ (Vite 8); detected ${process.versions.node}`;
  node.ok = node.ok && (versionAtLeast(process.versions.node, "22.12.0") || versionAtLeast(process.versions.node, "20.19.0") && !versionAtLeast(process.versions.node, "21.0.0"));
  if (!node.ok) node.remediation = `Install Node ${nodeMinimum} or newer in a supported major line.`;

  const manifest = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(repoRoot, "src-tauri", "Cargo.toml"), "utf8"));
  const minimumRust = manifest.match(/^rust-version\s*=\s*"([^"]+)"/m)?.[1];
  const actualRust = rustc.detail?.match(/rustc\s+(\d+\.\d+\.\d+)/)?.[1];
  rustc.requirement = minimumRust ? `Rust ${minimumRust}+ from src-tauri/Cargo.toml` : "unresolved from manifest";
  if (!minimumRust || !actualRust || !versionAtLeast(actualRust, minimumRust)) {
    rustc.ok = false;
    rustc.remediation = `Install Rust ${minimumRust ?? "matching the manifest"} or newer.`;
  }
}

export async function runDoctor() {
  const [node, npm, git, cargo, rustc, sqlite, subprocess, loopback, browser, repositoryWrite, permissions, native] = await Promise.all([
    executable(process.execPath),
    executable("npm"),
    executable("git"),
    executable("cargo"),
    executable("rustc"),
    executable("sqlite3", ["--version"]),
    executable(process.execPath, ["-e", "process.stdout.write('child-ok')"]),
    localhostCapability(),
    browserCapability(),
    repositoryWriteCapability(),
    macosPermissions(),
    nativeCapability()
  ]);
  const capabilities = { node, npm, git, cargo, rustc, sqlite, subprocess, loopback, browser, repositoryWrite, native };
  await runtimeRequirements(node, rustc);
  const requiredFailures = Object.entries(capabilities).filter(([, result]) => !result.ok).map(([name]) => name);
  return {
    schemaVersion: 1,
    ok: requiredFailures.length === 0,
    generatedAt: new Date().toISOString(),
    platform: { os: process.platform, arch: process.arch },
    capabilities,
    permissions,
    optionalCapabilities: {
      wholeWindowCapture: permissions.screenRecording,
      osInteraction: permissions.accessibility
    },
    failures: requiredFailures
  };
}

async function main() {
  try {
    const options = parseDoctorArgs(process.argv.slice(2));
    const report = await runDoctor();
    if (options.output) await writeJson(path.resolve(options.output), report);
    const failures = report.failures.length ? ` failures=${report.failures.join(",")}` : "";
    process.stderr.write(`${report.ok ? "READY" : "NOT READY"}${failures}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`doctor failed: ${error.message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
