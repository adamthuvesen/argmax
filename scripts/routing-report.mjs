#!/usr/bin/env node
// Auto routing report: how the routing grid behaved on real chats.
//
// Phase 6 of docs/plan/auto-model-routing.md. Joins `turn_routes` (every
// routing decision) with `usage_events` (what each chat was billed), so a
// week of use can tune the grid: which cells cost what, how often follow-ups
// re-route or escalate, which chats the user pinned by hand, and whether Goals
// on Auto chats were met. Reads the database read-only.
//
// Usage:
//   node scripts/routing-report.mjs [--days 7] [--json] [--data-dir <dir>]
//
// Profile resolution, first match wins (same as scripts/bridge.mjs):
//   --data-dir <dir>              that profile
//   $ARGMAX_DATA_DIR              same, via the environment
//   the real app profile          ~/Library/Application Support/com.argmax.rs
// The database is <dataDir>/local-state/argmax.sqlite.
//
// A chat's cell is its first route row (a launch, or a fallback when Jev was
// unreachable); the window selects chats by that row's time. Cost is every
// usage event those chats billed, whichever model billed it. Cursor has no
// billing in Argmax, so Cursor usage shows as "unpriced", never $0.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { realProfileDataDir } from "./bridge-client.mjs";

function fail(message) {
  console.error(`routing-report: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = { days: "7", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--days" || arg === "--data-dir") {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} requires a value`);
      flags[arg.slice(2)] = value;
    } else {
      fail(`unknown argument ${arg} (usage: routing-report.mjs [--days N] [--json] [--data-dir <dir>])`);
    }
  }
  if (!/^[1-9]\d*$/.test(flags.days)) fail(`--days must be a positive integer, got ${flags.days}`);
  return flags;
}

/** Run one read-only query through the sqlite3 CLI; `:since` is bound. */
function query(databasePath, since, sql) {
  const uri = `file:${databasePath}?mode=ro`;
  const result = spawnSync("sqlite3", ["-json", "-cmd", `.parameter set :since '${since}'`, uri, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") fail("sqlite3 is not installed or not on PATH");
  if (result.error) fail(`sqlite3 failed: ${result.error.message}`);
  if (result.status !== 0) fail(`query failed on ${databasePath}: ${result.stderr.trim() || `exit ${result.status}`}`);
  const text = result.stdout.trim();
  return text ? JSON.parse(text) : [];
}

// Sessions launched through Auto in the window, with their launch route.
const LAUNCH_SQL = `
WITH first_route AS (
  SELECT session_id, MIN(id) AS id FROM turn_routes GROUP BY session_id
)
SELECT r.session_id, r.created_at, r.tier, r.provider, r.model_id, r.reasoning_effort,
       r.kind, r.difficulty, r.decision, s.auto_tier AS current_auto_tier
FROM first_route f
JOIN turn_routes r ON r.id = f.id
JOIN sessions s ON s.id = r.session_id
WHERE r.created_at >= :since
ORDER BY r.created_at`;

// Sessions whose first route row falls in the window.
const WINDOW_SESSIONS = `
  SELECT session_id FROM turn_routes GROUP BY session_id HAVING MIN(created_at) >= :since
`;

const ROUTES_SQL = `
SELECT r.session_id, r.provider, r.decision, r.reason
FROM turn_routes r
WHERE r.session_id IN (
${WINDOW_SESSIONS})
ORDER BY r.id`;

const USAGE_SQL = `
SELECT u.session_id, s.provider, u.model_id,
       SUM(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) AS tokens,
       SUM(u.cost_usd) AS cost_usd
FROM usage_events u
JOIN sessions s ON s.id = u.session_id
WHERE u.session_id IN (
${WINDOW_SESSIONS})
GROUP BY u.session_id, s.provider, u.model_id`;

const GOALS_SQL = `
SELECT g.session_id, g.state, g.turns
FROM goals g
WHERE g.session_id IN (
${WINDOW_SESSIONS})`;

function cellKey(launch) {
  if (launch.decision === "fallback") return `${launch.tier} × unrouted`;
  return `${launch.tier} × ${launch.kind} × ${launch.difficulty}`;
}

function routedTo(launch) {
  return `${launch.model_id} · ${launch.reasoning_effort ?? "—"}`;
}

/** The part of a follow-up reason after the classifier summary and its notes. */
function keptWhy(reason) {
  const tail = reason.match(/^[^;(]*?(?: \([^)]*\))?; (.*)$/);
  if (tail) return tail[1];
  if (reason.includes("top of the")) return "reported wrong, but at the top of the ladder";
  return "already on the routed model";
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function buildReport({ days, since, launches, routes: allRoutes, usage, goals }) {
  // A `pinned` row marks the user taking a chat off Auto: not a routed turn.
  const routes = allRoutes.filter((route) => route.decision !== "pinned");
  const pins = allRoutes.length - routes.length;
  const turnsBySession = new Map();
  for (const route of routes) turnsBySession.set(route.session_id, (turnsBySession.get(route.session_id) ?? 0) + 1);

  const usageBySession = new Map();
  for (const row of usage) {
    if (!usageBySession.has(row.session_id)) usageBySession.set(row.session_id, []);
    usageBySession.get(row.session_id).push(row);
  }

  const cells = new Map();
  for (const launch of launches) {
    const key = cellKey(launch);
    if (!cells.has(key)) {
      cells.set(key, { cell: key, routedTo: routedTo(launch), sessions: 0, turns: 0, overrides: 0, pricedSessions: 0, costUsd: 0, unpricedTokens: 0, billedBy: {} });
    }
    const cell = cells.get(key);
    cell.sessions += 1;
    cell.turns += turnsBySession.get(launch.session_id) ?? 0;
    if (launch.current_auto_tier === null) cell.overrides += 1;
    let priced = false;
    for (const row of usageBySession.get(launch.session_id) ?? []) {
      const billed = (cell.billedBy[row.model_id] ??= { costUsd: 0, tokens: 0, unpriced: false });
      billed.tokens += row.tokens;
      if (row.provider === "cursor") {
        billed.unpriced = true;
        cell.unpricedTokens += row.tokens;
      } else {
        billed.costUsd += row.cost_usd;
        cell.costUsd += row.cost_usd;
        priced = true;
      }
    }
    if (priced) cell.pricedSessions += 1;
  }
  for (const cell of cells.values()) {
    cell.costPerSessionUsd = cell.pricedSessions ? cell.costUsd / cell.pricedSessions : null;
  }

  // Rows arrive in id order, so a session's first row is its launch route.
  const launchedSessions = new Set();
  const followUps = routes.filter((route) => launchedSessions.has(route.session_id) || !launchedSessions.add(route.session_id));
  const decisionCount = (decision) => followUps.filter((route) => route.decision === decision).length;
  const fallbacks = routes.filter((route) => route.decision === "fallback").length;

  const goalCounts = { met: 0, notMet: 0, active: 0, sessions: new Set(goals.map((goal) => goal.session_id)).size };
  for (const goal of goals) {
    if (goal.state === "achieved") goalCounts.met += 1;
    else if (goal.state === "active") goalCounts.active += 1;
    else goalCounts.notMet += 1;
  }

  return {
    window: { days, since },
    autoSessions: launches.length,
    routedTurns: routes.length,
    fallbacks: { count: fallbacks, share: routes.length ? fallbacks / routes.length : 0 },
    cells: [...cells.values()].sort((a, b) => b.sessions - a.sessions || a.cell.localeCompare(b.cell)),
    followUps: {
      reroute: decisionCount("reroute"),
      escalate: decisionCount("escalate"),
      kept: decisionCount("kept"),
      fallback: decisionCount("fallback"),
      pinned: pins,
      keptReasons: countBy(followUps.filter((route) => route.decision === "kept"), (route) => keptWhy(route.reason)),
      escalationsByProvider: countBy(followUps.filter((route) => route.decision === "escalate"), (route) => route.provider),
    },
    overrides: {
      total: launches.filter((launch) => launch.current_auto_tier === null).length,
      byCell: [...cells.values()].filter((cell) => cell.overrides > 0).map((cell) => ({ cell: cell.cell, overrides: cell.overrides, sessions: cell.sessions })),
    },
    goals: goalCounts,
  };
}

function formatUsd(value) {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

function formatCost(cell, value) {
  if (cell.unpricedTokens > 0 && cell.pricedSessions === 0) return "unpriced";
  if (value === null) return "–";
  return cell.unpricedTokens > 0 ? `${formatUsd(value)} + unpriced` : formatUsd(value);
}

function table(headers, rows, rightAligned = new Set()) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => String(row[column]).length)));
  const line = (cells) =>
    cells.map((cell, column) => (rightAligned.has(column) ? String(cell).padStart(widths[column]) : String(cell).padEnd(widths[column]))).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "─".repeat(width))), ...rows.map(line)].map((text) => `  ${text}`).join("\n");
}

function percent(share) {
  return `${(share * 100).toFixed(1)}%`;
}

function renderText(report, databasePath) {
  const out = [];
  out.push(`Auto routing report · last ${report.window.days} days (since ${report.window.since})`);
  out.push(`  database        ${databasePath}`);
  out.push(`  Auto sessions   ${report.autoSessions}`);
  out.push(`  routed turns    ${report.routedTurns}`);
  out.push(`  fallbacks       ${report.fallbacks.count} (${percent(report.fallbacks.share)} of turns; Jev unavailable)`);
  if (report.autoSessions === 0) {
    out.push("", "No Auto sessions in this window.");
    return out.join("\n");
  }

  out.push("", "Grid cells (tier × kind × difficulty, from each chat's launch route)");
  out.push(
    table(
      ["cell", "routed to", "sessions", "turns", "cost", "$/session"],
      report.cells.map((cell) => [cell.cell, cell.routedTo, cell.sessions, cell.turns, formatCost(cell, cell.pricedSessions ? cell.costUsd : null), formatCost(cell, cell.costPerSessionUsd)]),
      new Set([2, 3, 4, 5]),
    ),
  );
  const billedRows = report.cells.flatMap((cell) =>
    Object.entries(cell.billedBy).map(([modelId, billed]) => [cell.cell, modelId, billed.tokens.toLocaleString("en-US"), billed.unpriced ? "unpriced" : formatUsd(billed.costUsd)]),
  );
  if (billedRows.length) {
    out.push("", "Billed by model (usage attributed to the model that billed it)");
    out.push(table(["cell", "billed model", "tokens", "cost"], billedRows, new Set([2, 3])));
  } else {
    out.push("  (no usage recorded for these sessions yet)");
  }

  const { followUps } = report;
  out.push("", "Follow-ups");
  out.push(`  reroute ${followUps.reroute} · escalate ${followUps.escalate} · kept ${followUps.kept} · fallback ${followUps.fallback} · pinned ${followUps.pinned}`);
  if (followUps.keptReasons.length) {
    out.push("", "  Top kept reasons");
    out.push(table(["count", "reason"], followUps.keptReasons.slice(0, 8).map((entry) => [entry.count, entry.key]), new Set([0])).replace(/^/gm, "  "));
  }
  if (followUps.escalationsByProvider.length) {
    out.push("", "  Escalations by provider");
    out.push(table(["provider", "count"], followUps.escalationsByProvider.map((entry) => [entry.key, entry.count]), new Set([1])).replace(/^/gm, "  "));
  }

  out.push("", `Manual overrides (Auto chats later pinned to a model): ${report.overrides.total} of ${report.autoSessions}`);
  if (report.overrides.byCell.length) {
    out.push(table(["cell", "pinned", "of"], report.overrides.byCell.map((entry) => [entry.cell, entry.overrides, entry.sessions]), new Set([1, 2])));
  }

  const { goals } = report;
  out.push("", "Goals on Auto chats");
  if (goals.sessions === 0) {
    out.push("  (no Auto chat set a Goal)");
  } else {
    out.push(`  ${goals.met} met · ${goals.notMet} not met · ${goals.active} active (across ${goals.sessions} chats)`);
  }
  return out.join("\n");
}

const flags = parseArgs(process.argv.slice(2));
const dataDir = path.resolve(flags["data-dir"] ?? process.env.ARGMAX_DATA_DIR ?? realProfileDataDir());
const databasePath = path.join(dataDir, "local-state", "argmax.sqlite");
if (!existsSync(databasePath)) fail(`no database at ${databasePath} (is ${dataDir} an Argmax data dir?)`);

const days = Number(flags.days);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const report = buildReport({
  days,
  since,
  launches: query(databasePath, since, LAUNCH_SQL),
  routes: query(databasePath, since, ROUTES_SQL),
  usage: query(databasePath, since, USAGE_SQL),
  goals: query(databasePath, since, GOALS_SQL),
});

console.log(flags.json ? JSON.stringify(report, null, 2) : renderText(report, databasePath));
