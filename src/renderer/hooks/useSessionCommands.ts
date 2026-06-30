import { useCallback } from "react";
import type { ProviderModelSelection } from "../../shared/providerModels.js";
import type { AgentMode, ComposerAttachment } from "../../shared/types.js";
import { withToast, type ToastMessage } from "../lib/withToast.js";

interface UseSessionCommandsOptions {
  refreshDashboardStatus: () => Promise<void>;
  loadSessionEvents: (sessionId: string) => Promise<void>;
  setToast: (toast: ToastMessage) => void;
  fastMode: boolean;
}

export interface SessionCommands {
  sendSessionInput: (
    sessionId: string,
    input: string,
    model: ProviderModelSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  cancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  runCheck: (workspaceId: string, command: string) => Promise<void>;
  createCheckpoint: (workspaceId: string) => Promise<void>;
  terminateSession: (sessionId: string) => Promise<void>;
}

export function useSessionCommands({
  refreshDashboardStatus,
  loadSessionEvents,
  setToast,
  fastMode
}: UseSessionCommandsOptions): SessionCommands {
  const sendSessionInput = useCallback(
    async (
      sessionId: string,
      input: string,
      model: ProviderModelSelection,
      agentMode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to send input to a live session.");
      }

      const result = await window.argmax.providers.sendInput({
        sessionId,
        input,
        modelLabel: model.label,
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort ?? null,
        fastMode,
        agentMode,
        attachments: attachments?.length ? attachments : null
      });
      // Queued messages don't write a user.message event yet — the chip in the
      // pending lane is the only renderer-visible artifact, and that arrives
      // via dashboard:delta. Skip the targeted event refresh to avoid a stale
      // empty page racing the delta.
      if (result.queued) {
        await refreshDashboardStatus();
        return;
      }
      // The send already succeeded; this post-send refresh is best-effort
      // catch-up. Use allSettled so a rejecting refresh/event-load never
      // bubbles out of sendSessionInput and makes the caller treat the
      // delivered input as failed (which would skip clearing the composer
      // and invite a double-send).
      await Promise.allSettled([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents, fastMode]
  );

  const cancelQueuedMessage = useCallback(async (sessionId: string, messageId: string): Promise<void> => {
    if (!window.argmax) return;
    await window.argmax.providers.cancelQueuedMessage({ sessionId, messageId });
  }, []);

  const runCheck = useCallback(
    async (workspaceId: string, command: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to run a check." });
        return;
      }
      const ok = await withToast(
        () => window.argmax!.checks.run({ workspaceId, command }),
        setToast,
        "Could not run check."
      );
      if (ok) await refreshDashboardStatus();
    },
    [refreshDashboardStatus, setToast]
  );

  const createCheckpoint = useCallback(
    async (workspaceId: string): Promise<void> => {
      if (!window.argmax) {
        setToast({ kind: "error", message: "Open the Tauri app window to save checkpoints." });
        return;
      }
      const label = `Checkpoint ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      const ok = await withToast(
        () => window.argmax!.checkpoints.create({ workspaceId, label }),
        setToast,
        "Could not save checkpoint."
      );
      if (ok) {
        setToast({ kind: "info", message: `Saved ${label}.` });
        await refreshDashboardStatus();
      }
    },
    [refreshDashboardStatus, setToast]
  );

  const terminateSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to stop a live session.");
      }
      const ok = await withToast(
        () => window.argmax!.providers.terminate(sessionId),
        setToast,
        "Could not stop session."
      );
      if (ok) {
        // Terminate already succeeded; the refresh is best-effort catch-up.
        // allSettled keeps a rejecting refresh from surfacing as a failed stop.
        await Promise.allSettled([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
      }
    },
    [refreshDashboardStatus, loadSessionEvents, setToast]
  );

  return {
    sendSessionInput,
    cancelQueuedMessage,
    runCheck,
    createCheckpoint,
    terminateSession
  };
}
