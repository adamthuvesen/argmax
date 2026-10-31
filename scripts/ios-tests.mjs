#!/usr/bin/env node
// Runs the iPhone app's XCTest suite on a simulator. The pre-push gate and CI call this
// same script, so a test cannot pass in one lane and go unrun in the other.
//
//   npm run test:ios
//   npm run test:ios -- --only ParityTableTests
//
// The suite runs on its own simulator, "Argmax Test Lane", so a run cannot
// replace an app someone is looking at on another one. UI tests and
// NativePerformanceTests stay out: see docs/ios-performance.md.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROJECT_DIR = resolve(ROOT, "ios/Argmax");
const CACHE_DIR = resolve(ROOT, "node_modules/.cache/ios-tests");
const DERIVED_DATA = resolve(CACHE_DIR, "DerivedData");
const LOG_PATH = resolve(CACHE_DIR, "last-run.log");
const PRODUCTS = resolve(DERIVED_DATA, "Build/Products");
const SIMULATOR_NAME = "Argmax Test Lane";
const BUNDLE_ID = "com.argmax.remote";
const TEST_TARGET = "ArgmaxTests";
const SKIPPED_CLASS = "NativePerformanceTests";
// Xcode's `simctl` is a shim that runs `xcodebuild -runFirstLaunch` when the
// system's CoreSimulator is older than Xcode expects. That installer waits for
// an administrator, so the shim hangs. The binary it wraps answers either way.
const CORE_SIMCTL = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
if (onlyIndex >= 0 && !only) fail("--only needs a test class, or Class/testMethod");

if (process.platform !== "darwin") fail("the iOS suite needs macOS and Xcode");

function capture(command, commandArgs, options = {}) {
  const run = spawnSync(command, commandArgs, { encoding: "utf8", ...options });
  if (run.error) fail(`${command}: ${run.error.message}`);
  return run;
}

function simctl(...commandArgs) {
  const [command, prefix] = existsSync(CORE_SIMCTL) ? [CORE_SIMCTL, []] : ["xcrun", ["simctl"]];
  const run = capture(command, [...prefix, ...commandArgs], { timeout: 180_000 });
  if (run.status !== 0) fail(`simctl ${commandArgs.join(" ")}: ${run.stderr.trim() || `exit ${run.status}`}`);
  return run.stdout;
}

function testSimulator() {
  const { devices } = JSON.parse(simctl("list", "-j", "devices", "available"));
  for (const list of Object.values(devices)) {
    const existing = list.find((device) => device.name === SIMULATOR_NAME);
    if (existing) return existing;
  }
  // Not a fixed model: a runtime supports only some device types, and the
  // list changes with every Xcode.
  const runtimes = JSON.parse(simctl("list", "-j", "runtimes")).runtimes.filter(
    (runtime) => runtime.platform === "iOS" && runtime.isAvailable
  );
  const runtime = runtimes.at(-1);
  if (!runtime) fail("no iOS simulator runtime is installed. Install one in Xcode > Settings > Components");
  const iPhones = runtime.supportedDeviceTypes.filter((type) => /iPhone/.test(type.name));
  const deviceType = iPhones.find((type) => /Pro$/.test(type.name)) ?? iPhones[0];
  if (!deviceType) fail(`${runtime.name} supports no iPhone device type`);
  const udid = simctl("create", SIMULATOR_NAME, deviceType.identifier, runtime.identifier).trim();
  return { udid, name: SIMULATOR_NAME, state: "Shutdown" };
}

// Writes straight to the log rather than through a pipe, so the exit code is
// the tool's own.
function runLogged(command, commandArgs, options = {}) {
  const log = openSync(LOG_PATH, "a");
  const run = spawnSync(command, commandArgs, { stdio: ["ignore", log, log], ...options });
  closeSync(log);
  if (run.error) fail(`${command}: ${run.error.message}`);
  return run.status ?? 1;
}

function reportFailure(message) {
  const lines = readFileSync(LOG_PATH, "utf8").trimEnd().split("\n");
  console.error(lines.slice(-60).join("\n"));
  console.error(`\nerror: ${message}. Full log: ${LOG_PATH}`);
  process.exit(1);
}

function testClasses() {
  return readdirSync(resolve(PROJECT_DIR, "Tests"))
    .filter((file) => file.endsWith("Tests.swift"))
    .map((file) => file.replace(/\.swift$/, ""))
    .filter((name) => name !== SKIPPED_CLASS);
}

function coreSimulatorIsCurrent() {
  return capture("xcodebuild", ["-checkFirstLaunchStatus"], { timeout: 60_000 }).status === 0;
}

function runThroughXcodebuild(udid) {
  const filter = only
    ? [`-only-testing:${TEST_TARGET}/${only}`]
    : [`-only-testing:${TEST_TARGET}`, `-skip-testing:${TEST_TARGET}/${SKIPPED_CLASS}`];
  const xctestrun = readdirSync(PRODUCTS).find((file) => file.endsWith(".xctestrun"));
  if (!xctestrun) reportFailure("the build wrote no .xctestrun");
  const attempt = () =>
    runLogged("xcodebuild", [
      "test-without-building",
      "-xctestrun",
      resolve(PRODUCTS, xctestrun),
      "-destination",
      `platform=iOS Simulator,id=${udid}`,
      "-parallel-testing-enabled",
      "NO",
      ...filter
    ]);
  let status = attempt();
  // A launch flake of the simulator, not a test result. Seen on this suite.
  if (status !== 0 && readFileSync(LOG_PATH, "utf8").includes("failed preflight checks")) status = attempt();
  return status;
}

// xcodebuild refuses every simulator while CoreSimulator is out of date, which
// needs an administrator to fix. Loading the test bundle into the app directly
// still gives a machine in that state a real result, so a push from it is not
// stuck or untested. CI never takes this path.
function runThroughInjection(device) {
  console.warn(
    "warning: CoreSimulator is out of date, so xcodebuild sees no simulator. Fix: sudo xcodebuild -runFirstLaunch"
  );
  console.warn("warning: running the suite by injecting the test bundle into the app");
  const bootedHere = device.state !== "Booted";
  if (bootedHere) {
    simctl("boot", device.udid);
    simctl("bootstatus", device.udid, "-b");
  }
  try {
    const app = resolve(PRODUCTS, "Debug-iphonesimulator/Argmax.app");
    simctl("install", device.udid, app);
    const container = simctl("get_app_container", device.udid, BUNDLE_ID, "app").trim();
    const developer = capture("xcode-select", ["-p"]).stdout.trim();
    const platform = `${developer}/Platforms/iPhoneSimulator.platform/Developer`;
    const environment = {
      ...process.env,
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: `${platform}/usr/lib/libXCTestBundleInject.dylib`,
      SIMCTL_CHILD_DYLD_FRAMEWORK_PATH: `${platform}/Library/Frameworks:${platform}/Library/PrivateFrameworks`,
      SIMCTL_CHILD_DYLD_LIBRARY_PATH: `${platform}/usr/lib`,
      SIMCTL_CHILD_XCInjectBundleInto: `${container}/Argmax`,
      SIMCTL_CHILD_XCTestBundlePath: `${container}/PlugIns/${TEST_TARGET}.xctest`
    };
    const selection = (only ? [only] : testClasses()).map((name) => `${TEST_TARGET}.${name}`).join(",");
    const [command, prefix] = existsSync(CORE_SIMCTL) ? [CORE_SIMCTL, []] : ["xcrun", ["simctl"]];
    const status = runLogged(
      command,
      [
        ...prefix,
        "launch",
        "--console-pty",
        "--terminate-running-process",
        device.udid,
        BUNDLE_ID,
        "-XCTest",
        selection
      ],
      { env: environment, timeout: 600_000 }
    );
    if (status !== 0) return status;
    const log = readFileSync(LOG_PATH, "utf8");
    // The launch exits 0 whatever the tests did, and a crash prints no verdict.
    const verdict =
      /Test Suite '[^']+' (passed|failed) at [^\n]*\n\s*Executed \d+ tests?, with \d+ failures?[^\n]*\n[^\n]*$/m;
    if (!verdict.test(log.trimEnd().split("\n").slice(-6).join("\n"))) return 1;
    return /^Test Case .* failed \(/m.test(log) ? 1 : 0;
  } finally {
    if (bootedHere) simctl("shutdown", device.udid);
  }
}

function summarize() {
  const log = readFileSync(LOG_PATH, "utf8");
  const executed = [...log.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].at(-1);
  const failures = [...log.matchAll(/^Test Case '-\[\S+ (\S+)\]' failed/gm)].map((match) => match[1]);
  return { tests: executed?.[1] ?? "?", failed: executed?.[2] ?? "?", failures };
}

const started = Date.now();
mkdirSync(CACHE_DIR, { recursive: true });
rmSync(LOG_PATH, { force: true });

if (capture("which", ["xcodegen"]).status !== 0) fail("xcodegen is not installed. Run: brew install xcodegen");
if (runLogged("xcodegen", [], { cwd: PROJECT_DIR }) !== 0) reportFailure("xcodegen failed");

const device = testSimulator();
const buildStatus = runLogged(
  "xcodebuild",
  [
    "build-for-testing",
    "-project",
    "Argmax.xcodeproj",
    "-scheme",
    "Argmax",
    "-destination",
    "generic/platform=iOS Simulator",
    "-derivedDataPath",
    DERIVED_DATA,
    // A simulator needs no signature, and CI has no team to sign with.
    "CODE_SIGNING_ALLOWED=NO"
  ],
  { cwd: PROJECT_DIR }
);
if (buildStatus !== 0) reportFailure("the test build failed");
const builtAt = Date.now();

const status = coreSimulatorIsCurrent() ? runThroughXcodebuild(device.udid) : runThroughInjection(device);
const { tests, failed, failures } = summarize();
const seconds = (milliseconds) => (milliseconds / 1000).toFixed(0);
const timing = `build ${seconds(builtAt - started)}s, tests ${seconds(Date.now() - builtAt)}s`;
if (status !== 0) {
  for (const name of failures) console.error(`failed: ${name}`);
  reportFailure(`${failures.length} of ${tests} iOS tests failed, ${failed} assertions (${timing})`);
}
console.log(`iOS tests: ${tests} passed (${timing})`);
