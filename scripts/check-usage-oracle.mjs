#!/usr/bin/env node
// Compare Argmax's usage ledger with two independent readers of the same
// transcripts: ccusage (Claude, Codex, OpenCode) and CodexBar (Claude, Codex).
// Token totals per local day and model must match; every mismatch is printed.
// Costs are not compared, the three price from different tables.
//
//   node scripts/check-usage-oracle.mjs [--days 7] [--bin path/to/argmax]
//                                       [--tolerance 0] [--provider claude|codex]
//
// The Argmax binary reads the running app's database, so open the Usage page
// first (or wait for a sweep). ccusage and codexbar must be on PATH.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const days = Number(option("--days", "7"));
const tolerance = Number(option("--tolerance", "0"));
const onlyProvider = option("--provider", null);
const bin =
  option("--bin", null) ??
  ["release", "debug"]
    .map((profile) => path.join(here, "..", "src-tauri", "target", profile, "argmax"))
    .find((candidate) => existsSync(candidate));

if (!bin || !existsSync(bin)) {
  console.error("argmax binary not found; build it or pass --bin");
  process.exit(2);
}

const run = (file, runArgs) => {
  try {
    return execFileSync(file, runArgs, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    console.error(`${file} ${runArgs.join(" ")} failed: ${error.message}`);
    process.exit(2);
  }
};

// Argmax: [{ date, models: [{ provider, modelId, total, ... }] }]
const argmax = JSON.parse(run(bin, ["usage", "--days", String(days), "--json"]));
const argmaxByKey = new Map();
for (const day of argmax) {
  for (const model of day.models) {
    argmaxByKey.set(`${day.date}|${model.provider}|${model.modelId}`, model.total);
  }
}

// ccusage daily --json: { daily: [{ period: "YYYY-MM-DD", modelBreakdowns: [{ modelName, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens }] }] }
const since = argmax[0]?.date.replaceAll("-", "");
const ccusage = JSON.parse(run("ccusage", ["daily", "--json", "--since", since]));
const ccusageByKey = new Map();
for (const day of ccusage.daily ?? []) {
  for (const model of day.modelBreakdowns ?? []) {
    const provider = providerForModel(model.modelName);
    if (!provider) continue;
    const total =
      (model.inputTokens ?? 0) +
      (model.outputTokens ?? 0) +
      (model.cacheCreationTokens ?? 0) +
      (model.cacheReadTokens ?? 0);
    const key = `${day.period}|${provider}|${normalizeModel(model.modelName)}`;
    ccusageByKey.set(key, (ccusageByKey.get(key) ?? 0) + total);
  }
}

// codexbar cost --provider both --format json: [{ provider, daily: [{ date, modelBreakdowns: [{ modelName, totalTokens }] }] }]
const codexbar = JSON.parse(run("codexbar", ["cost", "--provider", "both", "--format", "json"]));
const codexbarByKey = new Map();
for (const entry of Array.isArray(codexbar) ? codexbar : [codexbar]) {
  const provider = entry.provider === "claude" ? "claude" : entry.provider === "codex" ? "codex" : null;
  if (!provider) continue;
  for (const day of entry.daily ?? []) {
    for (const model of day.modelBreakdowns ?? []) {
      const key = `${day.date}|${provider}|${normalizeModel(model.modelName)}`;
      codexbarByKey.set(key, (codexbarByKey.get(key) ?? 0) + (model.totalTokens ?? 0));
    }
  }
}

const keys = new Set([...argmaxByKey.keys(), ...ccusageByKey.keys(), ...codexbarByKey.keys()]);
const rows = [];
let mismatches = 0;
for (const key of [...keys].sort()) {
  const [date, provider, model] = key.split("|");
  if (!["claude", "codex"].includes(provider)) continue;
  if (onlyProvider && provider !== onlyProvider) continue;
  if (!argmax.some((day) => day.date === date)) continue;
  const ours = argmaxByKey.get(key) ?? 0;
  const theirs = [ccusageByKey.get(key), codexbarByKey.get(key)];
  const worst = Math.max(...theirs.filter((value) => value !== undefined).map((value) => Math.abs(value - ours)));
  const bad = Number.isFinite(worst) && worst > tolerance * Math.max(ours, 1);
  if (bad) mismatches += 1;
  rows.push({ date, provider, model, argmax: ours, ccusage: theirs[0] ?? "-", codexbar: theirs[1] ?? "-", status: bad ? "MISMATCH" : "ok" });
}
console.table(rows);
console.log(`${rows.length} day/model rows, ${mismatches} mismatches, tolerance ${tolerance}`);
process.exit(mismatches === 0 ? 0 : 1);

function providerForModel(modelName) {
  if (modelName.startsWith("claude")) return "claude";
  if (modelName.startsWith("gpt") || modelName.startsWith("codex") || modelName.startsWith("o")) return "codex";
  return null;
}

function normalizeModel(modelName) {
  // Strip a trailing -YYYYMMDD date suffix, as pricing.rs does.
  return modelName.replace(/-\d{8}$/, "");
}
