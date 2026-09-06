export const REMOTE_BRIDGE_KEY = "argmax.remote";
export const REMOTE_TOKEN_KEY = "argmax.remote.token";

export function isRemoteEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as unknown as Window & { __ARGMAX_REMOTE_BRIDGE__?: boolean };
  if (win.__ARGMAX_REMOTE_BRIDGE__ === true) return true;
  try {
    if (win.location && new URLSearchParams(win.location.search).has("remote")) return true;
    if (win.localStorage && win.localStorage.getItem(REMOTE_BRIDGE_KEY) === "1") return true;
  } catch {
    // Local storage access can fail in security-restricted contexts.
  }
  return false;
}

export function getRemoteToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const win = window as unknown as Window;
    if (win.location?.hash) {
      const match = win.location.hash.match(/(?:^|#|&)token=([^&]+)/);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    if (win.localStorage) {
      return win.localStorage.getItem(REMOTE_TOKEN_KEY) ?? "";
    }
  } catch {
    // Ignore storage access errors.
  }
  return "";
}

export function formatRemoteTokenQuery(): string {
  const token = getRemoteToken();
  return token ? `?token=${encodeURIComponent(token)}` : "";
}
