#!/usr/bin/env node
// Build ios/Argmax and put it on a physical iPhone: regenerate the project,
// build, install, launch, and confirm the process is alive. Xcode's device
// list and devicectl's disagree often enough that `-destination id=<udid>`
// fails on a phone devicectl can see, so this builds for a generic iOS
// device and lets devicectl own the connection.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectDir = path.join(repoRoot, "ios/Argmax");
const bundleId = "com.argmax.remote";

function usage() {
  console.log(`Usage: npm run install:ios -- [options]

  --device <udid>   target device (default: the only connected one)
  --team <id>       DEVELOPMENT_TEAM (default: $ARGMAX_IOS_TEAM, else the
                    team on an installed ${bundleId} provisioning profile)
  --pair <link>     launch with argmax://pair so the phone re-pairs
  --no-launch       install only
  --list            print connected devices and exit
`);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

function run(file, argv, options = {}) {
  return execFileSync(file, argv, { encoding: "utf8", ...options });
}

function connectedDevices() {
  const output = run("xcrun", ["devicectl", "list", "devices", "--quiet", "--json-output", "-"]);
  return (JSON.parse(output).result?.devices ?? [])
    .filter((device) => device.connectionProperties?.tunnelState !== "unavailable")
    .map((device) => ({
      // devicectl addresses devices by its own identifier, not the hardware UDID.
      udid: device.identifier,
      name: device.deviceProperties?.name ?? "unnamed",
      model: device.hardwareProperties?.marketingName ?? ""
    }))
    .filter((device) => device.udid);
}

function resolveDevice() {
  const wanted = flag("--device");
  const devices = connectedDevices();
  if (wanted) {
    const match = devices.find((device) => device.udid === wanted);
    if (!match) throw new Error(`device ${wanted} is not connected. Connected: ${devices.map((d) => d.udid).join(", ") || "none"}`);
    return match;
  }
  if (devices.length === 0) throw new Error("no iPhone connected. Plug it in, unlock it, and trust this Mac.");
  if (devices.length > 1) {
    throw new Error(`${devices.length} devices connected; pass --device <udid>:\n${devices.map((d) => `  ${d.udid}  ${d.name}`).join("\n")}`);
  }
  return devices[0];
}

// Xcode's managed profiles carry the team, so a machine that has ever built
// this app does not need the id spelled out again.
function teamFromProvisioningProfiles() {
  const profileDir = path.join(process.env.HOME ?? "", "Library/Developer/Xcode/UserData/Provisioning Profiles");
  let names;
  try {
    names = run("ls", [profileDir]).split("\n").filter((name) => name.endsWith(".mobileprovision"));
  } catch {
    return undefined;
  }
  const teams = new Set();
  for (const name of names) {
    let plist;
    try {
      plist = run("security", ["cms", "-D", "-i", path.join(profileDir, name)], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (!plist.includes(bundleId)) continue;
    const team = /<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (team) teams.add(team[1]);
  }
  return teams.size === 1 ? [...teams][0] : undefined;
}

function resolveTeam() {
  const team = flag("--team") ?? process.env.ARGMAX_IOS_TEAM ?? teamFromProvisioningProfiles();
  if (!team) {
    throw new Error("no development team. Pass --team <id>, set ARGMAX_IOS_TEAM, or sign in and build once from Xcode.");
  }
  return team;
}

function builtProductsDir(team) {
  const settings = JSON.parse(
    run("xcodebuild", [
      "-project", "Argmax.xcodeproj", "-scheme", "Argmax",
      "-destination", "generic/platform=iOS", "-showBuildSettings", "-json",
      `DEVELOPMENT_TEAM=${team}`
    ], { cwd: projectDir, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 })
  );
  const dir = settings.find((entry) => entry.target === "Argmax")?.buildSettings?.BUILT_PRODUCTS_DIR;
  if (!dir) throw new Error("xcodebuild did not report BUILT_PRODUCTS_DIR for the Argmax target");
  return dir;
}

function main() {
  if (args.includes("--list")) {
    const devices = connectedDevices();
    console.log(devices.length ? devices.map((d) => `${d.udid}  ${d.name} (${d.model})`).join("\n") : "no devices connected");
    return;
  }

  const device = resolveDevice();
  const team = resolveTeam();
  console.log(`→ ${device.name} (${device.model})  team ${team}`);

  run("xcodegen", [], { cwd: projectDir, stdio: "inherit" });
  run("xcodebuild", [
    "-project", "Argmax.xcodeproj", "-scheme", "Argmax",
    "-destination", "generic/platform=iOS",
    "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration",
    `DEVELOPMENT_TEAM=${team}`, "-quiet", "build"
  ], { cwd: projectDir, stdio: "inherit" });

  const app = path.join(builtProductsDir(team), "Argmax.app");
  run("xcrun", ["devicectl", "device", "install", "app", "--device", device.udid, app], { stdio: "inherit" });

  if (args.includes("--no-launch")) {
    console.log("installed; not launching");
    return;
  }

  const pairLink = flag("--pair");
  const payload = pairLink ? ["--payload-url", `argmax://pair?url=${encodeURIComponent(pairLink)}`] : [];
  run("xcrun", ["devicectl", "device", "process", "launch", "--terminate-existing", "--device", device.udid, ...payload, bundleId], {
    stdio: "inherit"
  });

  // There is no way to screenshot a physical device, so the answer to "did it
  // work?" comes from the host: the process list, and the bridge's clients.
  const processes = run("xcrun", ["devicectl", "device", "info", "processes", "--device", device.udid], {
    stdio: ["ignore", "pipe", "ignore"]
  });
  const running = processes.split("\n").some((line) => line.includes("Argmax.app/Argmax"));
  let clients = "";
  try {
    clients = run("/bin/sh", ["-c", "lsof -nP -iTCP:8790 | grep -c ESTABLISHED"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    clients = "0";
  }
  console.log(running ? `running on ${device.name}; ${clients} bridge client(s) on 8790` : "launched, but no Argmax process on the device");
  if (!running) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
