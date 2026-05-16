import { ipcMain } from "electron";
import {
  launchProviderSessionInputSchema,
  providerSessionInputSchema,
  providerSessionResizeInputSchema,
  providerSessionTerminateInputSchema,
  providersDiscoverInputSchema,
  type IpcChannel
} from "../../shared/ipcSchemas.js";
import type { ProviderSessionService } from "../providers/providerSessionService.js";
import { discoverProviders } from "../providers/providerDiscovery.js";
import { timed } from "../util/ipcLatency.js";
import { withValidation } from "../ipc.js";

/** Provider lifecycle IPC handlers (Ralph SPEC D3 — fourth split). */
export function registerProviderHandlers(
  providerSessions: ProviderSessionService
): readonly IpcChannel[] {
  const registered: IpcChannel[] = [];
  const register = (channel: IpcChannel, listener: Parameters<typeof ipcMain.handle>[1]): void => {
    ipcMain.handle(channel, timed(channel, listener as (event: unknown, ...args: unknown[]) => unknown));
    registered.push(channel);
  };

  register("providers:discover", withValidation(providersDiscoverInputSchema, () => discoverProviders()));
  register(
    "providers:launch",
    withValidation(launchProviderSessionInputSchema, (input) => providerSessions.launch(input))
  );
  register(
    "providers:send-input",
    withValidation(providerSessionInputSchema, async (input) => {
      await providerSessions.sendInput(
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
      return { ok: true } as const;
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

  return registered;
}
