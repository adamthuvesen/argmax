import { useCallback } from "react";
import type { AgentMode, ComposerAttachment } from "../../shared/types.js";
import { modelSupportsFastMode, type ModelPickerSelection } from "../lib/models.js";
import { withToast, type ToastMessage } from "../lib/withToast.js";

interface UseSessionCommandsOptions {
  refreshDashboardStatus: () => Promise<void>;
  loadSessionEvents: (sessionId: string) => Promise<void>;
  setToast: (toast: ToastMessage) => void;
  fastMode: boolean;
  /**
   * Called before terminate when the stop may be an early undo of a mistaken
   * launch. Return a workspace id to archive after the provider has actually
   * stopped — a failed stop must not discard a chat that is still running.
   */
  onEarlyStop?: (sessionId: string) => string | undefined;
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
  /** Dispatch a prompt as a sibling chat that runs alongside this session's
   *  turn, in the same checkout. */
  multitask: (sessionId: string, prompt: string) => Promise<void>;
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
        throw new Error("Open the Tauri app window to send input to a live chat.");
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
      // The send already succeeded. Dashboard catch-up is best-effort and can
      // take a 100 ms metadata coalesce plus a transcript pull; awaiting it
      // kept the draft in the composer until that finished. Fire it off so
      // Enter can clear as soon as the backend has the message. A rejecting
      // refresh must not look like a failed send (that would skip clearing
      // and invite a double-send). Queued messages skip the event pull: the
      // chip arrives via dashboard:delta, and a stale empty page would race it.
      if (result.queued) {
        void refreshDashboardStatus();
        return;
      }
      void Promise.allSettled([refreshDashboardStatus(), loadSessionEvents(sessionId)]);
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

  // Dispatching never waits on the running turn: the sibling chat is launched
  // and this session's own turn is untouched. The dashboard refresh is what
  // brings its sidebar row and the parent's card in.
  const multitask = useCallback(
    async (sessionId: string, prompt: string): Promise<void> => {
      if (!window.argmax) {
        throw new Error("Open the Tauri app window to run a multitask.");
      }
      await window.argmax.session.multitask({ sessionId, prompt });
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
        throw new Error("Open the Tauri app window to stop a live chat.");
      }
      let workspaceToArchive: string | undefined;
      if (options?.restoreLauncherOnEarlyStop !== false) {
        workspaceToArchive = onEarlyStop?.(sessionId);
      }
      const ok = await withToast(
        () => window.argmax!.providers.terminate(sessionId),
        setToast,
        "Could not stop chat."
      );
      if (ok) {
        // Archive only after a successful stop: the 10s window is an undo of
        // a mistaken launch, and force-archive would otherwise discard a chat
        // that is still running. Isolated teardown of an already-stopped
        // session is a no-op for the provider.
        if (workspaceToArchive) {
          await window.argmax.workspaces
            .archive({ workspaceId: workspaceToArchive, force: true })
            .catch(() => undefined);
        }
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
        throw new Error("Open the Tauri app window to clear a chat.");
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
    multitask,
    runCheck,
    terminateSession,
    clearSession
  };
}
