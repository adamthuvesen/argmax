import { ipcMain } from "electron";
import { z } from "zod";
import {
  mcpAuthResizeInputSchema,
  mcpAuthStartInputSchema,
  mcpAuthTerminateInputSchema,
  mcpAuthWriteInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { McpAuthService } from "../mcp/mcpAuthService.js";
import { listMcpServers } from "../mcp/mcpRegistry.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/** MCP listing + auth-flow IPC handlers (Ralph SPEC D3 — second split). */
export function registerMcpHandlers(mcpAuth: McpAuthService): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register("mcp:list", withValidation(z.void(), () => listMcpServers()));
  register(
    "mcp:auth:start",
    withValidation(mcpAuthStartInputSchema, (input) => mcpAuth.start(input))
  );
  register(
    "mcp:auth:write",
    withValidation(mcpAuthWriteInputSchema, (input) => {
      mcpAuth.write(input);
      return { ok: true } as const;
    })
  );
  register(
    "mcp:auth:resize",
    withValidation(mcpAuthResizeInputSchema, (input) => {
      mcpAuth.resize(input);
      return { ok: true } as const;
    })
  );
  register(
    "mcp:auth:terminate",
    withValidation(mcpAuthTerminateInputSchema, (sessionId) => {
      mcpAuth.terminate(sessionId);
      return { ok: true } as const;
    })
  );

  return registered;
}
