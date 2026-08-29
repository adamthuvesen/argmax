/**
 * Open-in-browser-pane request bus. Deeply nested chat content (markdown
 * links) asks for the pane without threading a callback through every layer;
 * App subscribes once and owns the panel state.
 */

const OPEN_EVENT = "argmax:browser-panel-open";

export function openInBrowserPanel(url: string): void {
  window.dispatchEvent(new CustomEvent<string>(OPEN_EVENT, { detail: url }));
}

export function onBrowserPanelRequest(listener: (url: string) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail;
    if (typeof detail === "string" && detail.length > 0) listener(detail);
  };
  window.addEventListener(OPEN_EVENT, handler);
  return () => window.removeEventListener(OPEN_EVENT, handler);
}

/**
 * Turn address-bar input into a navigable URL: pass http(s) through, refuse
 * other schemes, and treat everything else ("github.com", "localhost:3000")
 * as an https host. Returns null when the input can't become a web URL.
 */
export function normalizeBrowserUrl(raw: string): string | null {
  const input = raw.trim();
  if (input.length === 0) return null;
  if (/^https?:\/\//i.test(input)) return input;
  // A colon followed by digits is a port ("localhost:5173"), not a scheme.
  if (/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(input)) return null;
  if (/\s/.test(input)) return null;
  const host = input.split(/[/?#]/, 1)[0] ?? "";
  if (!host.includes(".") && !host.startsWith("localhost")) return null;
  return `https://${input}`;
}
