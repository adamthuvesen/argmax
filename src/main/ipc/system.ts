import { app, nativeTheme, shell } from "electron";
import { isAbsolute, relative as relativePath, resolve as resolvePath, join as joinPath } from "node:path";
import { statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  listDetectedIdesInputSchema,
  systemOpenPathInputSchema,
  systemSetThemeInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { DatabaseStats } from "../../shared/types.js";
import { detectInstalledIdes } from "../ide/ideDetection.js";
import { readPhases as readStartupPhases } from "../util/startupTimer.js";
import { readHistogram as readIpcHistogram } from "../util/ipcLatency.js";
import { readLogBuffer } from "../../shared/logger.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";
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
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "system:list-detected-ides",
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
    "system:vacuum-database",
    withValidation(z.void(), () => {
      database.connection.exec("VACUUM");
      return { ok: true } as const;
    })
  );

  register(
    "system:set-theme",
    withValidation(systemSetThemeInputSchema, (input) => {
      // Track the chosen mode in nativeTheme so OS-level chrome (titlebar
      // buttons, native dialogs) follows. Persist a side-channel cache so the
      // *next* cold start can pick the matching BrowserWindow.backgroundColor
      // before the renderer ever runs.
      nativeTheme.themeSource = input.mode;
      try {
        const cachePath = joinPath(app.getPath("userData"), "theme.json");
        writeFileSync(cachePath, JSON.stringify({ mode: input.mode }), "utf-8");
      } catch {
        /* userData may be read-only in some sandboxed launches — ignore */
      }
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
      // Defense in depth — when the caller scoped the open to a `cwd` (the
      // common "open this file inside the workspace" pattern), require the
      // resolved target to actually be contained inside it. Without this, a
      // compromised renderer (combined with the markdown XSS surface) could
      // ask the OS handler to open `/etc/passwd` while passing the workspace
      // root as cwd. Callers that genuinely need to open paths outside any
      // workspace (settings panel, database file) just omit `cwd`.
      // (audit-2026-05-17 H14)
      let openTarget = target;
      if (input.cwd) {
        try {
          const cwdReal = await realpath(input.cwd);
          const targetReal = await realpath(target);
          const rel = relativePath(cwdReal, targetReal);
          if (rel.startsWith("..") || isAbsolute(rel)) {
            throw new Error("path escapes cwd");
          }
          // Open the canonicalized path so a symlink swap between the
          // realpath() above and shell.openPath() below can't redirect us
          // outside the cwd (TOCTOU).
          openTarget = targetReal;
        } catch (error) {
          if (error instanceof Error && error.message === "path escapes cwd") throw error;
          // realpath failed (ENOENT etc.) — fall through to shell.openPath so
          // it can return its own user-readable error message.
        }
      }
      const error = await shell.openPath(openTarget);
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
