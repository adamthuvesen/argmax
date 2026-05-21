import {
  launchProviderSessionInputSchema,
  providerSessionInputSchema,
  providerSessionResizeInputSchema,
  providerSessionTerminateInputSchema,
  providersCancelQueuedMessageInputSchema,
  providersDiscoverInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ProviderSessionService } from "../providers/providerSessionService.js";
import { discoverProviders } from "../providers/providerDiscovery.js";
import { withValidation } from "../ipc.js";
import { createIpcRegistrar } from "./registry.js";

/** Provider lifecycle IPC handlers (Ralph SPEC D3 — fourth split). */
export function registerProviderHandlers(
  providerSessions: ProviderSessionService
): readonly IpcChannel[] {
  const { register, channels: registered } = createIpcRegistrar();

  register("providers:discover", withValidation(providersDiscoverInputSchema, () => discoverProviders()));
  register(
    "providers:launch",
    withValidation(launchProviderSessionInputSchema, (input) => providerSessions.launch(input))
  );
  register(
    "providers:send-input",
    withValidation(providerSessionInputSchema, async (input) => {
      const result = await providerSessions.sendInput(
        input.sessionId,
        input.input,
        {
          ...(input.modelLabel && input.modelId
            ? {
                modelSelection: {
                  modelLabel: input.modelLabel,
                  modelId: input.modelId,
                  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
                }
              }
            : {}),
          ...(input.agentMode ? { agentMode: input.agentMode } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {})
        }
      );
      return { ok: true as const, queued: result.queued };
    })
  );
  register(
    "providers:resize",
    withValidation(providerSessionResizeInputSchema, (input) => {
      providerSessions.resize(input.sessionId, input.cols, input.rows);
      return { ok: true } as const;
    })
  );
  register(
    "providers:terminate",
    withValidation(providerSessionTerminateInputSchema, async (sessionId) => {
      await providerSessions.terminate(sessionId);
      return { ok: true } as const;
    })
  );
  register(
    "providers:cancel-queued-message",
    withValidation(providersCancelQueuedMessageInputSchema, (input) => {
      providerSessions.cancelQueuedMessage(input.sessionId, input.messageId);
      return { ok: true } as const;
    })
  );

  return registered;
}
