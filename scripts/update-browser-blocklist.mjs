#!/usr/bin/env node
// Refresh the separately licensed ruleset from one immutable upstream commit.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const revision = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(revision ?? "")) {
  console.error("usage: node scripts/update-browser-blocklist.mjs <full HaGeZi commit SHA>");
  process.exit(2);
}

try {
  const base = `https://raw.githubusercontent.com/hagezi/dns-blocklists/${revision}/`;
  const download = async (name) => {
    const response = await fetch(new URL(name, base), { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(`${name} exceeds the 4 MiB limit`);
    return text;
  };
  const [source, license] = await Promise.all([download("adblock/light.txt"), download("LICENSE")]);
  const domains = source.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("!") && line !== "[Adblock Plus]");
  if (domains.length < 1_000 || domains.length > 100_000 || domains.some((line) => !/^\|\|[a-z0-9-]+(?:\.[a-z0-9-]+)+\^$/.test(line))) {
    throw new Error("The upstream list changed format or has an unexpected domain count");
  }
  if (!license.includes("GNU GENERAL PUBLIC LICENSE") || !license.includes("Version 3, 29 June 2007")) {
    throw new Error("The upstream license changed; review it before updating");
  }
  const destination = new URL("../assets/browser-blocking/", import.meta.url);
  const provenance = {
    name: "HaGeZi Multi LIGHT", revision,
    source: new URL("adblock/light.txt", base).href,
    license: "GPL-3.0", domains: domains.length,
    sha256: createHash("sha256").update(source).digest("hex")
  };
  await mkdir(destination, { recursive: true });
  await writeFile(new URL("light.txt", destination), source);
  await writeFile(new URL("COPYING", destination), license);
  await writeFile(new URL("source.json", destination), JSON.stringify(provenance, null, 2) + "\n");
  console.log(`Updated HaGeZi Multi LIGHT: ${domains.length} domains at ${revision}`);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
