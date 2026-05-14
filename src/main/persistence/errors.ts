/**
 * Thrown when a row lookup fails because the row no longer exists. Callers
 * that race against deletion (e.g. async event handlers writing to a session
 * that was just cancelled) can catch this specifically; everything else is
 * a real fault and should propagate.
 */
export class RecordNotFoundError extends Error {
  constructor(
    readonly kind: "session" | "workspace" | "project" | "checkpoint" | "check" | "approval" | "learning",
    readonly id: string
  ) {
    super(`${kind} not found: ${id}`);
    this.name = "RecordNotFoundError";
  }
}
