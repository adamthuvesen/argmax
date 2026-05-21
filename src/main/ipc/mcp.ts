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
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/** MCP listing + auth-flow IPC handlers (Ralph SPEC D3 — second split). */
export function registerMcpHandlers(mcpAuth: McpAuthService): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

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
