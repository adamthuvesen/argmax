/**
 * Installs the app shell (public/sw.js) for the phone.
 *
 * Two gates, both of which are ordinary rather than exceptional here. A service
 * worker needs a secure context, and the bridge serves plain HTTP over the
 * tailnet until Tailscale Serve terminates TLS — so on most phones today this
 * simply does not register, and the page behaves as it always has. And a worker
 * in front of the dev server would answer with yesterday's bundle, so builds
 * only.
 */
export type RegistrationSkip = "unsupported" | "insecure-context" | "dev";

export function reasonToSkip(
  environment: { supported: boolean; secureContext: boolean; dev: boolean }
): RegistrationSkip | null {
  if (environment.dev) return "dev";
  if (!environment.supported) return "unsupported";
  if (!environment.secureContext) return "insecure-context";
  return null;
}

export function registerServiceWorker(): void {
  const skip = reasonToSkip({
    supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    dev: import.meta.env.DEV
  });
  if (skip !== null) return;
  // After load: registering during startup competes with the first render for
  // the same connection to a host that is already the slow part.
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* A phone that refuses the worker still has a working page. */
    });
  });
}
