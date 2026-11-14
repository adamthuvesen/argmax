#!/usr/bin/env node
// Latency bench: drives the real WKWebView of a verification release build over
// its embedded WebDriver, on an isolated copy of a real profile, and writes one
// JSON result per run. Method: docs/performance.md#latency-bench. Targets:
// scripts/bench-latency/targets.json. Ratchet record: scripts/bench-latency/record.json.
//
//   npm run bench:latency -- [--build] [--binary <path>] [--label <name>]
//        [--source <data-dir>] [--n 8] [--only boot,navigation,send,real]
//        [--scenarios session.switch,palette] [--project <name>] [--out <file.json>] [--keep]
//        [--real claude] [--model <claude model id>]
//        [--check [result.json ...]] [--update-record [result.json ...]] [--loosen <metric>[,<metric>]]
//   npm run bench:latency -- --compare <binA> <binB> [--rounds 2] [run flags]
//   npm run bench:latency -- --diff <a.json> [<a2.json> ...] -- <b.json> [<b2.json> ...]
//
// --compare runs A,B,A,B... with the same flags and prints per-round values, so
// noise stays visible. --diff prints the same table from saved results.
// --check fails when a p50 regresses past the record; --update-record ratchets it.
// With result files, --check and --update-record read them and launch nothing.
// --real claude adds the `real` part: one app launch per round, each with a new
// chat and a follow-up on the real Claude CLI and the user's own login.
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
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkRecord,
  loadRecord,
  metricsOf,
  pool,
  printCompare,
  printScoreboard,
  printTable,
  realOffsets,
  recordPath,
  updateRecord,
} from "./bench-latency/report.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pageDir = path.join(repoRoot, "scripts", "bench-latency");
const benchRoot = path.join(repoRoot, ".verify", "bench");
const targetDir = path.join(repoRoot, "src-tauri", "target", "verification");
const defaultBinary = path.join(targetDir, "release", "argmax");
const fixture = path.join(repoRoot, "scripts", "verification", "provider-fixture.mjs");
const home = os.homedir();
const realProfile = path.join(home, "Library", "Application Support", "com.argmax.rs");

const parts = ["boot", "navigation", "send", "real"];

function parseArgs(argv) {
  const options = {
    build: false,
    source: realProfile,
    n: 8,
    only: null,
    scenarios: null,
    out: null,
    keep: false,
    project: null,
    binary: defaultBinary,
    label: null,
    compare: null,
    rounds: 2,
    diff: null,
    real: null,
    model: null,
    check: null,
    updateRecord: null,
    loosen: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) fail(`${arg} requires a value`);
      return next;
    };
    // Values up to the next argument that starts with `--`, a bare `--` included.
    const list = () => {
      const values = [];
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) values.push(argv[++i]);
      return values;
    };
    if (arg === "--build") options.build = true;
    else if (arg === "--binary") options.binary = path.resolve(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--compare") {
      options.compare = list().map((file) => path.resolve(file));
      if (options.compare.length !== 2) fail("usage: --compare <binA> <binB>");
    } else if (arg === "--rounds") options.rounds = Number(value());
    else if (arg === "--diff") {
      const a = list();
      if (argv[i + 1] !== "--") fail("usage: --diff <a.json> [...] -- <b.json> [...]");
      i += 1;
      const b = list();
      if (!a.length || !b.length) fail("usage: --diff <a.json> [...] -- <b.json> [...]");
      options.diff = { a, b };
    } else if (arg === "--real") {
      options.real = value();
      if (options.real !== "claude") fail("--real supports only: claude");
    } else if (arg === "--model") options.model = value();
    else if (arg === "--check") options.check = list();
    else if (arg === "--update-record") options.updateRecord = list();
    else if (arg === "--loosen") options.loosen.push(...value().split(","));
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
  if (!Number.isInteger(options.rounds) || options.rounds < 1)
    fail("--rounds must be a positive integer");
  for (const part of options.only ?? [])
    if (!parts.includes(part)) fail(`--only: unknown part ${part} (parts: ${parts.join(", ")})`);
  if (options.only?.includes("real") && !options.real) fail("--only real needs --real claude");
  if (options.compare && options.diff) fail("--compare and --diff do not combine");
  if (options.compare && (options.out || options.label))
    fail("--compare names its own outputs; drop --out and --label");
  if (options.build && (options.compare || options.binary !== defaultBinary))
    fail("--build builds only the default binary; build the others first");
  if (options.loosen.length && !options.updateRecord) fail("--loosen needs --update-record");
  const saved = (options.check?.length ?? 0) + (options.updateRecord?.length ?? 0);
  if (saved && (options.compare || options.diff))
    fail("--check/--update-record with result files do not combine with --compare or --diff");
  if (
    options.check?.length &&
    options.updateRecord?.length &&
    options.check.join() !== options.updateRecord.join()
  ) {
    fail("--check and --update-record read different result files");
  }
  return options;
}

function fail(message) {
  process.stderr.write(`bench-latency: ${message}\n`);
  process.exit(1);
}

const sql = async (db, statement) =>
  (await run("sqlite3", [db, statement], { maxBuffer: 64 << 20 })).stdout;
const quote = (text) => `'${text.replaceAll("'", "''")}'`;
const sha = async () => (await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
const dirty = async () =>
  (await run("git", ["status", "--porcelain"], { cwd: repoRoot })).stdout.trim() !== "";

async function build() {
  await runInherit("npm", ["run", "build:renderer"]);
  await runInherit("cargo", [
    "build",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--target-dir",
    targetDir,
    "--features",
    "custom-protocol,verification",
  ]);
}

function runInherit(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
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

  const liveRepos = (
    await sql(
      pristine,
      "SELECT DISTINCT path FROM workspaces WHERE state != 'archived' UNION SELECT repo_path FROM projects",
    )
  )
    .split("\n")
    .filter(Boolean);
  for (const repo of liveRepos) {
    if (!repo.startsWith(home + "/")) continue;
    const destination = path.join(fixtures, path.relative(home, repo));
    if (existsSync(path.join(destination, ".git"))) continue;
    let origin = repo;
    try {
      origin = (
        await run("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])
      ).stdout
        .trim()
        .replace(/\/\.git$/, "");
    } catch {
      continue; // A workspace whose checkout is gone stays missing, as in the real app.
    }
    const branch = (
      await run("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim();
    mkdirSync(path.dirname(destination), { recursive: true });
    await run("git", ["clone", "-q", "--shared", "--branch", branch, origin, destination]);
    await run("git", [
      "-C",
      destination,
      "remote",
      "set-url",
      "--push",
      "origin",
      "/nonexistent-bench-push",
    ]);
  }

  const from = quote(home + "/");
  const to = quote(fixtures + "/");
  await sql(
    pristine,
    `
    UPDATE projects SET repo_path = replace(repo_path, ${from}, ${to}), worktree_location = replace(worktree_location, ${from}, ${to});
    UPDATE project_folders SET root_path = replace(root_path, ${from}, ${to}), worktree_location = replace(worktree_location, ${from}, ${to});
    UPDATE workspaces SET path = replace(path, ${from}, ${to});
    UPDATE provider_bindings SET working_dir = replace(working_dir, ${from}, ${to});
    UPDATE routines SET enabled = 0;
    DELETE FROM pr_watches;
    DELETE FROM session_after_turn;`,
  );
  // Fail closed: any stored path outside the fixture root, under HOME or not, could be a live checkout.
  const live = (column) =>
    `(coalesce(${column}, '') != '' AND ${column} NOT LIKE ${quote(fixtures + "/%")})`;
  const leaks = await sql(
    pristine,
    `SELECT
    (SELECT count(*) FROM workspaces WHERE ${live("path")}) +
    (SELECT count(*) FROM projects WHERE ${live("repo_path")} OR ${live("worktree_location")}) +
    (SELECT count(*) FROM project_folders WHERE ${live("root_path")} OR ${live("worktree_location")}) +
    (SELECT count(*) FROM provider_bindings WHERE ${live("working_dir")})`,
  );
  if (leaks.trim() !== "0")
    fail(`profile still points at ${leaks.trim()} live paths; refusing to launch`);
  return { pristine, source };
}

// Fresh data dir from the pristine copy (APFS clone), so every launch starts equal.
function freshDataDir(pristine, source, agent) {
  const dataDir = path.join(benchRoot, "profile");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(path.join(dataDir, "local-state"), { recursive: true });
  cpSync(pristine, path.join(dataDir, "local-state", "argmax.sqlite"));
  // Claude is the only provider replaced by the scripted fixture; any other default would start a real CLI.
  writeFileSync(
    path.join(dataDir, "default-agent.json"),
    `${JSON.stringify({
      provider: "claude",
      modelLabel: agent?.label ?? "Opus 5.5",
      modelId: agent?.id ?? "claude-opus-5-5",
      reasoningEffort: agent ? "low" : "medium",
      permissionMode: "provider-defaults",
    })}\n`,
  );
  for (const file of ["theme.json", "sync.json"]) {
    if (existsSync(path.join(source, file)))
      cpSync(path.join(source, file), path.join(dataDir, file));
  }
  const attachments = path.join(source, "local-state", "attachments");
  if (existsSync(attachments))
    cpSync(attachments, path.join(dataDir, "local-state", "attachments"), { recursive: true });
  return dataDir;
}

// A raw executable has no app identity and can lose activation; wrap it like verify.mjs does.
function appBundle(binary) {
  const contents = path.join(benchRoot, "Argmax Bench.app", "Contents");
  mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  mkdirSync(path.join(contents, "Resources"), { recursive: true });
  cpSync(
    path.join(repoRoot, "assets", "browser-blocking"),
    path.join(contents, "Resources", "browser-blocking"),
    { recursive: true },
  );
  cpSync(binary, path.join(contents, "MacOS", "argmax"));
  writeFileSync(
    path.join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>argmax</string>
<key>CFBundleIdentifier</key><string>com.argmax.bench</string>
<key>CFBundleName</key><string>Argmax Bench</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
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

function benchEnv(dataDir, port, claudeBinary = fixture) {
  const benchHome = path.join(benchRoot, "home");
  const control = path.join(benchRoot, "control");
  for (const dir of [
    ".config",
    ".local/share",
    ".cache",
    ".local/state",
    ".claude",
    ".codex",
    ".cursor",
    ".grok",
  ]) {
    mkdirSync(path.join(benchHome, dir), { recursive: true });
  }
  mkdirSync(control, { recursive: true });
  // The fixture parks at each barrier until its .continue file exists.
  for (const barrier of [
    "chat-resume-stream",
    "chat-resume-tool",
    "fork-source-hold",
    "session-move-scheduled",
  ]) {
    writeFileSync(path.join(control, `${barrier}.continue`), "");
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION|COOKIE|CREDENTIAL)/i.test(key))
      env[key] = value;
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
    ARGMAX_VERIFICATION_CLAUDE_BINARY: claudeBinary,
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
(async () => { ${body} })().then((v) => done({ ok: true, v }), (e) => done({ ok: false, e: e instanceof Error ? e.name + ": " + e.message + " | " + e.stack : String(e) }));`;
      // WebDriver can attach before the app document replaces the initial one;
      // a script started in that window loses its completion handler.
      for (let attempt = 0; ; attempt += 1) {
        try {
          const out = await wd(base, "POST", `/session/${session}/execute/async`, {
            script: wrapped,
            args: [arg],
          });
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
      await new Promise((resolve) =>
        child.exitCode !== null ? resolve() : child.once("exit", resolve),
      );
    },
  };
}

// node:http, not fetch: fetch gives up on a response whose headers take over
// 300 s, and one navigation pass at --n 12 runs longer than that.
function wd(base, method, url, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      base + url,
      {
        method,
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(900_000),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* non-JSON error body */
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `${method} ${url} ${response.statusCode} ${JSON.stringify(json).slice(0, 300)}`,
              ),
            );
          } else resolve(json.value);
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
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
    if (fields.message === "tracing online")
      bootEpoch = Date.parse(entry.timestamp) - fields.boot_ms;
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
  const read = async (command, args) =>
    (await run(command, args).catch(() => ({ stdout: "" }))).stdout.trim();
  return {
    host: os.hostname(),
    cpus: os.cpus().length,
    loadavg: os.loadavg().map((value) => +value.toFixed(2)),
    power: (await read("pmset", ["-g", "batt"])).split("\n")[0],
    thermal: (await read("pmset", ["-g", "therm"])).replace(/\s+/g, " ").slice(0, 200),
    otherArgmax: (await read("pgrep", ["-fl", "Argmax.app/Contents/MacOS"]))
      .split("\n")
      .filter(Boolean).length,
  };
}

// The cheap, fast Claude model for real turns, read from the shared catalogue
// so the bench does not keep a second copy of the id.
function realModel(requested) {
  const catalogue = readFileSync(path.join(repoRoot, "src", "shared", "providerModels.ts"), "utf8");
  const entries = [...catalogue.matchAll(/label:\s*"([^"]+)",\s*modelId:\s*"(claude-[^"]+)"/g)].map(
    ([, label, id]) => ({ label, id }),
  );
  if (requested)
    return entries.find((entry) => entry.id === requested) ?? { label: requested, id: requested };
  const haiku = entries.find((entry) => /^Haiku/.test(entry.label));
  if (!haiku) fail("no Haiku model in src/shared/providerModels.ts; pass --model");
  return haiku;
}

// The verification build drops CLAUDE_CONFIG_DIR from the provider env and the
// bench HOME is a temp dir, so the real CLI starts through a wrapper that puts
// the user's HOME and ~/.claude back.
async function realClaudeWrapper() {
  const real = (
    await run("/bin/sh", ["-c", "command -v claude"]).catch(() => ({ stdout: "" }))
  ).stdout.trim();
  if (!real) fail("--real claude: no `claude` on PATH");
  const wrapper = path.join(benchRoot, "real-claude.sh");
  const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexport HOME=${shellQuote(home)} CLAUDE_CONFIG_DIR=${shellQuote(path.join(home, ".claude"))}\nexec ${shellQuote(real)} "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

async function runOnce(options, prepared, binary, label, out) {
  const want = (part) =>
    part === "real"
      ? !!options.real && (!options.only || options.only.includes("real"))
      : !options.only || options.only.includes(part);
  const { pristine, source } = prepared;
  const executable = appBundle(binary);
  const result = {
    label,
    binary,
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
  const warm = await launch(
    executable,
    benchEnv(freshDataDir(pristine, source, options.realAgent), warmPort),
    warmPort,
  );
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
        const longest = (
          await sql(
            path.join(benchRoot, "profile", "local-state", "argmax.sqlite"),
            "SELECT w.task_label FROM events e JOIN sessions s ON s.id = e.session_id JOIN workspaces w ON w.id = s.workspace_id WHERE w.state != 'archived' GROUP BY s.id ORDER BY count(*) DESC LIMIT 1",
          )
        ).trim();
        result.navigation = await app.page("navigation.js", {
          n: options.n,
          only: options.scenarios,
          longTitle: longest || null,
        });
      }
      if (want("send"))
        result.send = await app.page("send.js", {
          n: Math.min(options.n, 5),
          project: options.project,
        });
      result.appPerf = await app.page("app-perf.js").catch(() => null);
    } finally {
      await app.close();
    }
  }

  // One launch per turn pair keeps each WebDriver request short.
  if (want("real")) {
    result.realModel = options.realAgent.id;
    result.real = [];
    for (let i = 0; i < Math.min(options.n, 5); i += 1) {
      const port = await freePort();
      const app = await launch(
        executable,
        benchEnv(path.join(benchRoot, "profile"), port, options.realWrapper),
        port,
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        const pair = await app.page("real.js", { project: options.project });
        result.real.push({
          newChat: realOffsets(pair.newChat),
          followUp: realOffsets(pair.followUp),
          rows: pair,
        });
      } finally {
        await app.close();
      }
    }
  }

  result.finishedAt = new Date().toISOString();
  const file =
    out ??
    path.join(
      benchRoot,
      `${result.startedAt.replace(/[:.]/g, "-")}-${result.commit.slice(0, 7)}${label ? `-${label}` : ""}.json`,
    );
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  if (!options.keep) rmSync(path.join(benchRoot, "profile"), { recursive: true, force: true });
  return { result, file };
}

function readResult(file) {
  let text;
  try {
    text = readFileSync(path.resolve(file), "utf8");
  } catch {
    fail(`cannot read result ${file}`);
  }
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    fail(`${file} is not JSON`);
  }
  result.label ??= path.basename(file, ".json");
  return result;
}

// Ratchet against scripts/bench-latency/record.json. Several results pool into one set of p50s.
function ratchet(options, results) {
  const ids = [...new Set(results.flatMap((result) => [...metricsOf(result).keys()]))];
  const pooled = new Map(
    ids.map((id) => [id, pool(results.map((result) => metricsOf(result).get(id)))]),
  );
  const record = loadRecord();
  const machine = {
    // The record is committed, so it names the machine by a hash, not its hostname.
    host: results[0].machine?.host
      ? createHash("sha256").update(results[0].machine.host).digest("hex").slice(0, 12)
      : null,
    cpus: results[0].machine?.cpus ?? null,
  };
  if (record.machine?.host && machine.host && record.machine.host !== machine.host) {
    process.stderr.write(
      `bench-latency: record was taken on another machine (${record.machine.host}, this one is ${machine.host})\n`,
    );
  }
  if (options.check) {
    const regressions = checkRecord(pooled, record);
    const compared = Object.keys(record.metrics).filter((id) => pooled.get(id)?.p50 != null).length;
    if (regressions.length) {
      process.stderr.write(
        `bench-latency: ${regressions.length} p50 regressions against ${path.relative(repoRoot, recordPath)}:\n${regressions.map((line) => `  ${line}\n`).join("")}`,
      );
      process.exit(1);
    }
    process.stdout.write(`\ncheck: ${compared} metrics compared with the record, no regression\n`);
  }
  if (options.updateRecord) {
    let changed;
    try {
      changed = updateRecord(pooled, record, {
        loosen: options.loosen,
        machine,
        commit: results[0].commit ?? null,
      });
    } catch (error) {
      fail(error.message);
    }
    process.stdout.write(
      `\nrecord: ${changed.length ? changed.map((line) => `\n  ${line}`).join("") : "no change"}\n`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const savedFiles = options.check?.length
    ? options.check
    : options.updateRecord?.length
      ? options.updateRecord
      : null;

  if (options.diff) {
    printCompare(options.diff.a.map(readResult), options.diff.b.map(readResult));
    return;
  }
  if (savedFiles) {
    const results = savedFiles.map(readResult);
    for (const result of results) printScoreboard(metricsOf(result));
    ratchet(options, results);
    return;
  }

  if (process.platform !== "darwin") fail("the bench drives the macOS WKWebView build only");
  mkdirSync(benchRoot, { recursive: true });
  if (options.build) await build();
  const binaries = options.compare ?? [options.binary];
  for (const binary of binaries)
    if (!existsSync(binary))
      fail(`no build at ${binary}${binary === defaultBinary ? "; pass --build" : ""}`);
  if (options.real) {
    options.realAgent = realModel(options.model);
    options.realWrapper = await realClaudeWrapper();
    process.stdout.write(
      `real: Claude turns run on your real Claude login (~/.claude) with ${options.realAgent.id}; each round spends two short turns\n`,
    );
  }

  const prepared = await prepareProfile(options.source);

  if (!options.compare) {
    const { result, file } = await runOnce(
      options,
      prepared,
      options.binary,
      options.label,
      options.out,
    );
    printTable(result);
    printScoreboard(metricsOf(result));
    process.stdout.write(`\nresult: ${file}\n`);
    if (options.check || options.updateRecord) ratchet(options, [result]);
    return;
  }

  const sides = { A: [], B: [] };
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const [index, side] of ["A", "B"].entries()) {
      const { result, file } = await runOnce(
        options,
        prepared,
        options.compare[index],
        `${side}${round}`,
        null,
      );
      sides[side].push(result);
      process.stdout.write(`${side} round ${round}: ${file}\n`);
    }
  }
  printCompare(sides.A, sides.B);
  if (options.check || options.updateRecord) ratchet(options, sides.B);
}

main().catch((error) => fail(error.stack ?? String(error)));
