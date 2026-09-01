/** Tool arguments as chat shows them: a key/value list, never a JSON dump.
 *
 *  Every non-bash tool — an MCP call, Grep, WebFetch, a Codex spawn — carries
 *  arguments the activity row cannot fit. Printing `JSON.stringify(input, null, 2)`
 *  spent six lines of braces on three values, so the detail renders the pairs
 *  themselves. Two shapes, decided here rather than in the component:
 *
 *  - Every argument a short scalar → they ride the detail's footer as one dim
 *    run (`glob *.ts · limit 20`), and the block holds only the payload.
 *  - Anything longer — a prompt, a body, a filter object → a key/value list at
 *    the top of the block, above the payload, because that is the order the
 *    call happened in.
 */

export type ToolArgument = { key: string; value: string };

/** Past this, a value stops being something you can read inside a footer run. */
const INLINE_VALUE_CHARS = 32;

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Arrays and objects stay on one line: a filter object is an argument, not a
  // document, and `dd` wraps it. `undefined` is the only thing JSON.stringify
  // declines to render.
  return JSON.stringify(value) ?? "undefined";
}

export function toolArguments(input: Record<string, unknown>): ToolArgument[] {
  return Object.entries(input).map(([key, value]) => ({ key, value: formatValue(value) }));
}

/** True when the whole set reads as one line of footer meta. */
export function argumentsFitFooter(args: readonly ToolArgument[]): boolean {
  if (args.length === 0) return false;
  return args.every(
    (arg) => !arg.value.includes("\n") && arg.value.length <= INLINE_VALUE_CHARS
  );
}
