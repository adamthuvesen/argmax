#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

// Transport exposure is declared alongside the typed command registration.
const catalogue = readFileSync("src-tauri/src/ipc/catalogue.rs", "utf8");
const reads = [...catalogue.matchAll(/"([^"]+)"\s*=>\s*\w+::\w+,\s*read,/g)].map(match => match[1]);
if (!reads.length) throw new Error("No read contracts found in IPC catalogue");
// This delta cursor belongs to the WebSocket connection, not to desktop IPC.
reads.push("dashboard:changes");
const path = "src/shared/remoteReadChannels.json";
const content = `${JSON.stringify(reads.sort(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== content) {
    console.error(`Stale ${path}. Run npm run generate:contracts.`);
    process.exit(1);
  }
  console.log(`ok: ${reads.length} remote read contracts`);
} else {
  writeFileSync(path, content);
  console.log(`wrote ${path}`);
}
