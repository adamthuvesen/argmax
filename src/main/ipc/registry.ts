import { ipcMain } from "electron";
import type { IpcChannel } from "../../shared/ipcSchemas.js";
import { timed } from "../util/ipcLatency.js";

export interface IpcRegistrar {
  register: (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]) => void;
  channels: readonly IpcChannel[];
}

/** Shared `ipcMain.handle` + latency wrapper used by every IPC submodule. */
export function createIpcRegistrar(): IpcRegistrar {
  const channels: IpcChannel[] = [];
  return {
    channels,
    register(channel, listener) {
      ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
      channels.push(channel);
    }
  };
}
