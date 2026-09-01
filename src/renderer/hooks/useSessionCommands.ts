import { useCallback } from "react";
import type { AgentMode, ComposerAttachment } from "../../shared/types.js";
import { modelSupportsFastMode, type ModelPickerSelection } from "../lib/models.js";
import { withToast, type ToastMessage } from "../lib/withToast.js";

interface UseSessionCommandsOptions {
  refreshDashboardStatus: () => Promise<void>;
  loadSessionEvents: (sessionId: string) => Promise<void>;
  setToast: (toast: ToastMessage) => void;
  fastMode: boolean;
  onEarlyStop?: (sessionId: string) => void;
}

export interface TerminateSessionOptions {
  restoreLauncherOnEarlyStop?: boolean;
}

export interface SessionCommands {
  sendSessionInput: (
    sessionId: string,
    input: string,
    model: ModelPickerSelection,
    agentMode: AgentMode,
    attachments?: ComposerAttachment[]
  ) => Promise<void>;
  cancelQueuedMessage: (sessionId: string, messageId: string) => Promise<void>;
  sendQueuedMessageNow: (sessionId: string, messageId: string) => Promise<void>;
  runCheck: (workspaceId: string, command: string) => Promise<void>;
  terminateSession: (sessionId: string, options?: TerminateSessionOptions) => Promise<void>;
  clearSession: (sessionId: string) => Promise<void>;
}

export function useSessionCommands({
  refreshDashboardStatus,
  loadSessionEvents,
  setToast,
  fastMode,
  onEarlyStop
}: UseSessionCommandsOptions): SessionCommands {
  const sendSessionInput = useCallback(
    async (
      sessionId: string,
      input: string,
      model: ModelPickerSelection,
      agentMode: AgentMode,
      attachments?: ComposerAttachment[]
    ): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to send input to a live session.");
      }

      const result = await window.argmax.providers.sendInput({
        sessionId,
        input,
        // Carries the picked provider; the backend only acts on it when it
        // differs from the session's current provider (and the session is idle).
        provider: model.provider,
        modelLabel: model.label,
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort ?? null,
        fastMode: fastMode && modelSupportsFastMode(model),
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

  const sendQueuedMessageNow = useCallback(
    async (sessionId: string, messageId: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to send a queued follow-up.");
      }
      await window.argmax.providers.sendQueuedMessageNow({ sessionId, messageId });
      await Promise.allSettled([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents]
  );

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

  const terminateSession = useCallback(
    async (sessionId: string, options?: TerminateSessionOptions): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to stop a live session.");
      }
      if (options?.restoreLauncherOnEarlyStop !== false) {
        onEarlyStop?.(sessionId);
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
    [onEarlyStop, refreshDashboardStatus, loadSessionEvents, setToast]
  );

  const clearSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to clear a session.");
      }
      const ok = await withToast(
        () => window.argmax!.session.clear({ sessionId }),
        setToast,
        "Could not clear the conversation."
      );
      if (!ok) {
        throw new Error("Could not clear the conversation.");
      }
      await Promise.allSettled([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
    },
    [refreshDashboardStatus, loadSessionEvents, setToast]
  );

  return {
    sendSessionInput,
    cancelQueuedMessage,
    sendQueuedMessageNow,
    runCheck,
    terminateSession,
    clearSession
  };
}
