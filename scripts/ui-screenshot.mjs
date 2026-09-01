#!/usr/bin/env node
// Screenshot the renderer in a real (headless) Chrome via CDP.
//
// Without `window.argmax` the renderer boots against the demo snapshot
// (src/renderer/lib/loadDashboardSnapshot.ts), so the full UI renders in any
// browser with no Rust backend — which makes "does it look right?" a script:
// serve the renderer, open it headless, capture a PNG per theme.
//
// Usage:
//   node scripts/ui-screenshot.mjs [--out shot.png] [--theme dark|light|system]
//        [--width 1400] [--height 900] [--mobile] [--url http://…]
//        [--eval '<js>'] [--settle 900]
//
// With no --url a vite dev server is started on a spare port and stopped
// afterwards. --eval runs after load and before the capture — use it to click
// the UI into the state you want to see. Prints {"out":…} JSON when done.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_PORT = 5187;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Arc.app/Contents/MacOS/Arc"
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    out: "ui-screenshot.png",
    theme: "dark",
    width: 1400,
    height: 900,
    mobile: false,
    url: null,
    evaluate: null,
    settle: 900
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = argv[++i];
    else if (arg === "--theme") options.theme = argv[++i];
    else if (arg === "--width") options.width = Number(argv[++i]);
    else if (arg === "--height") options.height = Number(argv[++i]);
    else if (arg === "--mobile") options.mobile = true;
    else if (arg === "--url") options.url = argv[++i];
    else if (arg === "--eval") options.evaluate = argv[++i];
    else if (arg === "--settle") options.settle = Number(argv[++i]);
    else fail(`unknown argument: ${arg}`);
  }
  if (!["dark", "light", "system"].includes(options.theme)) fail("--theme must be dark, light, or system");
  return options;
}

async function waitFor(probe, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Minimal CDP session over the browser's DevTools WebSocket. */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const eventWaiters = [];
    let nextId = 1;
    socket.addEventListener("open", () =>
      resolve({
        send(method, params = {}, sessionId = undefined) {
          return new Promise((resolveSend, rejectSend) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveSend, reject: rejectSend });
            socket.send(JSON.stringify({ id, method, params, sessionId }));
          });
        },
        waitForEvent(method, timeoutMs = 15000) {
          return new Promise((resolveWait, rejectWait) => {
            const timer = setTimeout(
              () => rejectWait(new Error(`timed out waiting for CDP event ${method}`)),
              timeoutMs
            );
            eventWaiters.push({ method, resolve: (params) => { clearTimeout(timer); resolveWait(params); } });
          });
        },
        close() {
          socket.close();
        }
      })
    );
    socket.addEventListener("error", () => reject(new Error(`could not connect to ${wsUrl}`)));
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.id !== undefined) {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        if (frame.error) entry.reject(new Error(`${frame.error.message} (${frame.method ?? "CDP"})`));
        else entry.resolve(frame.result);
        return;
      }
      for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
        if (eventWaiters[i].method === frame.method) {
          const [waiter] = eventWaiters.splice(i, 1);
          waiter.resolve(frame.params);
        }
      }
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const cleanups = [];
process.on("exit", () => {
  for (const cleanup of cleanups.reverse()) cleanup();
});

let baseUrl = options.url;
if (!baseUrl) {
  const vite = spawn("npx", ["vite", "--port", String(VITE_PORT), "--strictPort"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"]
  });
  cleanups.push(() => vite.kill("SIGTERM"));
  // Vite binds "localhost", which may resolve to ::1 only — probe the same name.
  baseUrl = `http://localhost:${VITE_PORT}/`;
  await waitFor(
    () => fetch(baseUrl).then((response) => response.ok).catch(() => false),
    20000,
    "the vite dev server"
  );
}
const pageUrl = options.mobile ? new URL("mobile.html", baseUrl).href : baseUrl;

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
if (!chrome) fail(`no Chromium-based browser found (looked for:\n  ${CHROME_CANDIDATES.join("\n  ")})`);

const profileDir = mkdtempSync(path.join(tmpdir(), "argmax-ui-shot-"));
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--hide-scrollbars",
    `--window-size=${options.width},${options.height}`,
    "about:blank"
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
cleanups.push(() => browser.kill("SIGTERM"));

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("browser never printed its DevTools URL")), 15000);
  browser.stderr.on("data", (chunk) => {
    buffer += String(chunk);
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
}).catch((error) => fail(error.message));

const cdp = await connectCdp(wsUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sessionId);
// Theme must exist before the app boots — theme.ts reads localStorage at startup.
await cdp.send(
  "Page.addScriptToEvaluateOnNewDocument",
  { source: `try { localStorage.setItem("argmax.theme.mode", ${JSON.stringify(options.theme)}); } catch {}` },
  sessionId
);
const loaded = cdp.waitForEvent("Page.loadEventFired");
await cdp.send("Page.navigate", { url: pageUrl }, sessionId);
await loaded;

if (options.evaluate) {
  const { exceptionDetails } = await cdp.send(
    "Runtime.evaluate",
    { expression: options.evaluate, awaitPromise: true, userGesture: true },
    sessionId
  );
  if (exceptionDetails) fail(`--eval threw: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
}
await new Promise((resolve) => setTimeout(resolve, options.settle));

const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
const out = path.resolve(options.out);
writeFileSync(out, Buffer.from(data, "base64"));
cdp.close();
console.log(JSON.stringify({ out, url: pageUrl, theme: options.theme, width: options.width, height: options.height }));
process.exit(0);
