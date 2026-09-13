import { access, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  cleanupWdioSession,
  createTauriCapabilities,
  startWdioSession
} from "@wdio/tauri-service";
import { delay, runChecked } from "./common.mjs";

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DESKTOP_EXIT_TIMEOUT_MS = 5_000;
const DESKTOP_DESCENDANT_EXIT_TIMEOUT_MS = 2_000;
export const NATIVE_STOP_MINIMUM_SESSION_AGE_MS = 10_001;
const desktopProcesses = new WeakMap();

async function isExecutable(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    await access(filePath, process.platform === "win32" ? undefined : 1);
    return true;
  } catch {
    return false;
  }
}

async function freeLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback WebDriver port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function processSnapshot() {
  const result = await runChecked("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { timeoutMs: 5_000 });
  return result.stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), startedAt: match[3] }));
}

function processDescendants(processes, parentPid) {
  const ownedPids = new Set([parentPid]);
  const descendants = [];
  let foundAnotherGeneration = true;
  while (foundAnotherGeneration) {
    foundAnotherGeneration = false;
    for (const processInfo of processes) {
      if (ownedPids.has(processInfo.pid) || !ownedPids.has(processInfo.parentPid)) continue;
      ownedPids.add(processInfo.pid);
      descendants.push(processInfo);
      foundAnotherGeneration = true;
    }
  }
  return descendants;
}

export function matchingProcessIdentities(processes, expected) {
  const actualByPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  return expected.filter((processInfo) => actualByPid.get(processInfo.pid)?.startedAt === processInfo.startedAt);
}

async function waitForProcessExit(expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = expected;
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(50);
    remaining = matchingProcessIdentities(await processSnapshot(), expected);
  }
  return remaining;
}

async function signalMatchingProcesses(expected, signal) {
  const matching = matchingProcessIdentities(await processSnapshot(), expected);
  for (const processInfo of matching) {
    try {
      process.kill(processInfo.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return matching;
}

async function closeDesktopProcessTree(browser) {
  const processInfo = desktopProcesses.get(browser);
  const errors = [];
  let appIdentity = null;
  let descendants = [];
  let identityStatus = "unknown";
  try {
    if (!processInfo) throw new Error("Could not identify the verification app process before closing it");
    const before = await processSnapshot();
    appIdentity = matchingProcessIdentities(before, [processInfo])[0] ?? null;
    if (!appIdentity) {
      identityStatus = before.some((candidate) => candidate.pid === processInfo.pid) ? "reused" : "exited";
      return {
        appPid: processInfo.pid,
        appStartedAt: processInfo.startedAt,
        identityStatus,
        descendantPids: [],
        terminatedDescendantPids: []
      };
    }
    identityStatus = "matched";
    descendants = processDescendants(before, appIdentity.pid);
  } catch (error) {
    errors.push(error);
  }

  if (appIdentity) {
    try {
      await cleanupWdioSession(browser);
    } catch (error) {
      errors.push(error);
    }
  }

  if (appIdentity) {
    try {
      const runningApp = await waitForProcessExit([appIdentity], DESKTOP_EXIT_TIMEOUT_MS);
      if (runningApp.length > 0) {
        throw new Error(`Verification app process ${appIdentity.pid} remained alive after WebDriver cleanup`);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  let terminatedDescendants = [];
  if (descendants.length > 0) {
    try {
      terminatedDescendants = await signalMatchingProcesses(descendants, "SIGTERM");
      let remaining = await waitForProcessExit(terminatedDescendants, DESKTOP_DESCENDANT_EXIT_TIMEOUT_MS);
      if (remaining.length > 0) {
        await signalMatchingProcesses(remaining, "SIGKILL");
        remaining = await waitForProcessExit(remaining, DESKTOP_DESCENDANT_EXIT_TIMEOUT_MS);
      }
      if (remaining.length > 0) {
        throw new Error(`Owned verification descendants remained alive: ${remaining.map((entry) => entry.pid).join(", ")}`);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Desktop cleanup failed: ${errors.map(errorMessage).join("; ")}`);
  }
  return {
    appPid: processInfo.pid,
    appStartedAt: processInfo.startedAt,
    identityStatus,
    descendantPids: descendants.map((entry) => entry.pid),
    terminatedDescendantPids: terminatedDescendants.map((entry) => entry.pid)
  };
}

async function captureDesktopState(browser) {
  return await browser.execute(function captureUiState() {
    const diagnostic = window.__ARGMAX_VERIFICATION__?.snapshot();
    return {
      title: document.title,
      url: window.location.href,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      documentHiddenAttribute: document.documentElement.getAttribute("data-document-hidden"),
      activeElement: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName,
      bodyText: document.body.innerText.slice(0, 10_000),
      diagnostics: diagnostic ?? { entries: [], breadcrumbs: [] }
    };
  });
}

async function macosDesktopState(pid, activate) {
  const source = [
    "import AppKit",
    "import CoreGraphics",
    `guard let app = NSRunningApplication(processIdentifier: pid_t(${pid})) else { exit(2) }`,
    "func state() -> [String: Any] {",
    "  let windows = (CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []).filter { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier }",
    "  return [\"policy\": app.activationPolicy.rawValue, \"active\": app.isActive, \"hidden\": app.isHidden, \"finishedLaunching\": app.isFinishedLaunching, \"frontmostPid\": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, \"windowCount\": windows.count, \"onScreenWindowCount\": windows.filter { $0[kCGWindowIsOnscreen as String] as? Bool == true }.count]",
    "}",
    "let before = state()",
    `let activated: Any = ${activate ? "app.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])" : "NSNull()"}`,
    "let data = try! JSONSerialization.data(withJSONObject: [\"before\": before, \"activated\": activated, \"after\": state()])",
    "print(String(data: data, encoding: .utf8)!)"
  ].join("\n");
  const result = await runChecked("/usr/bin/swift", ["-e", source], { timeoutMs: 10_000 });
  return JSON.parse(result.stdout);
}

async function ensureDesktopForeground(browser) {
  const visibilityState = await browser.execute(function currentVisibility() {
    return document.visibilityState;
  });

  const processInfo = desktopProcesses.get(browser);
  if (!processInfo) throw new Error("Could not identify the verification app process to foreground it");
  const activation = await macosDesktopState(processInfo.pid, true);
  if (activation.activated !== true) {
    throw new Error(`Could not activate verification app process ${processInfo.pid}: ${JSON.stringify(activation)}`);
  }

  try {
    await browser.waitUntil(
      async () =>
        await browser.execute(function documentIsVisible() {
          return document.visibilityState === "visible";
        }),
      { timeout: 5_000, interval: 50, timeoutMsg: `Verification app process ${processInfo.pid} did not become visible` }
    );
  } catch (visibilityError) {
    let failureState;
    try {
      failureState = await macosDesktopState(processInfo.pid, false);
    } catch (diagnosticError) {
      failureState = { diagnosticError: errorMessage(diagnosticError) };
    }
    throw new Error(
      `Verification app process ${processInfo.pid} did not become visible: ${errorMessage(visibilityError)}; ${JSON.stringify({ activation, failureState })}`
    );
  }
  return { changed: visibilityState !== "visible", pid: processInfo.pid };
}

async function desktopProcessForPort(port, expectedBinary) {
  const listener = await runChecked(
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { timeoutMs: 5_000 }
  );
  const pids = [...new Set(listener.stdout.split(/\s+/).filter(Boolean))];
  if (pids.length !== 1 || !/^\d+$/.test(pids[0])) {
    throw new Error(`Expected one verification app on WebDriver port ${port}, found: ${pids.join(", ") || "none"}`);
  }
  const pid = Number(pids[0]);
  const beforeExecutableCheck = await processSnapshot();
  const identity = beforeExecutableCheck.find((candidate) => candidate.pid === pid);
  if (!identity) {
    throw new Error(`Verification app process ${pid} exited before its executable could be checked`);
  }
  const processFiles = await runChecked(
    "/usr/sbin/lsof",
    ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    { timeoutMs: 5_000 }
  );
  const executable = processFiles.stdout
    .split("\n")
    .find((line) => line.startsWith("n"))
    ?.slice(1);
  const [actualPath, expectedPath] = await Promise.all([
    executable ? realpath(executable) : Promise.resolve(null),
    realpath(expectedBinary)
  ]);
  if (!actualPath || actualPath !== expectedPath) {
    throw new Error(
      `Process ${pid} on WebDriver port ${port} is ${executable ?? "unknown"}, expected ${expectedBinary}`
    );
  }
  if (matchingProcessIdentities(await processSnapshot(), [identity]).length !== 1) {
    throw new Error(`Verification app process ${pid} changed identity while its executable was checked`);
  }
  return { ...identity, executable };
}

async function renderedTextEvidence(browser, expectedText) {
  return await browser.execute(function findRenderedText(text) {
    const candidates = Array.from(document.querySelectorAll("body *")).filter(
      (element) => element.children.length === 0 && element.textContent?.includes(text)
    );
    return candidates.map((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const ancestors = [];
      const animations = [];
      let effectiveOpacity = 1;
      let treeVisible = true;
      for (let current = element; current instanceof HTMLElement; current = current.parentElement) {
        const currentStyle = window.getComputedStyle(current);
        effectiveOpacity *= Number(currentStyle.opacity);
        if (currentStyle.display === "none" || currentStyle.visibility === "hidden") treeVisible = false;
        if (currentStyle.opacity !== "1" || currentStyle.display === "none" || currentStyle.visibility === "hidden") {
          ancestors.push({
            tagName: current.tagName,
            className: current.className,
            display: currentStyle.display,
            visibility: currentStyle.visibility,
            opacity: currentStyle.opacity,
            animationName: currentStyle.animationName,
            animationPlayState: currentStyle.animationPlayState
          });
        }
        for (const animation of current.getAnimations()) {
          const timing = animation.effect?.getTiming();
          const computedTiming = animation.effect?.getComputedTiming();
          const iterations = timing?.iterations;
          const endTime = computedTiming?.endTime;
          animations.push({
            targetClassName:
              animation.effect?.target instanceof HTMLElement ? animation.effect.target.className : "",
            playState: animation.playState,
            iterations: typeof iterations === "number" ? iterations : null,
            endTime: typeof endTime === "number" ? endTime : null,
            finite: typeof iterations !== "number" || Number.isFinite(iterations)
          });
        }
      }
      return {
        tagName: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        text: element.textContent?.slice(0, 500) ?? "",
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        effectiveOpacity,
        ancestors,
        animations,
        rendered:
          rect.width > 0 &&
          rect.height > 0 &&
          treeVisible &&
          effectiveOpacity > 0,
        paintReady:
          rect.width > 0 &&
          rect.height > 0 &&
          treeVisible &&
          effectiveOpacity >= 0.98 &&
          animations.every(
            (animation) =>
              !animation.finite || animation.playState === "finished" || animation.playState === "idle"
          )
      };
    });
  }, expectedText);
}

async function waitForAnimationFrames(browser) {
  return await browser.executeAsync(function awaitPaint(done) {
    const timeout = window.setTimeout(() => done(false), 1_000);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(timeout);
        done(true);
      });
    });
  });
}

function rendererErrors(uiState) {
  return (uiState?.diagnostics?.entries ?? []).filter(
    (entry) => entry.level === "error" || entry.level === "unhandled-rejection"
  );
}

function rendererErrorMessages(uiState) {
  return rendererErrors(uiState).map((entry) => `${entry.level}: ${entry.message}`);
}

export async function inspectDesktopPrerequisites({ appBinaryPath, env = {} } = {}) {
  const issues = [];
  if (process.platform !== "darwin") {
    issues.push("Native Argmax verification currently requires macOS");
  }
  if (!appBinaryPath) {
    issues.push("A verification-enabled Argmax binary is required to probe the embedded driver");
  } else {
    const resolved = path.resolve(appBinaryPath);
    if (!(await isExecutable(resolved))) {
      issues.push(`App binary is missing or not executable: ${resolved}`);
    }
  }
  if (env.ARGMAX_VERIFICATION !== undefined && env.ARGMAX_VERIFICATION !== "1") {
    issues.push("ARGMAX_VERIFICATION must be exactly 1");
  }
  if (env.ARGMAX_VERIFICATION_HOME !== undefined) {
    const verificationHome = env.ARGMAX_VERIFICATION_HOME;
    if (!path.isAbsolute(verificationHome)) {
      issues.push("ARGMAX_VERIFICATION_HOME must be absolute");
    } else {
      try {
        if (!(await stat(verificationHome)).isDirectory()) {
          issues.push(`Verification home is not a directory: ${verificationHome}`);
        }
      } catch {
        issues.push(`Verification home does not exist: ${verificationHome}`);
      }
    }
  }
  return {
    available: issues.length === 0,
    platform: process.platform,
    issues
  };
}

/** Prove the embedded driver can launch the app and reach its real backend. */
export async function probeDesktopDriver({ appBinaryPath, outputDir, env = {}, port }) {
  const result = { available: false, verified: false, issues: [], uiState: null };
  let desktop;
  try {
    desktop = await connectDesktop({ appBinaryPath, outputDir, env, port });
    await desktop.browser.waitUntil(
      async () =>
        await desktop.browser.execute(function backendReady() {
          return Boolean(window.argmax?.health?.ping);
        }),
      { timeout: 20_000, interval: 100, timeoutMsg: "Argmax backend bridge did not become ready" }
    );
    const health = await desktop.browser.execute(async function probeHealth() {
      return await window.argmax.health.ping();
    });
    if (health?.ok !== true) throw new Error("Argmax health probe returned an invalid response");
    result.available = true;
    result.verified = true;
    result.uiState = await captureDesktopState(desktop.browser);
  } catch (error) {
    result.issues.push(errorMessage(error));
  } finally {
    if (desktop) {
      try {
        await desktop.close();
      } catch (error) {
        result.available = false;
        result.verified = false;
        result.issues.push(`Desktop cleanup failed: ${errorMessage(error)}`);
      }
    }
  }
  return result;
}

/**
 * Start a verification-only Argmax binary and connect to its embedded
 * loopback WebDriver. The service owns the app process and terminates it from
 * close(); callers must not launch a second copy themselves.
 */
export async function connectDesktop({
  appBinaryPath,
  outputDir,
  env = {},
  port,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS
}) {
  if (!appBinaryPath) throw new Error("connectDesktop requires appBinaryPath");
  if (!outputDir) throw new Error("connectDesktop requires outputDir");

  const binary = path.resolve(appBinaryPath);
  const evidenceDir = path.resolve(outputDir);
  const prerequisites = await inspectDesktopPrerequisites({ appBinaryPath: binary, env });
  if (!prerequisites.available) {
    throw new Error(`Desktop verification prerequisites failed:\n${prerequisites.issues.join("\n")}`);
  }
  await mkdir(evidenceDir, { recursive: true });

  const embeddedPort = port ?? (await freeLoopbackPort());
  const capabilities = createTauriCapabilities(binary, {
    driverProvider: "embedded",
    logLevel: "warn",
    startTimeout: startTimeoutMs
  });
  capabilities["wdio:tauriServiceOptions"] = {
    ...capabilities["wdio:tauriServiceOptions"],
    appBinaryPath: binary,
    driverProvider: "embedded",
    embeddedPort,
    startTimeout: startTimeoutMs,
    commandTimeout: 30_000,
    captureBackendLogs: true,
    captureFrontendLogs: false,
    logDir: evidenceDir,
    env: {
      ...env,
      ARGMAX_VERIFICATION: "1"
    }
  };

  const browser = await startWdioSession(capabilities);
  try {
    desktopProcesses.set(browser, await desktopProcessForPort(embeddedPort, binary));
    await ensureDesktopForeground(browser);
  } catch (error) {
    let cleanupError = null;
    try {
      if (desktopProcesses.has(browser)) await closeDesktopProcessTree(browser);
      else await cleanupWdioSession(browser);
    } catch (caught) {
      cleanupError = caught;
    } finally {
      desktopProcesses.delete(browser);
    }
    throw new Error(`${errorMessage(error)}${cleanupError ? `; ${errorMessage(cleanupError)}` : ""}`);
  }
  let closed = false;
  return {
    browser,
    port: embeddedPort,
    async close() {
      if (closed) return;
      closed = true;
      try {
        return await closeDesktopProcessTree(browser);
      } finally {
        desktopProcesses.delete(browser);
      }
    }
  };
}

async function desktopSmoke(browser, outputDir) {
  const assertions = [];
  const assert = (name, condition, detail) => {
    assertions.push({ name, ok: Boolean(condition), ...(detail ? { detail } : {}) });
    if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ""}`);
  };

  await ensureDesktopForeground(browser);

  await browser.waitUntil(
    async () =>
      await browser.execute(function argmaxReady() {
        return Boolean(window.argmax?.health?.ping && window.__ARGMAX_VERIFICATION__?.snapshot);
      }),
    { timeout: 30_000, interval: 100, timeoutMsg: "Argmax renderer did not become ready" }
  );

  const backend = await browser.execute(async function verifyBackend() {
    const ping = await window.argmax.health.ping();
    const dashboard = await window.argmax.dashboard.list();
    return {
      ping,
      dashboardShape: {
        projects: Array.isArray(dashboard.projects),
        workspaces: Array.isArray(dashboard.workspaces),
        sessions: Array.isArray(dashboard.sessions)
      }
    };
  });
  assert("real backend health responds", backend?.ping?.ok === true);
  assert(
    "real backend dashboard responds",
    backend?.dashboardShape?.projects === true &&
      backend?.dashboardShape?.workspaces === true &&
      backend?.dashboardShape?.sessions === true
  );

  const customize = await browser.$('[aria-label="Customize"]');
  await customize.waitForDisplayed({ timeout: 10_000 });
  await customize.click();
  const search = await browser.$('[aria-label="Search settings"]');
  await search.waitForDisplayed({ timeout: 10_000 });
  await search.setValue("appearance");
  assert("native WebDriver click opens settings", await search.isDisplayed());
  assert("native WebDriver types into the UI", (await search.getValue()) === "appearance");

  const screenshotPath = path.join(outputDir, "desktop-smoke.png");
  await browser.saveScreenshot(screenshotPath);
  assert("native WebDriver captures the webview", true, screenshotPath);

  const uiState = await captureDesktopState(browser);
  const errors = rendererErrors(uiState);
  assert("renderer has no captured errors", errors.length === 0, errors.map((entry) => entry.message).join("\n"));

  return {
    assertions,
    screenshots: [screenshotPath],
    uiState,
    errors
  };
}

export async function runDesktopVerification({
  appBinaryPath,
  outputDir,
  env = {},
  port,
  scenario = "smoke"
}) {
  const evidenceDir = path.resolve(outputDir);
  const result = {
    ok: false,
    assertions: [],
    screenshots: [],
    uiState: null,
    errors: []
  };
  let desktop;
  try {
    desktop = await connectDesktop({ appBinaryPath, outputDir: evidenceDir, env, port });
    if (scenario !== "smoke") throw new Error(`Unknown desktop verification scenario: ${scenario}`);
    Object.assign(result, await desktopSmoke(desktop.browser, evidenceDir), { ok: true });
  } catch (error) {
    result.errors.push(errorMessage(error));
    if (desktop) {
      try {
        const failureScreenshot = path.join(evidenceDir, "desktop-failure.png");
        await desktop.browser.saveScreenshot(failureScreenshot);
        result.screenshots.push(failureScreenshot);
      } catch (screenshotError) {
        result.errors.push(`Failure screenshot failed: ${errorMessage(screenshotError)}`);
      }
      try {
        result.uiState = await captureDesktopState(desktop.browser);
        result.errors.push(...rendererErrorMessages(result.uiState));
      } catch (stateError) {
        result.errors.push(`UI state capture failed: ${errorMessage(stateError)}`);
      }
    }
  } finally {
    if (desktop) {
      try {
        await desktop.close();
      } catch (error) {
        result.ok = false;
        result.errors.push(`Desktop cleanup failed: ${errorMessage(error)}`);
      }
    }
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(path.join(evidenceDir, "desktop-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

/** Verify a session created through the real backend is visible in the same app. */
export async function verifyDesktopSession({
  browser,
  outputDir,
  name = "session",
  titleIncludes,
  expectedTexts = [],
  expectIdle = false,
  timeoutMs = 20_000,
  paintTimeoutMs = 5_000
}) {
  if (!browser) throw new Error("verifyDesktopSession requires browser");
  if (!outputDir) throw new Error("verifyDesktopSession requires outputDir");
  if (!titleIncludes) throw new Error("verifyDesktopSession requires titleIncludes");

  const evidenceDir = path.resolve(outputDir);
  await mkdir(evidenceDir, { recursive: true });
  const assertions = [];
  const errors = [];
  const screenshots = [];
  let uiState = null;
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, "-");

  try {
    const foreground = await ensureDesktopForeground(browser);
    let visibilityRecoveries = foreground.changed ? 1 : 0;
    assertions.push({
      name: "native WebDriver targets a visible app window",
      ok: true,
      ...(foreground.pid ? { detail: `pid ${foreground.pid}` } : {})
    });
    let sessionRow = null;
    await browser.waitUntil(
      async () => {
        const titled = await browser.$$('[title]');
        for (const element of titled) {
          const title = await element.getAttribute("title");
          if (title?.includes(titleIncludes)) {
            sessionRow = element;
            return true;
          }
        }
        const expanders = await browser.$$('button[aria-label^="Show "][aria-label$=" chats"]');
        for (const expander of expanders) await expander.click();
        return false;
      },
      { timeout: timeoutMs, interval: 250, timeoutMsg: `Session row containing ${titleIncludes} was not visible` }
    );
    await sessionRow.click();
    if ((await ensureDesktopForeground(browser)).changed) visibilityRecoveries += 1;
    assertions.push({ name: "native WebDriver opens the backend-created session", ok: true });

    for (const expectedText of expectedTexts) {
      await browser.waitUntil(
        async () => (await browser.$("body").getText()).includes(expectedText),
        { timeout: timeoutMs, interval: 200, timeoutMsg: `Visible session text did not include: ${expectedText}` }
      );
      assertions.push({ name: `visible session includes ${expectedText}`, ok: true });
      if ((await ensureDesktopForeground(browser)).changed) visibilityRecoveries += 1;
      let rendered = [];
      let visibleMatch = null;
      await browser.waitUntil(
        async () => {
          rendered = await renderedTextEvidence(browser, expectedText);
          visibleMatch = rendered.find((entry) => entry.paintReady) ?? null;
          return visibleMatch !== null;
        },
        { timeout: paintTimeoutMs, interval: 50, timeoutMsg: `Session text did not finish painting: ${expectedText}` }
      );
      assertions.push({
        name: `session paints ${expectedText}`,
        ok: Boolean(visibleMatch),
        ...(visibleMatch ? { detail: JSON.stringify(visibleMatch.rect) } : { detail: JSON.stringify(rendered) })
      });
      if (!visibleMatch) throw new Error(`Session text is present but not rendered: ${expectedText}`);
    }

    if (expectIdle) {
      await browser.waitUntil(
        async () => {
          const idle = await browser.execute(function sessionIsIdle() {
            const send = document.querySelector('[aria-label="Send follow-up"]');
            const stop = document.querySelector('[aria-label="Stop chat"]');
            const thinking = document.querySelector('[aria-label="Thinking"]');
            return {
              ready: send instanceof HTMLButtonElement && stop === null && thinking === null
            };
          });
          return idle.ready;
        },
        { timeout: timeoutMs, interval: 50, timeoutMsg: "Session did not reach an idle rendered state" }
      );
      assertions.push({ name: "terminal session renders idle controls and no busy cue", ok: true });
    }

    if ((await ensureDesktopForeground(browser)).changed) visibilityRecoveries += 1;
    assertions.push({
      name: "native app remains visible through paint checkpoints",
      ok: true,
      detail: `visibility recoveries: ${visibilityRecoveries}`
    });
    const animationFramesAdvanced = await waitForAnimationFrames(browser);
    assertions.push({ name: "webview advances paint frames before screenshot", ok: animationFramesAdvanced });
    if (!animationFramesAdvanced) throw new Error("Webview did not advance paint frames before screenshot");
    await browser.pause(50);
    const screenshotPath = path.join(evidenceDir, `${safeName}.png`);
    await browser.saveScreenshot(screenshotPath);
    screenshots.push(screenshotPath);
    assertions.push({ name: "native WebDriver captures the verified session", ok: true, detail: screenshotPath });
    uiState = await captureDesktopState(browser);
    errors.push(...rendererErrorMessages(uiState));
    assertions.push({
      name: "renderer has no captured errors",
      ok: errors.length === 0,
      ...(errors.length ? { detail: errors.join("\n") } : {})
    });
  } catch (error) {
    errors.push(errorMessage(error));
    try {
      const screenshotPath = path.join(evidenceDir, `${safeName}-failure.png`);
      await browser.saveScreenshot(screenshotPath);
      screenshots.push(screenshotPath);
    } catch (screenshotError) {
      errors.push(`Failure screenshot failed: ${errorMessage(screenshotError)}`);
    }
    try {
      uiState = await captureDesktopState(browser);
      errors.push(...rendererErrorMessages(uiState));
    } catch (stateError) {
      errors.push(`UI state capture failed: ${errorMessage(stateError)}`);
    }
  }

  const result = {
    ok: assertions.length > 0 && assertions.every((assertion) => assertion.ok) && errors.length === 0,
    assertions,
    screenshots,
    uiState,
    errors
  };
  await writeFile(path.join(evidenceDir, `${safeName}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Send a follow-up through the native composer in the attached app. */
export async function sendDesktopMessage({ browser, input, sessionId = null, expectQueued = false }) {
  if (!browser) throw new Error("sendDesktopMessage requires browser");
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("sendDesktopMessage requires non-empty input");
  }
  if (expectQueued && !sessionId) throw new Error("queued sendDesktopMessage requires sessionId");

  await ensureDesktopForeground(browser);

  const composer = await browser.$('[aria-label="Chat prompt"]');
  await composer.waitForEnabled({ timeout: 20_000 });
  await composer.setValue(input);
  if (expectQueued) {
    await browser.keys("Enter");
  } else {
    const send = await browser.$('[aria-label="Send follow-up"]');
    await send.waitForEnabled({ timeout: 10_000 });
    await send.click();
  }
  await browser.waitUntil(async () => (await composer.getValue()) === "", {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: "Native composer did not clear after sending the follow-up"
  });

  let queuedMessage = null;
  if (expectQueued) {
    await browser.waitUntil(
      async () => {
        const dashboard = await browser.execute(async function pendingMessage(id, content) {
          const snapshot = await window.argmax.dashboard.list();
          const entries = snapshot.pendingMessages[id] ?? [];
          return entries.length === 1 && entries[0].content === content ? entries[0] : null;
        }, sessionId, input);
        queuedMessage = dashboard;
        return queuedMessage !== null;
      },
      { timeout: 10_000, interval: 100, timeoutMsg: "Native follow-up was not persisted in the pending queue" }
    );
  }

  const uiState = await captureDesktopState(browser);
  return {
    ok: rendererErrors(uiState).length === 0,
    assertions: [
      { name: "native composer accepts follow-up text", ok: true },
      { name: expectQueued ? "native composer queues follow-up with Enter" : "native composer sends follow-up through the UI", ok: true },
      ...(queuedMessage ? [{ name: "native follow-up appears once in the pending queue", ok: true, detail: queuedMessage.id }] : [])
    ],
    queuedMessage,
    uiState,
    errors: rendererErrorMessages(uiState)
  };
}

/** Explicitly send one recovered follow-up through its native queue action. */
export async function sendDesktopQueuedMessage({ browser, sessionId, messageId, input }) {
  if (!browser) throw new Error("sendDesktopQueuedMessage requires browser");
  if (!sessionId || !messageId) throw new Error("sendDesktopQueuedMessage requires sessionId and messageId");
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("sendDesktopQueuedMessage requires non-empty input");
  }

  await ensureDesktopForeground(browser);
  const queuedMessages = await browser.execute(async function pendingMessages(id) {
    const snapshot = await window.argmax.dashboard.list();
    return snapshot.pendingMessages[id] ?? [];
  }, sessionId);
  if (
    queuedMessages.length !== 1
    || queuedMessages[0].id !== messageId
    || queuedMessages[0].content !== input
  ) {
    throw new Error(`Expected exactly one recovered queued follow-up ${messageId} before explicit Send`);
  }
  let send = null;
  await browser.waitUntil(
    async () => {
      const candidates = await browser.$$('button[aria-label^="Send queued follow-up: "]');
      const matchingActions = [];
      for (const candidate of candidates) {
        if ((await candidate.getAttribute("aria-label")) === `Send queued follow-up: ${input}`) matchingActions.push(candidate);
      }
      if (matchingActions.length !== 1) return false;
      [send] = matchingActions;
      return true;
    },
    { timeout: 10_000, interval: 100, timeoutMsg: "Recovered follow-up did not expose exactly one matching Send action" }
  );
  await send.waitForEnabled({ timeout: 10_000 });
  await send.click();
  await browser.waitUntil(
    async () =>
      await browser.execute(async function sessionQueueIsEmpty(id) {
        const snapshot = await window.argmax.dashboard.list();
        return (snapshot.pendingMessages[id] ?? []).length === 0;
      }, sessionId),
    { timeout: 10_000, interval: 100, timeoutMsg: `Session queue was not empty after sending follow-up ${messageId}` }
  );

  const uiState = await captureDesktopState(browser);
  return {
    ok: rendererErrors(uiState).length === 0,
    assertions: [
      { name: "native recovered follow-up exposes an explicit Send action", ok: true },
      { name: "native explicit Send removes the recovered pending row", ok: true }
    ],
    uiState,
    errors: rendererErrorMessages(uiState)
  };
}

/** Stop the running provider through the native session control. */
export async function stopDesktopSession({
  browser,
  sessionId
}) {
  if (!browser) throw new Error("stopDesktopSession requires browser");
  if (!sessionId) throw new Error("stopDesktopSession requires sessionId");

  await ensureDesktopForeground(browser);

  const beforeWait = await browser.execute(async function sessionBeforeStop(id) {
    const dashboard = await window.argmax.dashboard.list();
    const session = dashboard.sessions.find((candidate) => candidate.id === id);
    return session ? { startedAt: session.startedAt, state: session.state } : null;
  }, sessionId);
  if (!beforeWait?.startedAt || beforeWait.state !== "running") {
    throw new Error(`Native stop expected running session ${sessionId}`);
  }
  const startedAtMs = Date.parse(beforeWait.startedAt);
  if (Number.isNaN(startedAtMs)) {
    throw new Error(`Native stop received invalid session start time: ${beforeWait.startedAt}`);
  }
  const remainingEarlyStopMs = startedAtMs + NATIVE_STOP_MINIMUM_SESSION_AGE_MS - Date.now();
  if (remainingEarlyStopMs > 0) {
    await browser.waitUntil(
      () => Date.now() - startedAtMs >= NATIVE_STOP_MINIMUM_SESSION_AGE_MS,
      {
        timeout: remainingEarlyStopMs + 1_000,
        interval: 25,
        timeoutMsg: `Native stop did not reach the ${NATIVE_STOP_MINIMUM_SESSION_AGE_MS}ms minimum session age`
      }
    );
  }
  const sessionAgeMs = Date.now() - startedAtMs;
  if (sessionAgeMs < NATIVE_STOP_MINIMUM_SESSION_AGE_MS) {
    throw new Error(`Native stop did not reach the ${NATIVE_STOP_MINIMUM_SESSION_AGE_MS}ms minimum session age`);
  }

  const beforeClick = await browser.execute(async function sessionBeforeStop(id) {
    const dashboard = await window.argmax.dashboard.list();
    const session = dashboard.sessions.find((candidate) => candidate.id === id);
    return session?.state ?? null;
  }, sessionId);
  if (beforeClick !== "running") {
    throw new Error(`Session ${sessionId} stopped before the native Stop click: ${beforeClick ?? "missing"}`);
  }

  const stop = await browser.$('[aria-label="Stop chat"]');
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await stop.waitForExist({ reverse: true, timeout: 20_000 });

  const uiState = await captureDesktopState(browser);
  return {
    ok: rendererErrors(uiState).length === 0,
    assertions: [
      {
        name: "native Stop waits past the early-stop restore window",
        ok: true,
        detail: `session age ${sessionAgeMs}ms`
      },
      { name: "native session remains running until the Stop click", ok: true },
      { name: "native session control stops the running chat", ok: true }
    ],
    uiState,
    errors: rendererErrorMessages(uiState)
  };
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--app" && value) options.appBinaryPath = value;
    else if (flag === "--output" && value) options.outputDir = value;
    else if (flag === "--scenario" && value) options.scenario = value;
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  return options;
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const result = await runDesktopVerification({
    ...parseCli(process.argv.slice(2)),
    env: process.env
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
