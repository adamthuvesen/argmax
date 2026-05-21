import {
  terminalResizeInputSchema,
  terminalSpawnInputSchema,
  terminalTerminateInputSchema,
  terminalWriteInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { TerminalService } from "../terminal/terminalService.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/** Integrated-terminal IPC handlers (Ralph SPEC D3 — second split). */
export function registerTerminalHandlers(terminals: TerminalService): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "terminal:spawn",
    withValidation(terminalSpawnInputSchema, (input) => terminals.spawn(input))
  );
  register(
    "terminal:write",
    withValidation(terminalWriteInputSchema, (input) => {
      terminals.write(input);
      return { ok: true } as const;
    })
  );
  register(
    "terminal:resize",
    withValidation(terminalResizeInputSchema, (input) => {
      terminals.resize(input);
      return { ok: true } as const;
    })
  );
  register(
    "terminal:terminate",
    withValidation(terminalTerminateInputSchema, (terminalId) => {
      terminals.terminate(terminalId);
      return { ok: true } as const;
    })
  );

  return registered;
}
