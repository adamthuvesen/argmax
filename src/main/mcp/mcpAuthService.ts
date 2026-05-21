import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { IDisposable, IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { McpAuthDataEvent, McpAuthExitEvent } from "../../shared/types.js";
import { safeKill, scheduleSigkillEscalation } from "../processControl.js";
import { discoverProviderById } from "../providers/providerDiscovery.js";
import { buildProviderEnvironment } from "../providers/providerEnvironment.js";

const require = createRequire(import.meta.url);
const nodePty = require("node-pty") as typeof NodePty;

export type McpAuthPtySpawner = (file: string, args: string[], options: IPtyForkOptions) => IPty;

export type McpAuthBinaryResolver = () => Promise<string | null>;

export interface McpAuthBroadcaster {
  emitData(event: McpAuthDataEvent): void;
  emitExit(event: McpAuthExitEvent): void;
}

interface AuthSessionEntry {
  pty: IPty;
  primed: boolean;
  disposables: IDisposable[];
}

/**
 * Owns the interactive PTY behind Settings → MCP servers → "Authenticate via
 * Claude (/mcp)". Claude Code has no standalone `claude mcp auth <name>`
 * subcommand — its OAuth flow lives inside the interactive `/mcp` slash
 * command. So we spawn `claude` in a small modal PTY and feed `/mcp` once,
 * after the CLI's prompt is on screen. Distinct from TerminalService because
 * (a) there is no workspace, cwd is the user's home directory so Claude reads
 * the global config, and (b) we own the post-spawn `/mcp` prime.
 */
export class McpAuthService {
  private readonly sessions = new Map<string, AuthSessionEntry>();
  private readonly resolveBinary: McpAuthBinaryResolver;
  private readonly spawnPty: McpAuthPtySpawner;

  constructor(
    private readonly broadcaster: McpAuthBroadcaster,
    options: { resolveBinary?: McpAuthBinaryResolver; spawnPty?: McpAuthPtySpawner } = {}
  ) {
    this.resolveBinary =
      options.resolveBinary ??
      (async () => {
        const report = await discoverProviderById("claude");
        return report.binaryPath;
      });
    this.spawnPty = options.spawnPty ?? nodePty.spawn;
  }

  async start(input: { cols: number; rows: number }): Promise<{ sessionId: string }> {
    const binaryPath = await this.resolveBinary();
    if (!binaryPath) {
      throw new Error(
        "Claude Code is not installed on this machine. Install it from https://docs.claude.com/en/docs/claude-code/install and try again."
      );
    }

    // The Claude CLI is a Node script with a `#!/usr/bin/env node` shebang,
    // so the spawn env's PATH must include node and the user's package
    // managers — use the same environment builder the provider adapters use.
    const env = buildProviderEnvironment({
      TERM: "xterm-256color",
      COLORTERM: process.env.COLORTERM ?? "truecolor"
    });

    const pty = this.spawnPty(binaryPath, [], {
      name: "xterm-256color",
      cols: input.cols,
      rows: input.rows,
      cwd: homedir(),
      env
    });

    const sessionId = randomUUID();
    const entry: AuthSessionEntry = { pty, primed: false, disposables: [] };
    this.sessions.set(sessionId, entry);

    entry.disposables.push(
      pty.onData((data) => {
        // First chunk from Claude may be a banner / color setup written BEFORE
        // the prompt is ready for input. Wait ~200 ms after the first data
        // event so the prompt has time to settle, then auto-type `/mcp`.
        // Fires once per session. (audit-2026-05-17 M17)
        if (!entry.primed) {
          entry.primed = true;
          const primeTimer = setTimeout(() => {
            try {
              pty.write("/mcp\r");
            } catch {
              // PTY died between spawn and prime; exit handler surfaces it.
            }
          }, 200);
          if (typeof primeTimer.unref === "function") primeTimer.unref();
        }
        this.broadcaster.emitData({ sessionId, data });
      })
    );

    entry.disposables.push(
      pty.onExit(({ exitCode, signal }) => {
        const live = this.sessions.get(sessionId);
        if (live) {
          for (const d of live.disposables) d.dispose();
          this.sessions.delete(sessionId);
        }
        this.broadcaster.emitExit({
          sessionId,
          exitCode,
          signal: typeof signal === "number" ? signal : null
        });
      })
    );

    return { sessionId };
  }

  write(input: { sessionId: string; data: string }): void {
    const entry = this.sessions.get(input.sessionId);
    if (!entry) return;
    entry.pty.write(input.data);
  }

  resize(input: { sessionId: string; cols: number; rows: number }): void {
    const entry = this.sessions.get(input.sessionId);
    if (!entry) return;
    entry.pty.resize(input.cols, input.rows);
  }

  terminate(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Don't dispose listeners here — the pty's own exit will fire onExit and
    // clean up via that path. Disposing pre-emptively would cancel the
    // listener before exitCode/signal could be broadcast to the renderer.
    safeKill(entry.pty);
  }

  disposeAll(): void {
    // SIGTERM-then-SIGKILL escalation — a Claude CLI hung at an OAuth
    // browser-callback prompt would otherwise survive app quit because it
    // traps SIGHUP. Pre-dispose installs a final onExit so the SIGKILL
    // timer is cancelled (and the PID-reuse hazard avoided) when the pty
    // exits cleanly inside the grace window.
    for (const [, entry] of this.sessions) {
      let exited = false;
      let cancelEscalation: (() => void) | null = null;
      const exitDisposable = entry.pty.onExit(() => {
        exited = true;
        cancelEscalation?.();
      });
      for (const d of entry.disposables) d.dispose();
      const escalation = scheduleSigkillEscalation(
        () => safeKill(entry.pty),
        () => {
          try {
            entry.pty.kill("SIGKILL");
          } catch {
            /* already exited */
          }
        },
        { isStillAlive: () => !exited }
      );
      cancelEscalation = escalation.cancel;
      if (exited) exitDisposable.dispose();
    }
    this.sessions.clear();
  }

  /** Test-only: inspect live sessions. */
  liveCount(): number {
    return this.sessions.size;
  }
}
