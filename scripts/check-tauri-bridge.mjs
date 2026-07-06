#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHANNELS = join(ROOT, "src-tauri/tests/fixtures/channels.txt");
const BRIDGE = join(ROOT, "src/renderer/lib/tauriBridge.ts");

function uniq(values) {
  return [...new Set(values)].sort();
}

function diff(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

const fixtureChannels = readFileSync(CHANNELS, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const bridge = readFileSync(BRIDGE, "utf8");
const invokedChannels = uniq(
  [...bridge.matchAll(/invokeCommand(?:<[^>]+>)?\(\s*"([^"]+)"/g)].map((match) => match[1])
);

const duplicateFixtureChannels = fixtureChannels.filter(
  (channel, index) => fixtureChannels.indexOf(channel) !== index
);
const missing = diff(fixtureChannels, invokedChannels);
const extra = diff(invokedChannels, fixtureChannels);

if (duplicateFixtureChannels.length || missing.length || extra.length) {
  console.error("error: Tauri bridge request channels drifted from channels.txt");
  if (duplicateFixtureChannels.length) {
    console.error(`duplicate fixture channels: ${uniq(duplicateFixtureChannels).join(", ")}`);
  }
  if (missing.length) {
    console.error(`missing from bridge: ${missing.join(", ")}`);
  }
  if (extra.length) {
    console.error(`extra in bridge: ${extra.join(", ")}`);
  }
  process.exit(1);
}

const expectedPushChannels = [
  "dashboard:delta",
  "mcp:auth:data",
  "mcp:auth:exit",
  "menu:command",
  "terminal:data",
  "terminal:exit"
];
const subscribedChannels = uniq(
  [...bridge.matchAll(/subscribe(?:<[^>]+>)?\(\s*"([^"]+)"/g)].map((match) => match[1])
);
const missingPushChannels = diff(expectedPushChannels, subscribedChannels);

if (missingPushChannels.length) {
  console.error("error: Tauri bridge is missing push-event subscriptions");
  console.error(`missing push channels: ${missingPushChannels.join(", ")}`);
  process.exit(1);
}

console.log(
  `ok: tauriBridge.ts covers ${fixtureChannels.length} request channels and ${expectedPushChannels.length} push channels.`
);
