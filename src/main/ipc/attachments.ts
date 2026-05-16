import { ipcMain } from "electron";
import { attachmentSaveImageInputSchema, type IpcChannel } from "../../shared/ipcSchemas.js";
import type { AttachmentStore } from "../attachments/attachmentStore.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/** Composer attachment IPC handlers. Writes pasted/dropped image bytes under
 *  `userData/attachments/<sessionId>/` and returns an absolute path the renderer
 *  threads into the outgoing prompt as an `@path` reference. */
export function registerAttachmentHandlers(attachments: AttachmentStore): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "attachments:save-image",
    withValidation(attachmentSaveImageInputSchema, (input) => attachments.saveImage(input))
  );

  return registered;
}
