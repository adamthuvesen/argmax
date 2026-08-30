import { useMemo } from "react";
import type { DiscoveredProvider } from "../../shared/types.js";
import type { ProviderAvailability } from "../components/ModelSelector.js";
import { useAsyncLoad } from "./useAsyncLoad.js";

/**
 * Install/auth state per provider, for the model pickers that annotate an
 * unusable pick. `undefined` while discovery is in flight or after it failed —
 * "we learned nothing" has to stay distinguishable from "nothing is
 * installed", or a slow probe would grey out the whole catalog.
 */
export function useProviderAvailability(): {
  availability: ProviderAvailability | undefined;
  discovered: DiscoveredProvider[] | null;
} {
  const { data: discovered } = useAsyncLoad<DiscoveredProvider[]>(() => window.argmax!.providers.discover(), {
    fallbackMessage: "Provider discovery failed."
  });
  const availability = useMemo<ProviderAvailability | undefined>(() => {
    if (!discovered) return undefined;
    const map: ProviderAvailability = {};
    for (const entry of discovered) {
      map[entry.provider] = { installed: entry.installed, authenticated: entry.authenticated };
    }
    return map;
  }, [discovered]);
  return { availability, discovered };
}
