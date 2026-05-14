import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type { IPty, IPtyForkOptions } from "node-pty";
import type * as NodePty from "node-pty";
import type { McpAuthDataEvent, McpAuthExitEvent } from "../../shared/types.js";
import { safeKill } from "../processControl.js";
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
    const entry: AuthSessionEntry = { pty, primed: false };
    this.sessions.set(sessionId, entry);

    pty.onData((data) => {
      // First chunk from Claude means the prompt is on screen — auto-type
      // `/mcp` so the user lands directly on the MCP picker. Only fire once
      // per session; subsequent output is the user's interactive flow.
      if (!entry.primed) {
        entry.primed = true;
        try {
          pty.write("/mcp\r");
        } catch {
          // PTY may have died between spawn and first data; the exit handler
          // will surface the failure to the renderer.
        }
      }
      this.broadcaster.emitData({ sessionId, data });
    });

    pty.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.broadcaster.emitExit({
        sessionId,
        exitCode,
        signal: typeof signal === "number" ? signal : null
      });
    });

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
    safeKill(entry.pty);
  }

  disposeAll(): void {
    for (const [, entry] of this.sessions) {
      safeKill(entry.pty);
    }
    this.sessions.clear();
  }

  /** Test-only: inspect live sessions. */
  liveCount(): number {
    return this.sessions.size;
  }
}
