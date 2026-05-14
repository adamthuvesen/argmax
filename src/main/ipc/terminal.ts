import { ipcMain } from "electron";
import {
  terminalResizeInputSchema,
  terminalSpawnInputSchema,
  terminalTerminateInputSchema,
  terminalWriteInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { TerminalService } from "../terminal/terminalService.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/** Integrated-terminal IPC handlers (Ralph SPEC D3 — second split). */
export function registerTerminalHandlers(terminals: TerminalService): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

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
