// Reporting for scripts/bench-latency.mjs: turns saved result JSON into metrics,
// and prints the run table, the target scoreboard, and the A/B compare table.
// It also checks and updates the ratchet record. Nothing here launches an app.
//
// A metric id is the row name the run table prints, plus `:<field>` for the
// navigation rows, which carry several fields: `session.switch.first-visit:settled`.
// targets.json and record.json use the same ids.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const targetsPath = path.join(here, "targets.json");
export const recordPath = path.join(here, "record.json");

// The real-turn stamps the bench reports, as offsets from the renderer's submit (the click).
export const realStamps = ["checkpoint_end", "spawn", "prompt_written", "first_painted"];

export const percentile = (values, fraction) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
    : null;
};

const median = (values) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

const withValues = (values) => {
  const kept = values.filter((value) => value != null);
  return { n: kept.length, values: kept, p50: percentile(kept, 0.5), p95: percentile(kept, 0.95) };
};

// Click-relative stamps of one real turn waterfall row, or null without a submit stamp.
export function realOffsets(row) {
  const stamps = Object.fromEntries(
    (row?.stamps ?? []).map((stamp) => [stamp.name, stamp.offsetMs]),
  );
  if (stamps.submit == null) return null;
  return Object.fromEntries(
    realStamps.map((name) => [
      name,
      stamps[name] == null ? null : Math.round(stamps[name] - stamps.submit),
    ]),
  );
}

// Map of metric id -> { n, p50, p95, values? }. Navigation keeps only its
// summaries, so its entries have no values.
export function metricsOf(result) {
  const metrics = new Map();
  if (result.boot) {
    metrics.set("boot.ready-to-show", withValues(result.boot.map((b) => b.readyToShow)));
    metrics.set("boot.first-paint", withValues(result.boot.map((b) => b.firstPaint)));
  }
  // A scenario that errored keeps empty entries, so the scoreboard reports it as no data.
  for (const scenario of result.navigation ?? []) {
    for (const field of ["shown", "painted", "settled"]) {
      metrics.set(`${scenario.name}:${field}`, {
        n: scenario.n,
        p50: scenario[`${field}_p50`],
        p95: scenario[`${field}_p95`],
      });
    }
    metrics.set(`${scenario.name}:gap`, { n: scenario.n, p50: null, p95: scenario.maxGap_p95 });
  }
  for (const kind of ["newChat", "followUp"]) {
    const runs = result.send?.[kind] ?? [];
    if (!runs.length) continue;
    metrics.set(`send.${kind}.ack`, withValues(runs.map((r) => r.ack)));
    metrics.set(`send.${kind}.first-text`, withValues(runs.map((r) => r.firstText)));
  }
  const waterfalls = (result.appPerf?.turnWaterfalls ?? []).filter(
    (row) => row.provider === "claude",
  );
  const steps = new Map();
  for (const row of waterfalls)
    for (const stamp of row.stamps)
      (steps.get(stamp.name) ?? steps.set(stamp.name, []).get(stamp.name)).push(
        Math.round(stamp.offsetMs),
      );
  for (const [name, offsets] of steps) metrics.set(`turn.${name}`, withValues(offsets));
  for (const kind of ["newChat", "followUp"]) {
    const turns = (result.real ?? []).map((round) => round[kind]).filter(Boolean);
    if (!turns.length) continue;
    for (const name of realStamps)
      metrics.set(`real.${kind}.${name}`, withValues(turns.map((turn) => turn[name])));
  }
  return metrics;
}

// Rounds of one side pooled into one entry. Rows with raw values pool the
// values; navigation rows only have summaries, so they take the median of the
// round p50s and the max of the round p95s.
export function pool(entries) {
  const present = entries.filter(Boolean);
  if (!present.length) return null;
  if (present.every((entry) => entry.values))
    return withValues(present.flatMap((entry) => entry.values));
  const p95s = present.map((entry) => entry.p95).filter((value) => value != null);
  return {
    n: present.reduce((sum, entry) => sum + (entry.n ?? 0), 0),
    p50: median(present.map((entry) => entry.p50)),
    p95: p95s.length ? Math.max(...p95s) : null,
  };
}

export function statOf(entry, stat) {
  if (!entry) return null;
  if (stat === "p50" || stat === "p95") {
    if (entry.values) return percentile(entry.values, stat === "p50" ? 0.5 : 0.95);
    return Number.isFinite(entry[stat]) ? entry[stat] : null;
  }
  const match = /^p(\d{1,2})$/.exec(stat);
  return match && entry.values ? percentile(entry.values, Number(match[1]) / 100) : null;
}

export function loadTargets() {
  return JSON.parse(readFileSync(targetsPath, "utf8")).targets;
}

export function status(value, target) {
  if (value == null) return "no data";
  if (value <= target) return "meets";
  return value <= target * 1.5 ? "within 1.5x" : "misses";
}

const write = (line) => process.stdout.write(`${line}\n`);
const cells = (row, widths) =>
  row
    .map((cell, i) =>
      i ? String(cell ?? "").padStart(widths[i]) : String(cell ?? "").padEnd(widths[i]),
    )
    .join("  ");
function printRows(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(String(h).length, ...rows.map((row) => String(row[i] ?? "").length)),
  );
  write(cells(header, widths));
  for (const row of rows) write(cells(row, widths));
}

export function printTable(result) {
  const rows = [];
  if (result.boot) {
    const boot = result.boot;
    rows.push([
      "boot.ready-to-show",
      boot.length,
      percentile(
        boot.map((b) => b.readyToShow),
        0.5,
      ),
      percentile(
        boot.map((b) => b.readyToShow),
        0.95,
      ),
    ]);
    rows.push([
      "boot.first-paint",
      boot.length,
      percentile(
        boot.map((b) => b.firstPaint),
        0.5,
      ),
      percentile(
        boot.map((b) => b.firstPaint),
        0.95,
      ),
    ]);
  }
  for (const scenario of result.navigation ?? []) {
    if (scenario.error) rows.push([scenario.name, "ERR", scenario.error.slice(0, 60)]);
    else
      rows.push([
        scenario.name,
        scenario.n,
        scenario.shown_p50,
        scenario.shown_p95,
        scenario.painted_p50,
        scenario.painted_p95,
        scenario.settled_p50,
        scenario.settled_p95,
        scenario.maxGap_p95,
        scenario.ipc_avg,
      ]);
  }
  const metrics = metricsOf(result);
  for (const [id, entry] of metrics) {
    if (/^(send|turn|real)\./.test(id)) rows.push([id, entry.n, entry.p50, entry.p95]);
  }
  const header = [
    "metric",
    "n",
    "shown50",
    "shown95",
    "paint50",
    "paint95",
    "settl50",
    "settl95",
    "gap95",
    "ipc",
  ];
  write(`${header.map((h, i) => (i ? h.padStart(8) : h.padEnd(40))).join("")}`);
  for (const row of rows)
    write(
      `${row.map((cell, i) => (i ? String(cell ?? "").padStart(8) : String(cell).padEnd(40))).join("")}`,
    );
}

export function printScoreboard(metrics, targets = loadTargets()) {
  const measured = Object.entries(targets).filter(([id]) => metrics.has(id));
  const rows = measured.map(([id, target]) => {
    const value = statOf(metrics.get(id), target.stat);
    return [id, target.stat, value ?? "-", `<= ${target.ms}`, status(value, target.ms)];
  });
  write("\nscoreboard (targets: scripts/bench-latency/targets.json)");
  printRows(["metric", "stat", "value", "target", "status"], rows);
  const count = (word) => rows.filter((row) => row[4] === word).length;
  const skipped = Object.keys(targets).length - measured.length;
  write(
    `${count("meets")} meet, ${count("within 1.5x")} within 1.5x, ${count("misses")} miss, ${count("no data")} no data${skipped ? `; ${skipped} targets not measured by this run` : ""}`,
  );
}

export function printCompare(sideA, sideB, targets = loadTargets()) {
  const metricsA = sideA.map(metricsOf);
  const metricsB = sideB.map(metricsOf);
  const ids = [...new Set([...metricsA, ...metricsB].flatMap((metrics) => [...metrics.keys()]))];
  const rows = [];
  for (const id of ids) {
    // Frame-gap rows carry only a p95; they show and compare that instead.
    const stat = [...metricsA, ...metricsB].some((metrics) => metrics.get(id)?.p50 != null)
      ? "p50"
      : "p95";
    const roundValues = (side) => side.map((metrics) => metrics.get(id)?.[stat] ?? "-").join("/");
    const pooledA = pool(metricsA.map((metrics) => metrics.get(id)));
    const pooledB = pool(metricsB.map((metrics) => metrics.get(id)));
    const delta =
      pooledA?.[stat] != null && pooledB?.[stat] != null ? pooledB[stat] - pooledA[stat] : null;
    const target = targets[id];
    const value = target ? statOf(pooledB, target.stat) : null;
    rows.push([
      stat === "p50" ? id : `${id} (p95)`,
      roundValues(metricsA),
      roundValues(metricsB),
      delta == null
        ? "-"
        : `${delta > 0 ? "+" : ""}${delta}${pooledA[stat] ? ` (${delta > 0 ? "+" : ""}${Math.round((100 * delta) / pooledA[stat])}%)` : ""}`,
      target ? `${target.stat} ${value ?? "-"} <= ${target.ms}` : "",
      target ? status(value, target.ms) : "",
    ]);
  }
  const describe = (side) =>
    side.map((result) => result.label ?? path.basename(result.binary ?? "?")).join(",");
  write(
    `\ncompare: A = ${describe(sideA)} (${sideA.length} runs), B = ${describe(sideB)} (${sideB.length} runs)`,
  );
  write(
    "columns A and B: p50 of each round (p95 for rows marked p95). delta: B - A of the pooled value. Pooled: raw values where the run keeps them (boot, send, turn, real);",
  );
  write(
    "navigation keeps only per-scenario summaries, so its pooled p50 is the median of the round p50s and its pooled p95 the max of the round p95s.",
  );
  printRows(["metric", "A per round", "B per round", "delta", "B target", "B status"], rows);
}

// Today's measured noise: revisit settled moved ~130 ms between identical runs,
// so the ratchet compares p50, not p95, and allows max(20%, 34 ms) before it
// calls a move a regression.
export const regressionAllowance = (recorded) => Math.max(0.2 * recorded, 34);

export function loadRecord() {
  return JSON.parse(readFileSync(recordPath, "utf8"));
}

// Returns the regressions as strings; empty means the check passed.
export function checkRecord(metrics, record) {
  const regressions = [];
  for (const [id, entry] of Object.entries(record.metrics)) {
    const value = metrics.get(id)?.p50;
    if (value == null) continue;
    if (value - entry.p50 > regressionAllowance(entry.p50)) {
      regressions.push(
        `${id}: p50 ${value} ms vs record ${entry.p50} ms (allowed +${Math.round(regressionAllowance(entry.p50))} ms)`,
      );
    }
  }
  return regressions;
}

// Writes improved and new metrics; a worse value replaces a record only when
// `loosen` names it. Returns the ids it changed.
export function updateRecord(metrics, record, { loosen, machine, commit }) {
  for (const id of loosen)
    if (metrics.get(id)?.p50 == null)
      throw new Error(`--loosen ${id}: no p50 for that metric in these results`);
  const changed = [];
  const recordedAt = new Date().toISOString();
  for (const [id, entry] of metrics) {
    if (entry.p50 == null) continue;
    const previous = record.metrics[id];
    if (previous && entry.p50 >= previous.p50 && !(loosen.includes(id) && entry.p50 > previous.p50))
      continue;
    record.metrics[id] = { p50: entry.p50, n: entry.n, commit, recordedAt };
    changed.push(previous ? `${id}: ${previous.p50} -> ${entry.p50}` : `${id}: new ${entry.p50}`);
  }
  if (changed.length) {
    record.machine = machine;
    record.metrics = Object.fromEntries(
      Object.entries(record.metrics).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  return changed;
}
