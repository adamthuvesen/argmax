/**
 * Detect a leading slash command at the very start of the composer input.
 *
 * Returns the command name (without the slash) when the input opens with a
 * `/<token>` shape — `token` being the unbroken run right after the slash,
 * any arguments after the first space ignored. Returns null otherwise (no
 * slash, a space before the token, or a bare `/`).
 *
 * The caller decides whether the name maps to a real skill; this only finds
 * the candidate so the composer can tint it. Extracted as a pure function so
 * the boundary cases are unit-tested without driving the DOM overlay.
 */
export function leadingSlashCommand(input: string): string | null {
  const match = /^\/(\S+)/.exec(input);
  return match?.[1] ?? null;
}
