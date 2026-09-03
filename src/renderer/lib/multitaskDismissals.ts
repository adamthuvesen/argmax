/**
 * Multitask rows the person has closed. A row is drawn from the parent chat's
 * timeline, which never forgets a launch, so a dismissal has to live somewhere
 * of its own or the row comes straight back on the next mount.
 *
 * Keyed by the child session id, which is unique across the app. localStorage
 * rather than the backend: closing a settled row is a reading preference, not
 * a fact about the session.
 */
const DISMISSED_KEY = "argmax.multitask.dismissed";
/** Insertion order is kept, so trimming from the front drops the oldest. */
const MAX_DISMISSED = 200;

export function readDismissedMultitasks(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    // Unreadable storage means "nothing dismissed", never a failed mount.
    return new Set();
  }
}

export function dismissMultitask(dismissed: Set<string>, key: string): Set<string> {
  const next = new Set(dismissed);
  next.delete(key);
  next.add(key);
  const entries = [...next].slice(-MAX_DISMISSED);
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(entries));
  } catch {
    // A quota failure costs a remembered dismissal, never the click.
  }
  return new Set(entries);
}
