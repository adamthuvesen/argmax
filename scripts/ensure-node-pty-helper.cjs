const { chmodSync, existsSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const nodePtyDir = join(__dirname, "..", "node_modules", "node-pty");
const candidates = [
  join(nodePtyDir, "build", "Release", "spawn-helper"),
  ...spawnHelpersInPrebuilds(join(nodePtyDir, "prebuilds"))
];

for (const candidate of candidates) {
  if (!existsSync(candidate)) {
    continue;
  }

  const mode = statSync(candidate).mode;
  chmodSync(candidate, mode | 0o755);
}

function spawnHelpersInPrebuilds(prebuildsDir) {
  if (!existsSync(prebuildsDir)) {
    return [];
  }

  return readdirSync(prebuildsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(prebuildsDir, entry.name, "spawn-helper"));
}
