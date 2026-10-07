import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../../../scripts/doctor.mjs";
import { buildScratchApp } from "../../../scripts/scratch-app.mjs";
import { runVerification, parseVerifyArgs } from "../../../scripts/verify.mjs";
import { writeJson } from "../../../scripts/verification/evidence.mjs";
import { runChecked, terminateRunningCommands } from "../../../scripts/verification/common.mjs";
import { parseMacosConsoleLockState } from "../../../scripts/verification/desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const [command, feature, requestedOutputDir] = process.argv.slice(2);
const outputDir = requestedOutputDir ?? path.join(process.env.VERIFY_RUN_DIR ?? ".verify/state", `replay-${command}-${feature}-${Date.now()}`);
if (["build", "doctor"].includes(command)) {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
    terminateRunningCommands("SIGTERM");
    setTimeout(() => terminateRunningCommands("SIGKILL"), 2000).unref();
    process.exitCode = 1;
  });
}
async function screenIsLocked() {
  const { stdout } = await runChecked("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { timeoutMs: 5000 });
  const lock = parseMacosConsoleLockState(stdout);
  return lock.ioConsoleLocked === true || lock.screenIsLocked === true;
}
async function main() {
  if (command === "build") {
    await buildScratchApp({
      features: ["custom-protocol", "verification"],
      targetDir: path.join(root, "src-tauri/target/verification"),
      rendererOutDir: path.join(root, "dist/verification"),
      logDir: path.join(feature, "build"),
      env: { ...process.env, VITE_ARGMAX_VERIFICATION: "1", TAURI_CONFIG: JSON.stringify({ build: { frontendDist: "../dist/verification" } }) }
    });
    return;
  }
  if (command === "doctor") {
    const report = await runDoctor();
    await writeJson(path.join(feature, "doctor.json"), report);
    if (!report.ok) throw new Error(`doctor prerequisites: ${report.failures.join(", ")}`);
    // Native drives must bring a window to the front, which a locked console refuses.
    if (await screenIsLocked()) throw new Error("screen is locked. Unlock the Mac and keep it awake before driving");
    return;
  }
  if (command === "cleanup-check") {
    const processes = await runChecked("/bin/ps", ["-axo", "pid=,lstart="], { timeoutMs: 5000 });
    for (const dir of readdirSync(feature, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      const reportPath = path.join(feature, dir.name, "report.json");
      if (!existsSync(reportPath)) continue;
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      if (report.process.desktop && !report.process.desktop.closed) throw new Error(`native cleanup not confirmed: ${reportPath}`);
      if (report.keptRunRoot) throw new Error(`temporary profile retained: ${reportPath}`);
      const cleanup = report.process.desktop?.cleanup;
      if (cleanup && processes.stdout.split("\n").some((line) => {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        return match && Number(match[1]) === cleanup.appPid && match[2] === cleanup.appStartedAt;
      })) throw new Error(`owned native app still running: ${cleanup.appPid}`);
      const binary = report.build?.launchedBinary;
      if (binary && existsSync(binary)) throw new Error(`temporary app survived: ${binary}`);
    }
    return;
  }
  if (!["drive", "control"].includes(command)) throw new Error("unknown verification worker command");
  const { report } = await runVerification(parseVerifyArgs(["--scenario", feature, "--out", outputDir]));
  const expected = command === "control" ? "complete" : ({ "chat-resume": "complete", "queued-restart": "complete", "session-move": "complete", "composer-reference": "complete", "composer-editor": "complete", "browser-focus": "complete", "browser-frames": "complete", visualizations: "complete", "fork-merge": "complete", "workspace-settings": "complete", cancellation: "cancelled", "provider-error": "failed" })[feature];
  const actual = report.session?.state;
  const requiredFiles = ["report.json", "timeline.ndjson", "database.json", ...(report.evidenceFiles ?? []).filter((file) => file.endsWith(".png"))];
  const missingFiles = requiredFiles.filter((file) => !existsSync(path.join(outputDir, file)));
  const healthy = report.status === "passed" && report.errors.length === 0
    && report.assertions.every((assertion) => assertion.ok)
    && requiredFiles.length > 3 && missingFiles.length === 0;
  const assertionPassed = actual === expected;
  const lockedOut = !healthy && report.errors.some((error) => error.message.includes("foreground-activation-timeout")) && await screenIsLocked();
  const result = lockedOut ? "unreachable" : !healthy ? "fail" : command === "control"
    ? assertionPassed ? "passed-unexpectedly" : "fail-observed"
    : assertionPassed ? "pass" : "fail";
  await writeJson(path.join(outputDir, "verdict.json"), { result, assertion: "terminal session state", expected, actual, healthy, missingFiles, assertionExit: healthy && assertionPassed ? 0 : 1 });
  if (result === "fail-observed") { console.log(`FAIL observed: expected ${expected}, got ${actual}`); process.exitCode = 1; return; }
  if (result !== "pass") throw new Error(`${result}: ${report.errors.map((error) => error.message).join("; ") || `expected ${expected}, got ${actual}`}`);
}
await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
