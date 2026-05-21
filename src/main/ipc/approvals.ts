import {
  approvalsPendingInputSchema,
  resolveApprovalInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ArgmaxDatabase } from "../persistence/database.js";
import { withValidation } from "../ipc.js";
import { ApprovalService } from "../approvals/approvalService.js";
import { createIpcRegistrar } from "./registry.js";

/** Approvals IPC handlers (Ralph SPEC D3 — third split). */
export function registerApprovalsHandlers(database: ArgmaxDatabase): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();
  const approvals = new ApprovalService(database);

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
