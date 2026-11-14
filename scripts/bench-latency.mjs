#!/usr/bin/env node
// Latency bench: drives the real WKWebView of a verification release build over
// its embedded WebDriver, on an isolated copy of a real profile, and writes one
// JSON result. Method, metrics and targets: docs/plan/latency.md.
//
//   npm run bench:latency -- [--build] [--source <data-dir>] [--n 8]
//        [--only boot,navigation,send] [--scenarios session.switch,palette]
//        [--project <name>] [--out <file.json>] [--keep]
//
// --source defaults to the installed app's profile, read through `VACUUM INTO`
// (read-only). Every stored repo, workspace and provider path in the copy is
// rewritten to `git clone --shared` fixtures under the bench root, so the bench
// instance never touches a live checkout. Schedules and PR watches are switched
// off, HOME is a temp directory, and Claude runs as the scripted fixture.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(repoRoot, "scripts", "bench-latency");
const benchRoot = path.join(repoRoot, ".verify", "bench");
const targetDir = path.join(repoRoot, "src-tauri", "target", "verification");
const binary = path.join(targetDir, "release", "argmax");
const fixture = path.join(repoRoot, "scripts", "verification", "provider-fixture.mjs");
const home = os.homedir();
const realProfile = path.join(home, "Library", "Application Support", "com.argmax.rs");

function parseArgs(argv) {
  const options = { build: false, source: realProfile, n: 8, only: null, scenarios: null, out: null, keep: false, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) fail(`${arg} requires a value`);
      return next;
    };
    if (arg === "--build") options.build = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--source") options.source = path.resolve(value());
    else if (arg === "--n") options.n = Number(value());
    else if (arg === "--only") options.only = value().split(",");
    else if (arg === "--scenarios") options.scenarios = value().split(",");
    else if (arg === "--out") options.out = path.resolve(value());
    else if (arg === "--project") options.project = value();
    else fail(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.n) || options.n < 1) fail("--n must be a positive integer");
  return options;
}

function fail(message) {
  process.stderr.write(`bench-latency: ${message}\n`);
  process.exit(1);
}

const sql = async (db, statement) => (await run("sqlite3", [db, statement], { maxBuffer: 64 << 20 })).stdout;
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
const sha = async () => (await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
const dirty = async () => (await run("git", ["status", "--porcelain"], { cwd: repoRoot })).stdout.trim() !== "";

async function build() {
  await runInherit("npm", ["run", "build:renderer"]);
  await runInherit("cargo", [
    "build", "--release", "--manifest-path", "src-tauri/Cargo.toml",
    "--target-dir", targetDir, "--features", "custom-protocol,verification",
  ]);
}

function runInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });
}

// One pristine, path-rewritten profile per source database. Clones are reused.
async function prepareProfile(source) {
  const sourceDb = path.join(source, "local-state", "argmax.sqlite");
  if (!existsSync(sourceDb)) fail(`no database at ${sourceDb}`);
  const fixtures = path.join(benchRoot, "repos");
  const pristine = path.join(benchRoot, "pristine.sqlite");
  mkdirSync(fixtures, { recursive: true });
  rmSync(pristine, { force: true });
  await run("sqlite3", [`file:${sourceDb}?mode=ro`, `VACUUM INTO ${quote(pristine)}`]);

  const liveRepos = (await sql(pristine, "SELECT DISTINCT path FROM workspaces WHERE state != 'archived' UNION SELECT repo_path FROM projects"))
    .split("\n").filter(Boolean);
  for (const repo of liveRepos) {
    if (!repo.startsWith(home + "/")) continue;
    const destination = path.join(fixtures, path.relative(home, repo));
    if (existsSync(path.join(destination, ".git"))) continue;
    let origin = repo;
    try {
      origin = (await run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim().replace(/\/\.git$/, "");
    } catch {
      continue; // A workspace whose checkout is gone stays missing, as in the real app.
    }
    const branch = (await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    mkdirSync(path.dirname(destination), { recursive: true });
    await run("git", ["clone", "-q", "--shared", "--branch", branch, origin, destination]);
    await run("git", ["-C", destination, "remote", "set-url", "--push", "origin", "/nonexistent-bench-push"]);
  }

  const from = quote(home + "/");
  const to = quote(fixtures + "/");
  await sql(pristine, `
    UPDATE projects SET repo_path = replace(repo_path, ${from}, ${to}), worktree_location = replace(worktree_location, ${from}, ${to});
    UPDATE project_folders SET root_path = replace(root_path, ${from}, ${to}), worktree_location = replace(worktree_location, ${from}, ${to});
    UPDATE workspaces SET path = replace(path, ${from}, ${to});
    UPDATE provider_bindings SET working_dir = replace(working_dir, ${from}, ${to});
    UPDATE routines SET enabled = 0;
    DELETE FROM pr_watches;
    DELETE FROM session_after_turn;`);
  // Fail closed: any stored path outside the fixture root, under HOME or not, could be a live checkout.
  const live = (column) => `(coalesce(${column}, '') != '' AND ${column} NOT LIKE ${quote(fixtures + "/%")})`;
  const leaks = await sql(pristine, `SELECT
    (SELECT count(*) FROM workspaces WHERE ${live("path")}) +
    (SELECT count(*) FROM projects WHERE ${live("repo_path")} OR ${live("worktree_location")}) +
    (SELECT count(*) FROM project_folders WHERE ${live("root_path")} OR ${live("worktree_location")}) +
    (SELECT count(*) FROM provider_bindings WHERE ${live("working_dir")})`);
  if (leaks.trim() !== "0") fail(`profile still points at ${leaks.trim()} live paths; refusing to launch`);
  return { pristine, source };
}

// Fresh data dir from the pristine copy (APFS clone), so every launch starts equal.
function freshDataDir(pristine, source) {
  const dataDir = path.join(benchRoot, "profile");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(path.join(dataDir, "local-state"), { recursive: true });
  cpSync(pristine, path.join(dataDir, "local-state", "argmax.sqlite"));
  // Claude is the only provider replaced by the scripted fixture; any other default would start a real CLI.
  writeFileSync(path.join(dataDir, "default-agent.json"), `${JSON.stringify({
    provider: "claude",
    modelLabel: "Opus 5.5",
    modelId: "claude-opus-5-5",
    reasoningEffort: "medium",
    permissionMode: "provider-defaults",
  })}\n`);
  for (const file of ["theme.json", "sync.json"]) {
    if (existsSync(path.join(source, file))) cpSync(path.join(source, file), path.join(dataDir, file));
  }
  const attachments = path.join(source, "local-state", "attachments");
  if (existsSync(attachments)) cpSync(attachments, path.join(dataDir, "local-state", "attachments"), { recursive: true });
  return dataDir;
}

// A raw executable has no app identity and can lose activation; wrap it like verify.mjs does.
function appBundle() {
  const contents = path.join(benchRoot, "Argmax Bench.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources"), { recursive: true });
  cpSync(path.join(repoRoot, "assets", "browser-blocking"), path.join(contents, "Resources", "browser-blocking"), { recursive: true });
  cpSync(binary, path.join(contents, "MacOS", "argmax"));
  writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>argmax</string>
<key>CFBundleIdentifier</key><string>com.argmax.bench</string>
<key>CFBundleName</key><string>Argmax Bench</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`);
  return path.join(contents, "MacOS", "argmax");
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

function benchEnv(dataDir, port) {
  const benchHome = path.join(benchRoot, "home");
  const control = path.join(benchRoot, "control");
  for (const dir of [".config", ".local/share", ".cache", ".local/state", ".claude", ".codex", ".cursor", ".grok"]) {
    mkdirSync(path.join(benchHome, dir), { recursive: true });
  }
  mkdirSync(control, { recursive: true });
  // The fixture parks at each barrier until its .continue file exists.
  for (const barrier of ["chat-resume-stream", "chat-resume-tool", "fork-source-hold", "session-move-scheduled"]) {
    writeFileSync(path.join(control, `${barrier}.continue`), "");
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: benchHome,
    XDG_CONFIG_HOME: path.join(benchHome, ".config"),
    XDG_DATA_HOME: path.join(benchHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(benchHome, ".cache"),
    XDG_STATE_HOME: path.join(benchHome, ".local", "state"),
    CLAUDE_CONFIG_DIR: path.join(benchHome, ".claude"),
    CODEX_HOME: path.join(benchHome, ".codex"),
    CURSOR_CONFIG_DIR: path.join(benchHome, ".cursor"),
    GROK_HOME: path.join(benchHome, ".grok"),
    ARGMAX_VERIFICATION: "1",
    ARGMAX_VERIFICATION_HOME: benchHome,
    ARGMAX_VERIFICATION_CLAUDE_BINARY: fixture,
    ARGMAX_VERIFICATION_CONTROL_DIR: control,
    ARGMAX_VERIFICATION_LOG: path.join(control, "invocations.jsonl"),
    ARGMAX_DATA_DIR: dataDir,
    TAURI_WEBDRIVER_PORT: String(port),
  };
}

async function launch(executable, env, port) {
  const logPath = path.join(benchRoot, "app.log");
  const log = [];
  const child = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => log.push(chunk));
  child.stderr.on("data", (chunk) => log.push(chunk));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`app exited ${child.exitCode} during start; see ${logPath}`);
    try {
      const status = await (await fetch(`${base}/status`)).json();
      if (status.value?.ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const created = await wd(base, "POST", "/session", { capabilities: { alwaysMatch: {} } });
  const session = created.sessionId;
  await wd(base, "POST", `/session/${session}/timeouts`, { script: 900_000 });
  return {
    child,
    logText: () => Buffer.concat(log).toString("utf8"),
    async page(script, arg = null) {
      const body = readFileSync(path.join(pageDir, script), "utf8");
      const wrapped = `const arg = arguments[0]; const done = arguments[arguments.length - 1];
(async () => { ${body} })().then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: String(e && e.stack || e) }));`;
      // WebDriver can attach before the app document replaces the initial one;
      // a script started in that window loses its completion handler.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const out = await wd(base, "POST", `/session/${session}/execute/async`, { script: wrapped, args: [arg] });
          if (!out?.ok) throw new Error(`${script}: ${out?.e}`);
          return out.v;
        } catch (error) {
          if (attempt >= 3 || !/no longer reachable/.test(String(error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    },
    async close() {
      writeFileSync(logPath, Buffer.concat(log));
      child.kill("SIGTERM");
      await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    },
  };
}

async function wd(base, method, url, body) {
  const response = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(900_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${url} ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.value;
}

function bootFromLog(text, renderer) {
  let bootEpoch = null;
  let readyToShow = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const fields = entry.fields ?? {};
    if (fields.message === "tracing online") bootEpoch = Date.parse(entry.timestamp) - fields.boot_ms;
    if (fields.message === "window ready-to-show") readyToShow = fields.ready_to_show_ms;
  }
  if (bootEpoch == null) return { readyToShow };
  return {
    readyToShow,
    webviewStart: Math.round(renderer.timeOrigin - bootEpoch),
    firstPaint: Math.round(renderer.timeOrigin + renderer.firstPaint - bootEpoch),
  };
}

async function machineState() {
  const read = async (command, args) => (await run(command, args).catch(() => ({ stdout: "" }))).stdout.trim();
  return {
    host: os.hostname(),
    cpus: os.cpus().length,
    loadavg: os.loadavg().map((value) => +value.toFixed(2)),
    power: (await read("pmset", ["-g", "batt"])).split("\n")[0],
    thermal: (await read("pmset", ["-g", "therm"])).replace(/\s+/g, " ").slice(0, 200),
    otherArgmax: (await read("pgrep", ["-fl", "Argmax.app/Contents/MacOS"])).split("\n").filter(Boolean).length,
  };
}

const percentile = (values, fraction) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : null;
};

function printTable(result) {
  const rows = [];
  if (result.boot) {
    const boot = result.boot;
    rows.push(["boot.ready-to-show", boot.length, percentile(boot.map((b) => b.readyToShow), 0.5), percentile(boot.map((b) => b.readyToShow), 0.95)]);
    rows.push(["boot.first-paint", boot.length, percentile(boot.map((b) => b.firstPaint), 0.5), percentile(boot.map((b) => b.firstPaint), 0.95)]);
  }
  for (const scenario of result.navigation ?? []) {
    if (scenario.error) rows.push([scenario.name, "ERR", scenario.error.slice(0, 60)]);
    else rows.push([scenario.name, scenario.n, scenario.shown_p50, scenario.shown_p95, scenario.painted_p50, scenario.painted_p95, scenario.settled_p50, scenario.settled_p95, scenario.maxGap_p95, scenario.ipc_avg]);
  }
  for (const kind of ["newChat", "followUp"]) {
    const runs = result.send?.[kind] ?? [];
    if (!runs.length) continue;
    rows.push([`send.${kind}.ack`, runs.length, percentile(runs.map((r) => r.ack), 0.5), percentile(runs.map((r) => r.ack), 0.95)]);
    rows.push([`send.${kind}.first-text`, runs.length, percentile(runs.map((r) => r.firstText), 0.5), percentile(runs.map((r) => r.firstText), 0.95)]);
  }
  const waterfalls = (result.appPerf?.turnWaterfalls ?? []).filter((row) => row.provider === "claude");
  if (waterfalls.length) {
    const steps = new Map();
    for (const row of waterfalls) for (const stamp of row.stamps) (steps.get(stamp.name) ?? steps.set(stamp.name, []).get(stamp.name)).push(stamp.offsetMs);
    for (const [name, offsets] of steps) rows.push([`turn.${name}`, offsets.length, Math.round(percentile(offsets, 0.5)), Math.round(percentile(offsets, 0.95))]);
  }
  const header = ["metric", "n", "shown50", "shown95", "paint50", "paint95", "settl50", "settl95", "gap95", "ipc"];
  process.stdout.write(`${header.map((h, i) => (i ? h.padStart(8) : h.padEnd(40))).join("")}\n`);
  for (const row of rows) {
    process.stdout.write(`${row.map((cell, i) => (i ? String(cell ?? "").padStart(8) : String(cell).padEnd(40))).join("")}\n`);
  }
}

async function main() {
  if (process.platform !== "darwin") fail("the bench drives the macOS WKWebView build only");
  const options = parseArgs(process.argv.slice(2));
  const want = (part) => !options.only || options.only.includes(part);
  mkdirSync(benchRoot, { recursive: true });
  if (options.build) await build();
  if (!existsSync(binary)) fail(`no verification build at ${binary}; pass --build`);

  const { pristine, source } = await prepareProfile(options.source);
  const executable = appBundle();
  const result = {
    commit: await sha(),
    dirty: await dirty(),
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    binaryBuilt: statSync(binary).mtime.toISOString(),
    startedAt: new Date().toISOString(),
    n: options.n,
    machine: await machineState(),
  };

  // The first launch migrates the copy; boot is measured on the relaunches.
  const warmPort = await freePort();
  const warm = await launch(executable, benchEnv(freshDataDir(pristine, source), warmPort), warmPort);
  await warm.close();

  if (want("boot")) {
    result.boot = [];
    for (let i = 0; i < Math.max(5, Math.ceil(options.n / 2)); i += 1) {
      const port = await freePort();
      const app = await launch(executable, benchEnv(path.join(benchRoot, "profile"), port), port);
      const renderer = await app.page("boot.js");
      result.boot.push(bootFromLog(app.logText(), renderer));
      await app.close();
    }
  }

  if (want("navigation") || want("send")) {
    const port = await freePort();
    const app = await launch(executable, benchEnv(path.join(benchRoot, "profile"), port), port);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await app.page("probe.js");
      if (want("navigation")) {
        const longest = (await sql(path.join(benchRoot, "profile", "local-state", "argmax.sqlite"),
          "SELECT w.task_label FROM events e JOIN sessions s ON s.id = e.session_id JOIN workspaces w ON w.id = s.workspace_id WHERE w.state != 'archived' GROUP BY s.id ORDER BY count(*) DESC LIMIT 1")).trim();
        result.navigation = await app.page("navigation.js", { n: options.n, only: options.scenarios, longTitle: longest || null });
      }
      if (want("send")) result.send = await app.page("send.js", { n: Math.min(options.n, 5), project: options.project });
      result.appPerf = await app.page("app-perf.js").catch(() => null);
    } finally {
      await app.close();
    }
  }

  result.finishedAt = new Date().toISOString();
  const out = options.out ?? path.join(benchRoot, `${result.startedAt.replace(/[:.]/g, "-")}-${result.commit.slice(0, 7)}.json`);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  printTable(result);
  process.stdout.write(`\nresult: ${out}\n`);
  if (!options.keep) rmSync(path.join(benchRoot, "profile"), { recursive: true, force: true });
}

main().catch((error) => fail(error.stack ?? String(error)));
