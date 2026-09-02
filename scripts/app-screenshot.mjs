#!/usr/bin/env node
// Screenshot a real Argmax window — pixel truth, native chrome included.
//
// The browser path (scripts/ui-screenshot.mjs) covers most look-verification;
// this is the final rung for anything only the real app shows: the traffic
// lights, native dialogs, the actual WKWebView rendering. Window discovery
// uses a Swift one-liner over CGWindowList (Xcode CLT is already required to
// build the app), capture is plain `screencapture -l`.
//
// Usage:
//   node scripts/app-screenshot.mjs [--out shot.png] [--pid <app pid>]
//
// --pid picks one instance when both the real app and a scratch instance
// (scripts/scratch-app.mjs prints its pid) are running; otherwise the
// frontmost Argmax window wins.
//
// Requires the Screen Recording permission for whatever runs this script
// (System Settings → Privacy & Security → Screen Recording). Off-space or
// minimized windows may not be capturable.

import { spawnSync } from "node:child_process";
import path from "node:path";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const options = { out: "app-screenshot.png", pid: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--out") options.out = argv[++i];
  else if (argv[i] === "--pid") options.pid = Number(argv[++i]);
  else fail(`unknown argument: ${argv[i]}`);
}

const swiftSource = `
import CoreGraphics
import Foundation
guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { exit(2) }
for window in list {
    // A packaged build reports "Argmax"; a debug binary (scripts/scratch-app.mjs)
    // reports its executable name, "argmax".
    guard let owner = window["kCGWindowOwnerName"] as? String, owner.lowercased() == "argmax",
          let layer = window["kCGWindowLayer"] as? Int, layer == 0,
          let id = window["kCGWindowNumber"] as? Int,
          let pid = window["kCGWindowOwnerPID"] as? Int else { continue }
    print("\\(id) \\(pid)")
}
`;
const lookup = spawnSync("swift", ["-"], { input: swiftSource, encoding: "utf8" });
if (lookup.status !== 0) fail(`window lookup failed: ${lookup.stderr}`);
const windows = lookup.stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [windowId, pid] = line.split(" ").map(Number);
    return { windowId, pid };
  });
if (windows.length === 0) fail("no on-screen Argmax window found");
const target = options.pid === null ? windows[0] : windows.find((window) => window.pid === options.pid);
if (!target) {
  fail(
    `no on-screen Argmax window for pid ${options.pid} (found pids: ${windows.map((w) => w.pid).join(", ")});` +
      ` a window on another Space is not capturable`
  );
}

const out = path.resolve(options.out);
const capture = spawnSync("screencapture", ["-o", "-x", "-l", String(target.windowId), out], { encoding: "utf8" });
if (capture.status !== 0 || /could not create image/.test(capture.stderr)) {
  fail(
    `screencapture failed: ${capture.stderr.trim() || "no image"}\n` +
      `most likely the Screen Recording permission is missing for the app running this script\n` +
      `(System Settings → Privacy & Security → Screen Recording), and macOS needs an app restart after granting it.`
  );
}
console.log(JSON.stringify({ out, windowId: target.windowId, pid: target.pid }));
