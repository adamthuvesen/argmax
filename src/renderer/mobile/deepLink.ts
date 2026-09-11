/**
 * One-shot deep link from an ntfy push: `mobile.html?session=<id>` opens that
 * session instead of the list. The id is consumed once and scrubbed from the
 * address bar, so a later reload lands on the list rather than re-entering a
 * session the reader has already dealt with.
 *
 * The pairing token is scrubbed from `location.hash` before this runs and that
 * scrub preserves `location.search` (see wsTransport.ts), so a link may carry
 * both `?session=` and `#token=`.
 */
const SESSION_PARAM = "session";

/** Ids come from the host, but a link is user-editable — keep the accepted
 *  shape narrow so nothing exotic reaches a lookup. Shared with the native
 *  shell's `openSession(id)`, which arrives by the same untrusted route
 *  (a string interpolated into `evaluateJavaScript`). */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isDeepLinkSessionId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function takeDeepLinkSessionId(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(SESSION_PARAM);
  if (raw === null) return null;

  params.delete(SESSION_PARAM);
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    window.location.pathname + (query ? `?${query}` : "") + window.location.hash
  );

  return isDeepLinkSessionId(raw) ? raw : null;
}
