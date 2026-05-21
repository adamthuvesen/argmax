import { attachmentSaveImageInputSchema, type IpcChannel } from "../../shared/ipcSchemas.js";
import type { AttachmentStore } from "../attachments/attachmentStore.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/** Composer attachment IPC handlers. Writes pasted/dropped image bytes under
 *  `userData/attachments/<sessionId>/` and returns an absolute path the renderer
 *  threads into the outgoing prompt as an `@path` reference. */
export function registerAttachmentHandlers(attachments: AttachmentStore): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register(
    "attachments:save-image",
    withValidation(attachmentSaveImageInputSchema, (input) => attachments.saveImage(input))
  );

  return registered;
}
