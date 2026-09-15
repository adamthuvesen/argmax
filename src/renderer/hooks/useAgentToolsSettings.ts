import { useCallback, useEffect, useState } from "react";

/**
 * Which tools a new chat's `argmax` MCP server carries.
 *
 * Unlike most Argmax preferences this one is not in localStorage: the launcher
 * reads it, and it has to give the same answer for a chat an agent started as
 * for a chat the user started. So the database owns it and the renderer asks.
 *
 * The toggle is optimistic and reverts if the write fails — a setting that
 * silently reads back the opposite of what was clicked is worse than one that
 * snaps back.
 */
export function useAgentToolsSettings(): {
  browserTools: boolean;
  setBrowserTools: (enabled: boolean) => void;
} {
  const [browserTools, setBrowserToolsState] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const api = window.argmax?.settings;
    if (!api) return;
    void api
      .agentTools()
      .then((settings) => {
        if (!cancelled) setBrowserToolsState(settings.browserTools);
      })
      .catch(() => {
        // Keep the default. The launcher defaults the same way.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setBrowserTools = useCallback((enabled: boolean) => {
    const api = window.argmax?.settings;
    if (!api) return;
    setBrowserToolsState(enabled);
    void api.setBrowserTools({ enabled }).catch(() => {
      setBrowserToolsState(!enabled);
    });
  }, []);

  return { browserTools, setBrowserTools };
}
