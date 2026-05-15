import { ipcMain } from "electron";
import {
  approvalsPendingInputSchema,
  resolveApprovalInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";
import { ApprovalService } from "../approvals/approvalService.js";

/** Approvals IPC handlers (Ralph SPEC D3 — third split). */
export function registerApprovalsHandlers(database: ArgmaxDatabase): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const approvals = new ApprovalService(database);
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register(
    "approvals:resolve",
    withValidation(resolveApprovalInputSchema, (input) => approvals.resolveApproval(input.approvalId, input.status))
  );
  register(
    "approvals:pending",
    withValidation(approvalsPendingInputSchema, () => database.listPendingApprovals())
  );

  return registered;
}
