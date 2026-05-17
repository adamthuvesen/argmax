import { ipcMain, shell } from "electron";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  listDetectedIdesInputSchema,
  systemOpenPathInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { DatabaseStats } from "../../shared/types.js";
import { detectInstalledIdes } from "../ide/ideDetection.js";
import { readPhases as readStartupPhases } from "../util/startupTimer.js";
import { readHistogram as readIpcHistogram, timed } from "../util/ipcLatency.js";
import { readLogBuffer } from "../../shared/logger.js";
import { withValidation } from "../ipc.js";
import { getDatabasePath } from "../paths.js";

/**
 * System-level handlers split out from `src/main/ipc.ts` (Ralph SPEC D3 —
 * partial: this is the first domain extraction, more to follow). All of
 * these touch process-level state (Electron `app`, `shell`, IDE detection,
 * startup timer, log buffer) and not provider/workspace/git domains, so they
 * compose cleanly without back-references to the rest of the IPC module.
 *
 * Channel names are unchanged. The parity test compares `IPC_CHANNELS` to
 * the actual `ipcMain.handle` registrations — extraction is invisible to
 * the contract.
 */
export function registerSystemHandlers(database: ArgmaxDatabase): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "system:listDetectedIdes",
    withValidation(listDetectedIdesInputSchema, () => detectInstalledIdes())
  );

  register(
    "system:diagnostics",
    withValidation(z.void(), () => {
      const require = createRequire(import.meta.url);
      const pkg = require("../../../package.json") as { version?: string };
      let sqliteVersion = "";
      try {
        const row = database.connection.prepare("SELECT sqlite_version() AS v").get() as { v: string };
        sqliteVersion = row.v;
      } catch {
        sqliteVersion = "unknown";
      }
      const databasePath = getDatabasePath();
      return {
        appVersion: pkg.version ?? "0.0.0",
        electronVersion: process.versions.electron ?? "",
        nodeVersion: process.versions.node,
        sqliteVersion,
        databasePath,
        platform: process.platform,
        arch: process.arch,
        generatedAt: new Date().toISOString(),
        startupPhases: readStartupPhases(),
        databaseStats: collectDatabaseStats(database, databasePath),
        ipcStats: readIpcHistogram(),
        // Tail the most recent 200 entries. The buffer caps at 1000; the panel
        // only needs the recent slice and a 200-row table stays scannable.
        recentLogs: readLogBuffer().slice(-200)
      };
    })
  );

  register(
    "system:vacuumDatabase",
    withValidation(z.void(), () => {
      database.connection.exec("VACUUM");
      return { ok: true } as const;
    })
  );

  register(
    "system:open-path",
    withValidation(systemOpenPathInputSchema, async (input) => {
      const target = isAbsolute(input.path)
        ? input.path
        : input.cwd
          ? resolvePath(input.cwd, input.path)
          : input.path;
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
      return { ok: true } as const;
    })
  );

  return registered;
}

/**
 * SPEC P7.03 — collect database health stats for Diagnostics → Database.
 * Per-table row counts, WAL sidecar size, and the configured
 * `wal_autocheckpoint` pragma. All reads are cheap (`COUNT(*)` against
 * indexed tables, single pragma read, single `fs.stat`).
 */
function collectDatabaseStats(database: ArgmaxDatabase, databasePath: string): DatabaseStats {
  const count = (table: string): number => {
    try {
      const row = database.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return row.n;
    } catch {
      return 0;
    }
  };
  let walBytes = 0;
  try {
    walBytes = statSync(`${databasePath}-wal`).size;
  } catch {
    /* sidecar missing or unreadable */
  }
  let walAutocheckpoint = 0;
  try {
    walAutocheckpoint = Number(database.connection.pragma("wal_autocheckpoint", { simple: true })) || 0;
  } catch {
    /* pragma read failed */
  }
  return {
    rowCounts: {
      projects: count("projects"),
      workspaces: count("workspaces"),
      sessions: count("sessions"),
      events: count("events"),
      rawOutputs: count("raw_outputs"),
      approvals: count("approvals"),
      checks: count("checks"),
      checkpoints: count("checkpoints"),
      learnings: count("learnings"),
      usageEvents: count("usage_events")
    },
    walBytes,
    walAutocheckpoint
  };
}
