import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { ArgmaxDatabase } from "../persistence/database.js";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/types.js";
import { safeKill } from "../processControl.js";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty") as typeof NodePty;

export type TerminalPtySpawner = (file: string, args: string[], options: IPtyForkOptions) => IPty;

export interface TerminalBroadcaster {
  emitData(event: TerminalDataEvent): void;
  emitExit(event: TerminalExitEvent): void;
}

interface TerminalEntry {
  pty: IPty;
  workspaceId: string;
}

function pickShell(): string {
  const envShell = process.env.SHELL;
  if (envShell && envShell.length > 0) return envShell;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * Owns user-initiated PTYs spawned for the integrated terminal panel.
 * Distinct from `ProviderSessionService`, which owns provider-launched PTYs
 * tied to a session's provider lifecycle. User terminals are scoped to a
 * workspace's cwd and end when the user closes them or the app quits.
 */
export class TerminalService {
  private readonly terminals = new Map<string, TerminalEntry>();

  constructor(
    private readonly database: ArgmaxDatabase,
    private readonly broadcaster: TerminalBroadcaster,
    private readonly spawnPty: TerminalPtySpawner = nodePty.spawn
  ) {}

  spawn(input: { workspaceId: string; cols: number; rows: number }): { terminalId: string } {
    const workspace = this.database.getWorkspace(input.workspaceId);
    if (!workspace.path) {
      throw new Error("Workspace has no path on disk yet.");
    }

    const shell = pickShell();
    const pty = this.spawnPty(shell, [], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: workspace.path,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor"
      }
    });

    const terminalId = randomUUID();
    this.terminals.set(terminalId, { pty, workspaceId: input.workspaceId });

    pty.onData((data) => {
      this.broadcaster.emitData({ terminalId, data });
    });

    pty.onExit(({ exitCode, signal }) => {
      this.terminals.delete(terminalId);
      this.broadcaster.emitExit({
        terminalId,
        exitCode,
        signal: typeof signal === "number" ? signal : null
      });
    });

    return { terminalId };
  }

  write(input: { terminalId: string; data: string }): void {
    const entry = this.terminals.get(input.terminalId);
    if (!entry) return;
    entry.pty.write(input.data);
  }

  resize(input: { terminalId: string; cols: number; rows: number }): void {
    const entry = this.terminals.get(input.terminalId);
    if (!entry) return;
    entry.pty.resize(input.cols, input.rows);
  }

  terminate(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;
    safeKill(entry.pty);
  }

  disposeAll(): void {
    for (const [, entry] of this.terminals) {
      safeKill(entry.pty);
    }
    this.terminals.clear();
  }

  /** Test-only: inspect live terminals. */
  liveCount(): number {
    return this.terminals.size;
  }
}
