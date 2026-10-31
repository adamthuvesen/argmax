#!/usr/bin/env node
// Drives the real renderer (demo snapshot, no Rust backend) in one headless
// Chrome against one loopback vite server. Usage: verify [all|list|control|<drive>...]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkoutFingerprint, writeTripwires } from "../../../scripts/verification/common.mjs";
import { redact } from "../../../scripts/verification/evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((candidate) => typeof candidate === "string");
const MACHINE_COMMANDS = [
  "launchctl",
  "defaults",
  "brew",
  "security",
  "op",
  "crontab",
  "systemctl",
];
const SHARED_PATHS = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "index.html",
  "tsconfig.json",
  "src/shared/**",
  "src/renderer/main.tsx",
  "src/renderer/App.tsx",
  "src/renderer/demo*.ts",
  "src/renderer/lib/loadDashboardSnapshot.ts",
  "src/renderer/state/**",
  "src/renderer/data/**",
  "scripts/ui-screenshot.mjs",
  "scripts/verification/common.mjs",
  ".agents/skills/verify-argmax/**",
];

// Injected into each page: poll for a visible state instead of sleeping.
const UNTIL = `const until = async (probe, what, ms = 10000) => { const end = Date.now() + ms; for (;;) { const value = probe(); if (value) return value; if (Date.now() > end) throw new Error("timed out waiting for " + what); await new Promise((r) => setTimeout(r, 100)); } };`;
const text = (selector) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.textContent.trim())`;

const DRIVES = {
  launcher: {
    proves:
      "The app boots to the New chat launcher in dark and light, with the theme applied and the prompt editable",
    paths: [
      "src/renderer/**/*.css",
      "src/renderer/styles/**",
      "src/renderer/lib/theme.ts",
      "src/renderer/components/LaunchSurface.tsx",
      "src/renderer/components/Sidebar*.tsx",
    ],
    timeoutMs: 25_000,
    async run(ctx) {
      const heading = ctx.control ? CONTROL_HEADING : "What are we building?";
      for (const theme of ["dark", "light"]) {
        const facts = await page(
          ctx,
          `launcher-${theme}`,
          ["--theme", theme],
          `(async () => { ${UNTIL}
          await until(() => document.querySelector('[aria-label="Task prompt"]'), "the prompt");
          return { headings: ${text("h1")}, theme: document.documentElement.getAttribute("data-theme"), editable: document.querySelector('[aria-label="Task prompt"]').getAttribute("contenteditable") ?? "textarea" }; })()`,
        );
        expect(
          facts.headings.includes(heading),
          `${theme}: expected heading "${heading}", got ${JSON.stringify(facts.headings)}`,
        );
        expect(
          facts.theme === theme,
          `${theme}: expected data-theme="${theme}", got "${facts.theme}"`,
        );
        expect(facts.editable !== "false", `${theme}: the prompt is not editable`);
      }
      return `"${heading}" in dark and light`;
    },
  },
  "open-chat": {
    proves: "Opening a project's chat from the sidebar shows its transcript and its checks",
    paths: [
      "src/renderer/components/Session*.tsx",
      "src/renderer/components/Sidebar*.tsx",
      "src/renderer/components/Chat*.tsx",
      "src/renderer/components/*Check*.tsx",
      "src/renderer/hooks/**",
    ],
    timeoutMs: 25_000,
    async run(ctx) {
      const facts = await page(
        ctx,
        "open-chat",
        [],
        `(async () => { ${UNTIL}
        (await until(() => document.querySelector('[aria-label="Show Argmax chats"]'), "the Argmax chats toggle")).click();
        const row = await until(() => [...document.querySelectorAll(".session-link")].find((el) => el.textContent.includes("Build review studio shell")), "the chat row");
        row.click();
        const main = await until(() => { const t = document.querySelector("main")?.innerText ?? ""; return t.includes("Build the first review studio shell.") && t; }, "the transcript");
        return { prompt: main.includes("Build the first review studio shell."), check: /npm run tauri:build\\s+PASSED/.test(main), composer: !!document.querySelector('[aria-label="Task prompt"], [aria-label="Message"], .cm-editor') }; })()`,
      );
      expect(facts.prompt, "the transcript does not show the chat's first prompt");
      expect(facts.check, 'the checks card does not show "npm run tauri:build PASSED"');
      expect(facts.composer, "the chat has no composer for a follow-up");
      return "transcript, passed check, and follow-up composer";
    },
  },
  settings: {
    proves:
      "Open settings shows the settings page at General, and its section list opens Appearance",
    paths: ["src/renderer/components/settings/**", "src/renderer/components/Settings*.tsx"],
    timeoutMs: 25_000,
    async run(ctx) {
      const facts = await page(
        ctx,
        "settings",
        [],
        `(async () => { ${UNTIL}
        (await until(() => document.querySelector('[aria-label="Open settings"]'), "the settings button")).click();
        await until(() => ${text("h1,h2")}.includes("General"), "the General section");
        const target = "Appearance";
        (await until(() => [...document.querySelectorAll("button, a")].find((el) => el.textContent.trim() === target), "the " + target + " link")).click();
        await until(() => ${text("h1,h2")}.includes(target), "the " + target + " section");
        return { target, headings: ${text("h1,h2")} }; })()`,
      );
      expect(
        facts.headings.includes(facts.target),
        `expected the ${facts.target} section heading, got ${JSON.stringify(facts.headings)}`,
      );
      return `General, then ${facts.target}`;
    },
  },
  "composer-editor": {
    proves:
      "The prompt editor takes trusted keyboard, IME, and clipboard input: chips, undo, slash commands, send, and draft restore",
    paths: [
      "src/renderer/components/Composer*.tsx",
      "src/renderer/components/composerEditor/**",
      "src/renderer/components/LaunchSurface.tsx",
      "src/renderer/components/SessionComposer.tsx",
      "src/renderer/lib/composer*",
      "scripts/verification/composer-editor.mjs",
    ],
    timeoutMs: 45_000,
    async run(ctx) {
      const out = path.join(ctx.runDir, "composer-editor");
      const result = await child(
        ctx,
        "composer-editor",
        [
          process.execPath,
          "scripts/verification/composer-editor.mjs",
          "--url",
          ctx.baseUrl,
          "--browser-ws",
          ctx.browserWs,
          "--out",
          out,
        ],
        this.timeoutMs,
      );
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")) || "{}");
      const failed = (report.checks ?? []).filter((check) => !check.ok);
      expect(
        report.ok === true && result.code === 0,
        failed.length
          ? failed.map((check) => `${check.name}: ${check.error}`).join("; ")
          : `exit ${result.code}: ${result.stderr.trim().slice(-300)}`,
      );
      return `${report.checks.length} input checks`;
    },
  },
};
const SMOKE = "launcher";
const CONTROL = "launcher";
// The control passes only when launcher fails on exactly this planted heading, and nothing else fails.
const CONTROL_HEADING = "What are we shipping?";
const CONTROL_FAILURE = `dark: expected heading "${CONTROL_HEADING}", got ["What are we building?"]`;

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

function child(ctx, name, argv, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env: ctx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      stderr += `\nverify: killed after ${timeoutMs} ms`;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.once("close", (code) => {
      clearTimeout(timer);
      writeFileSync(
        path.join(ctx.runDir, `${name}.log`),
        String(
          redact(
            [
              `$ ${argv.join(" ")}`,
              `exit ${code}`,
              "--- stdout",
              stdout,
              "--- stderr",
              stderr,
            ].join("\n"),
          ),
        ),
      );
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** One page in its own browser context: screenshot plus the value of `expression`. */
async function page(ctx, name, args, expression) {
  const result = await child(
    ctx,
    name,
    [
      process.execPath,
      "scripts/ui-screenshot.mjs",
      "--url",
      ctx.baseUrl,
      "--browser-ws",
      ctx.browserWs,
      "--settle",
      "150",
      "--out",
      path.join(ctx.runDir, `${name}.png`),
      "--eval",
      expression,
      ...args,
    ],
    20_000,
  );
  expect(
    result.code === 0,
    `${name}: ${(result.stderr.trim() || `exit ${result.code}`).split("\n")[0]}`,
  );
  return JSON.parse(result.stdout.trim().split("\n").pop()).eval;
}

function git(args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

// What a drive must not change: HEAD, the branch, the index, git config and hooks, file contents,
// and every ignored path. Ignored entries compare by size and mtime, since node_modules is too big to hash.
function repoState(content) {
  const gitDir = path.resolve(root, git(["rev-parse", "--git-common-dir"]));
  const digest = (file) =>
    existsSync(file) && statSync(file).isFile()
      ? createHash("sha256").update(readFileSync(file)).digest("hex")
      : "absent";
  const state = { content, ".git/config": digest(path.join(gitDir, "config")) };
  for (const hook of existsSync(path.join(gitDir, "hooks"))
    ? readdirSync(path.join(gitDir, "hooks"))
    : [])
    state[`.git/hooks/${hook}`] = digest(path.join(gitDir, "hooks", hook));
  const listed = (args) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const result = spawnSync("git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`);
    return result.stdout.split("\0").filter((entry) => entry && !/(^| )\.verify\//.test(entry));
  };
  const entries = listed(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  for (let index = 0; index < entries.length; index++) {
    state[entries[index]] = "status";
    if (entries[index].startsWith("2 ")) index++;
  }
  for (const ignored of listed([
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--directory",
    "-z",
  ])) {
    const info = statSync(path.join(root, ignored), { throwIfNoEntry: false });
    state[`ignored ${ignored}`] = info ? `${info.size}:${info.mtimeMs}` : "absent";
  }
  return state;
}

function changedState(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => before[key] !== after[key])
    .sort();
}

function changedDrives() {
  const base =
    git(["merge-base", "HEAD", "main"]) || git(["merge-base", "HEAD", "origin/main"]) || "HEAD";
  const files = [
    ...git(["diff", "--name-only", base]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ].filter(Boolean);
  const hits = (globs) => files.some((file) => globs.some((glob) => path.matchesGlob(file, glob)));
  if (hits(SHARED_PATHS)) return Object.keys(DRIVES);
  const names = Object.keys(DRIVES).filter((name) => hits(DRIVES[name].paths));
  return names.length ? names : [SMOKE];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer().once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitFor(probe, what, ms) {
  const end = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > end) throw new Error(`preflight: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const groups = [];
function startGroup(command, args, env) {
  const proc = spawn(command, args, {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  groups.push(proc.pid);
  return proc;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "list") {
    for (const [name, drive] of Object.entries(DRIVES))
      console.log(
        `${name}${name === SMOKE ? " (smoke)" : ""}\n  ${drive.proves}\n  ${drive.paths.join(" ")}`,
      );
    console.log(`all drives also run on: ${SHARED_PATHS.join(" ")}`);
    return 0;
  }
  const control = args[0] === "control";
  const names = control
    ? [CONTROL]
    : args[0] === "all"
      ? Object.keys(DRIVES)
      : args.length
        ? args
        : changedDrives();
  const unknown = names.filter((name) => !DRIVES[name]);
  if (unknown.length) throw new Error(`unknown drive ${unknown.join(", ")}. Run verify list`);

  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!chrome)
    throw new Error(
      `preflight: no Chromium browser (set CHROME_PATH; looked in ${CHROME_CANDIDATES.join(", ")})`,
    );
  const vite = path.join(root, "node_modules/vite/bin/vite.js");
  if (!existsSync(vite)) throw new Error("preflight: node_modules is missing. Run npm ci");

  const source = await checkoutFingerprint(root);
  const stateBefore = repoState(source.sha256);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const stem = `${stamp}-${source.head.slice(0, 7)}${source.dirty ? "-dirty" : ""}${control ? "-control" : ""}`;
  mkdirSync(path.join(root, ".verify/runs"), { recursive: true });
  let runDir;
  for (let attempt = 1; !runDir; attempt++) {
    const candidate = path.join(root, ".verify/runs", attempt === 1 ? stem : `${stem}-${attempt}`);
    try {
      mkdirSync(candidate);
      runDir = candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  const scratch = mkdtempSync(path.join(tmpdir(), "verify-argmax-"));
  process.on("exit", () => {
    for (const pid of groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  const home = path.join(scratch, "home");
  const tripwireLog = path.join(runDir, "tripwire.log");
  writeFileSync(tripwireLog, "");
  await writeTripwires(path.join(scratch, "tripwire"), tripwireLog, MACHINE_COMMANDS);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE/i.test(key),
      ),
    ),
    PATH: [path.join(scratch, "tripwire"), path.dirname(process.execPath), process.env.PATH].join(
      path.delimiter,
    ),
    HOME: home,
    TMPDIR: path.join(scratch, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    BROWSER: "none",
    CI: "1",
  };
  for (const dir of [env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME])
    mkdirSync(dir, { recursive: true });

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/`;
  startGroup(
    process.execPath,
    [vite, "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    env,
  );
  const browser = startGroup(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${path.join(scratch, "chrome")}`,
      "--no-first-run",
      "--use-mock-keychain",
      "--password-store=basic",
      "--hide-scrollbars",
      "--window-size=1200,900",
      "about:blank",
    ],
    env,
  );
  const browserWs = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("preflight: Chrome never printed its DevTools URL")),
      15_000,
    );
    browser.stderr.on("data", (chunk) => {
      const match = (buffer += chunk).match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  await waitFor(
    () =>
      fetch(baseUrl)
        .then((response) => response.ok)
        .catch(() => false),
    "the vite server",
    20_000,
  );
  console.log(
    `verify-argmax: ${names.join(", ")} against ${baseUrl} (${source.head.slice(0, 7)}${source.dirty ? " dirty" : ""})`,
  );

  const ctx = { env, baseUrl, browserWs, runDir, control };
  const results = [];
  for (const name of names) {
    const started = Date.now();
    let result = "PASS";
    let detail;
    try {
      detail = await DRIVES[name].run.call(DRIVES[name], ctx);
    } catch (error) {
      result = "FAIL";
      detail = error instanceof Error ? error.message : String(error);
    }
    const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
    results.push({ drive: name, result, seconds, detail });
    console.log(`${result} ${name} ${seconds}s ${detail}`);
  }

  const machineCalls = readFileSync(tripwireLog, "utf8").trim();
  if (machineCalls)
    results.push({
      drive: "tripwire",
      result: "FAIL",
      seconds: 0,
      detail: `machine-global command attempted: ${machineCalls.replaceAll("\n", ", ")}`,
    });
  const changed = changedState(stateBefore, repoState((await checkoutFingerprint(root)).sha256));
  if (changed.length)
    results.push({
      drive: "checkout",
      result: "FAIL",
      seconds: 0,
      detail: `the checkout changed during the run, so the evidence is stale: ${changed.join(", ")}`,
    });
  for (const extra of results.slice(names.length))
    console.log(`FAIL ${extra.drive} ${extra.detail}`);

  const failed = results.filter((entry) => entry.result === "FAIL");
  const controlObserved =
    control &&
    failed.length === 1 &&
    failed[0].drive === CONTROL &&
    failed[0].detail === CONTROL_FAILURE;
  writeFileSync(
    path.join(runDir, "summary.json"),
    JSON.stringify(
      {
        sha: source.head,
        dirty: source.dirty,
        baseUrl,
        control: control ? { drive: CONTROL, failObserved: controlObserved } : undefined,
        drives: results,
      },
      null,
      2,
    ) + "\n",
  );
  if (control)
    console.log(
      controlObserved
        ? `control: FAIL observed on ${CONTROL} with a wrong expected heading`
        : `control: expected only ${CONTROL} to FAIL with ${JSON.stringify(CONTROL_FAILURE)}, got ${failed.map((entry) => `${entry.drive}: ${entry.detail}`).join(", ") || "no failure"}`,
    );
  console.log(`evidence: ${runDir}`);
  return control ? (controlObserved ? 0 : 1) : failed.length ? 1 : 0;
}

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(130));
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`verify-argmax: ${error.message}`);
    process.exit(2);
  },
);
