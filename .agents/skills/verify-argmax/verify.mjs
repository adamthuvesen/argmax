#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutFingerprint, uniqueRunId } from "../../../scripts/verification/common.mjs";
import { redact } from "../../../scripts/verification/evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const stateDir = path.join(root, ".verify/state");
const stateFile = path.join(stateDir, "run.json");
const worker = path.join(root, ".agents/skills/verify-argmax/drives.mjs");
const helper = "node .agents/skills/verify-argmax/verify.mjs";
const target = "native-local";
const tripwires = ["launchctl", "defaults", "brew", "security", "op", "crontab", "systemctl"];
const features = ["chat-resume", "queued-restart", "session-move", "cancellation", "provider-error"];
const controlVariables = new Set(["DOTFILES_SKIP_SECRETS", "DOTFILES_SECRETS_LOADED", "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS"]);
const secretValues = Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && !controlVariables.has(key) && value).map(([, value]) => value);
function sanitize(value) {
  let text = redact(String(value));
  for (const secret of secretValues) text = text.replaceAll(secret, "[redacted]");
  return text;
}
function save(state) { writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n"); }
function load() {
  if (!existsSync(stateFile)) throw new Error(`no active run. Run ${helper} launch`);
  return JSON.parse(readFileSync(stateFile, "utf8"));
}
function ownership(state) {
  if (state.stateDir !== stateDir || path.dirname(state.runDir) !== path.join(root, ".verify/runs")) throw new Error("run ownership mismatch");
}
function allow(state) {
  ownership(state);
  if ((process.env.VERIFY_TARGET ?? target) !== target) throw new Error("undeclared VERIFY_TARGET. Only native-local is allowed");
  if (readFileSync(path.join(stateDir, "tripwire.log"), "utf8").trim()) throw new Error("machine-global command attempted. Inspect tripwire.log and clean");
}
function environment(state) {
  const home = path.join(stateDir, "home");
  return {
    PATH: [path.join(stateDir, "tripwire"), path.dirname(process.execPath), path.join(state.cargoHome, "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    SHELL: path.join(stateDir, "shell"),
    HOME: home, TMPDIR: path.join(stateDir, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local/state"),
    CARGO_HOME: state.cargoHome, RUSTUP_HOME: state.rustupHome,
    npm_config_cache: path.join(stateDir, "npm-cache"), npm_config_offline: "true",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    ARGMAX_VERIFICATION: "1", ARGMAX_DATA_DIR: path.join(stateDir, "profile"),
    ARGMAX_VERIFICATION_HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"), CURSOR_CONFIG_DIR: path.join(home, ".cursor"),
    GROK_HOME: path.join(home, ".grok"),
    VERIFY_TRIPWIRE_LOG: path.join(stateDir, "tripwire.log"),
    VERIFY_RUN_DIR: state.runDir,
    LANG: "en_US.UTF-8", CI: "1"
  };
}
async function child(state, args, logName, cleaning = false) {
  if (cleaning) ownership(state); else allow(state);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { cwd: root, env: environment(state), stdio: ["ignore", "pipe", "pipe"] });
    state.commandPid = child.pid;
    save(state);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    child.once("error", (error) => { delete state.commandPid; save(state); reject(error); });
    child.once("close", (code) => {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      resolve({ code: code ?? 1, output });
    });
  });
  delete state.commandPid;
  save(state);
  writeFileSync(path.join(state.runDir, logName), sanitize(result.output));
  if (result.code !== 0) process.stderr.write(sanitize(result.output).slice(-5000));
  return result.code;
}
async function doctor(state) {
  allow(state);
  if (!state.ready) throw new Error("launch did not finish. Inspect launch.log, then clean");
  const current = await checkoutFingerprint(root);
  if (current.head !== state.source.head || current.sha256 !== state.source.sha256) throw new Error("stale: checkout changed since launch. Clean and launch again");
  const code = await child(state, [process.execPath, worker, "doctor", state.runDir], "doctor.log");
  if (code !== 0) throw new Error("doctor failed. Inspect doctor.json");
  allow(state);
  console.log(`READY ${state.runDir}`);
}
function manifest(state, values) {
  const block = { ...values, target, sha: state.source.head, dirty: state.source.dirty };
  appendFileSync(path.join(state.runDir, "manifest.txt"), Object.entries(block).map(([key, value]) => `${key}: ${sanitize(value)}`).join("\n") + "\n\n");
}
// Renderer-only proof: the demo snapshot in headless Chrome, with no native build or run state.
async function screenshotUi(args) {
  if ((process.env.VERIFY_TARGET ?? target) !== target) throw new Error("undeclared VERIFY_TARGET. Only native-local is allowed");
  if (args.length && args.shift() !== "--") throw new Error("ui takes -- <ui-screenshot options>");
  const owned = args.find((arg) => ["--out", "--theme", "--url"].includes(arg));
  // --url could reach a live Argmax through its remote bridge, so only the demo renderer is allowed.
  if (owned) throw new Error(`ui sets ${owned === "--url" ? "the demo renderer" : owned} itself. Drop ${owned}`);
  const source = await checkoutFingerprint(root);
  const runDir = path.join(root, ".verify/runs", `${uniqueRunId()}-${source.head.slice(0, 7)}${source.dirty ? "-dirty" : ""}-ui`);
  mkdirSync(runDir, { recursive: true });
  const started = new Date().toISOString();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
  const shots = [];
  let log = "";
  for (const theme of ["dark", "light"]) {
    const out = path.join(runDir, `ui-${theme}.png`);
    const code = await new Promise((resolve, reject) => {
      const shot = spawn(process.execPath, ["scripts/ui-screenshot.mjs", "--out", out, "--theme", theme, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      shot.stdout.on("data", (chunk) => { log += chunk; });
      shot.stderr.on("data", (chunk) => { log += chunk; });
      shot.once("error", reject);
      shot.once("close", (exit) => resolve(exit ?? 1));
    });
    writeFileSync(path.join(runDir, "ui.log"), sanitize(log));
    if (code !== 0 || !existsSync(out)) throw new Error(`ui-screenshot failed for ${theme}. Inspect ${path.join(runDir, "ui.log")}`);
    shots.push(out);
  }
  const after = await checkoutFingerprint(root);
  if (after.sha256 !== source.sha256) throw new Error("stale: checkout changed during the screenshots. Run ui again");
  manifest({ source, runDir }, { feature: "ui", entry: "scripts/ui-screenshot.mjs", command: `${helper} ui -- ${args.join(" ")}`.trim(), exit: 0, result: "captured", started, evidence: runDir });
  console.log(`UI ${shots.join(" ")}`);
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "inventory") {
    const source = readFileSync(path.join(root, "scripts/verify.mjs"), "utf8");
    const entries = source.match(/const scenarioDefinitionKeys = Object.freeze\(\{([\s\S]*?)\}\);/)?.[1];
    if (!entries) throw new Error("scenario inventory declaration changed");
    console.log([...entries.matchAll(/^\s*(?:"([^"]+)"|(\w+)):/gm)].map((match) => `scenario:${match[1] ?? match[2]}`).sort().join("\n"));
    return;
  }
  if (command === "launch") {
    if (existsSync(stateDir)) throw new Error(`run already exists. Run ${helper} clean first`);
    if ((process.env.VERIFY_TARGET ?? target) !== target) throw new Error("undeclared VERIFY_TARGET");
    const source = await checkoutFingerprint(root);
    const runDir = path.join(root, ".verify/runs", `${uniqueRunId()}-${source.head.slice(0, 7)}${source.dirty ? "-dirty" : ""}`);
    for (const dir of [runDir, stateDir, ...["home", "tmp", "tripwire", "profile"].map((name) => path.join(stateDir, name))]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(stateDir, "tripwire.log"), "");
    const logPath = `'${path.join(stateDir, "tripwire.log").replaceAll("'", "'\\''")}'`;
    for (const name of tripwires) writeFileSync(path.join(stateDir, "tripwire", name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> ${logPath}\nexit 97\n`, { mode: 0o755 });
    // -d and -f prevent login startup files from replacing the isolated PATH.
    writeFileSync(path.join(stateDir, "shell"), '#!/bin/sh\nexec /bin/zsh -df "$@"\n', { mode: 0o755 });
    const state = { stateDir, runDir, source, ready: false, cargoHome: process.env.CARGO_HOME ?? path.join(homedir(), ".cargo"), rustupHome: process.env.RUSTUP_HOME ?? path.join(homedir(), ".rustup") };
    save(state);
    const probe = await child(state, ["/bin/sh", "-c", 'command -v launchctl security defaults; test "$ARGMAX_VERIFICATION" = 1 && test "$HOME" = "$ARGMAX_VERIFICATION_HOME"'], "isolation.log");
    if (probe !== 0) throw new Error("isolation probe failed");
    const code = await child(state, [process.execPath, worker, "build", runDir], "launch.log");
    if (code !== 0) throw new Error(`launch failed. Evidence: ${runDir}`);
    allow(state);
    state.ready = true;
    save(state);
    await doctor(state);
    return;
  }
  if (command === "ui") return screenshotUi(args);
  const state = load();
  if (command === "clean") {
    ownership(state);
    if (state.commandPid) throw new Error(`command ${state.commandPid} may still be running. Interrupt its owning helper and wait before cleanup`);
    const tripwire = readFileSync(path.join(stateDir, "tripwire.log"), "utf8");
    writeFileSync(path.join(state.runDir, "tripwire.txt"), tripwire || "empty\n");
    const code = await child(state, [process.execPath, worker, "cleanup-check", state.runDir], "cleanup.log", true);
    if (code !== 0) throw new Error("cleanup check failed. State retained for diagnosis");
    rmSync(stateDir, { recursive: true });
    console.log(`CLEAN evidence=${state.runDir}`);
    return;
  }
  allow(state);
  if (command === "doctor") return doctor(state);
  if (command === "exec") {
    if (args.shift() !== "--" || !args.length) throw new Error("exec requires -- <command> [args]");
    const code = await child(state, args, `exec-${Date.now()}.log`);
    allow(state);
    process.exitCode = code;
    console.log(`exit=${code} evidence=${state.runDir}`);
    return;
  }
  if (command === "reset") {
    await doctor(state);
    state.retryReady = true;
    save(state);
    console.log("RESET: each drive starts a fresh disposable app, project, and profile");
    return;
  }
  if (command !== "drive" && command !== "control") throw new Error("expected launch, doctor, reset, drive, control, clean, exec, or inventory");
  const feature = command === "control" ? "provider-error" : args[0];
  if (!features.includes(feature)) throw new Error(`drive requires one of: ${features.join(", ")}`);
  const failures = state.failures?.[feature] ?? 0;
  if (command === "drive" && failures && (!state.retryReady || failures > 1)) throw new Error("failed drive requires doctor and reset before its single retry");
  await doctor(state);
  const started = new Date().toISOString();
  const outputDir = path.join(state.runDir, `${command}-${feature}-${Date.now()}`);
  const argv = [process.execPath, worker, command, feature, outputDir];
  const code = await child(state, argv, `${path.basename(outputDir)}.log`);
  const verdictFile = path.join(outputDir, "verdict.json");
  const verdict = existsSync(verdictFile) ? JSON.parse(readFileSync(verdictFile, "utf8")) : { result: "fail" };
  if (command === "drive") {
    if (verdict.result === "pass" && failures) verdict.result = "flaky";
    if (verdict.result === "fail") state.failures = { ...state.failures, [feature]: failures + 1 };
    state.retryReady = false;
    save(state);
  }
  const replay = `node .agents/skills/verify-argmax/drives.mjs ${command} ${feature}`;
  manifest(state, { feature: command === "control" ? `control:${feature}` : feature, entry: `scenario:${feature}`, command: `${helper} exec -- ${replay}`, exit: code, result: verdict.result, started, evidence: outputDir });
  allow(state);
  console.log(`${verdict.result.toUpperCase()} evidence=${outputDir}`);
  process.exitCode = verdict.result === "fail-observed" && code === 1 ? 0 : code;
}
async function exclusiveCommand() {
  if (process.argv[2] === "inventory") return main();
  const lockDir = path.join(root, ".verify/command.lock");
  mkdirSync(path.dirname(lockDir), { recursive: true });
  try { mkdirSync(lockDir); } catch (error) {
    if (error.code === "EEXIST") throw new Error("another verification command owns .verify/command.lock. Wait for it to finish");
    throw error;
  }
  try {
    writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, command: process.argv.slice(2), started: new Date().toISOString() }));
    await main();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
await exclusiveCommand().catch((error) => { console.error(`verify-argmax: ${sanitize(error.message)}`); process.exitCode = 1; });
