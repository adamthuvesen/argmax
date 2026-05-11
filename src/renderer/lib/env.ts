export function isBrowserPreview(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return ["127.0.0.1", "localhost"].includes(window.location.hostname);
}
