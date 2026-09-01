import { Fragment, useMemo, useState, type JSX, type ReactNode } from "react";
import { interpretFileChange } from "../lib/fileChange.js";
import { argumentsFitFooter, toolArguments, type ToolArgument } from "../lib/toolArguments.js";
import {
  displayBashCommand,
  extractOpenablePath,
  formatToolOutput,
  getToolTypeBucket,
  isBashLikeTool,
  unwrapBashCommand,
  type ToolCall
} from "../lib/toolCalls.js";
import { FileChangeCard } from "./FileChangeCard.js";
import type { FileChipOpenOptions } from "./FileChip.js";
import { displayPath } from "../lib/displayPath.js";

const MAX_INLINE_CONTENT_CHARS = 2400;
const MAX_OUTPUT_CHARS = 3000;
const REDUNDANT_INPUT_KEYS = new Set([
  "absolute_path",
  "content",
  "file_path",
  "filePath",
  "filepath",
  "path",
  "relative_path",
  "streamContent",
  "text"
]);
const BASH_COMMAND_INPUT_KEYS = ["command", "cmd", "shell_command", "script"] as const;
// Claude's Bash carries `description` + `timeout`; Codex uses `timeout_ms`.
// None of that is a reason to dump the whole input JSON under the command.
const REDUNDANT_BASH_INPUT_KEYS = new Set([
  ...REDUNDANT_INPUT_KEYS,
  ...BASH_COMMAND_INPUT_KEYS,
  "cwd",
  "dangerouslyDisableSandbox",
  "description",
  "max_output_tokens",
  "run_in_background",
  "runInBackground",
  "timeout",
  "timeout_ms",
  "yield_time_ms"
]);

function pickString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function visibleInputForTool(tool: ToolCall): Record<string, unknown> {
  if (isCodexAgentTool(tool)) return tool.inputFull;
  // For Task (sub-agent) tools, drop the `prompt` field — it's a long
  // multi-paragraph instruction that bloats the toggled detail and adds
  // nothing the user can act on. Keep description + subagent_type.
  if (getToolTypeBucket(tool.name) !== "agent") return tool.inputFull;
  return Object.fromEntries(Object.entries(tool.inputFull).filter(([k]) => k !== "prompt"));
}

function hasNonRedundantInput(
  input: Record<string, unknown>,
  redundantKeys: ReadonlySet<string> = REDUNDANT_INPUT_KEYS
): boolean {
  return Object.keys(input).some((key) => !redundantKeys.has(key));
}

function nonRedundantInput(
  input: Record<string, unknown>,
  redundantKeys: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !redundantKeys.has(key)));
}

function isCodexAgentTool(tool: ToolCall): boolean {
  const lower = tool.name.toLowerCase();
  return lower === "spawn_agent" || lower === "collab_tool_call";
}

function shortenCommandCwd(command: string, cwd: string | null | undefined): string {
  if (!cwd) return command;
  return command.split(cwd.replace(/\/$/, "")).join(".");
}

function displayCommandPreview(command: string, cwd: string | null | undefined): string {
  return shortenCommandCwd(displayBashCommand(command), cwd);
}

function displayCommandFull(command: string, cwd: string | null | undefined): string {
  return shortenCommandCwd(unwrapBashCommand(command), cwd);
}

function hasVisibleToolOutput(output: string | null): boolean {
  return output !== null && output.trim().length > 0;
}

/** True when expanding the row would reveal a payload, leftover arguments, a
 *  file, or nested activity. A command that printed nothing is not a disclosure. */
export function toolCallHasExpandableDetail(
  tool: ToolCall,
  options?: { hasLeadingContent?: boolean }
): boolean {
  const changes = interpretFileChange(tool.name, tool.inputFull);
  if (changes && changes.length > 0) return true;

  const visibleInput = visibleInputForTool(tool);
  const bashCommand = isBashLikeTool(tool.name)
    ? pickString(tool.inputFull, BASH_COMMAND_INPUT_KEYS) ?? tool.inputPreview
    : null;
  const fullCommand = bashCommand ? unwrapBashCommand(bashCommand) : null;
  const showCommandBlock = fullCommand !== null && fullCommand.includes("\n");
  const openable = tool.status !== "error" ? extractOpenablePath(tool.name, tool.inputFull) : null;
  const filePath =
    openable ??
    pickString(tool.inputFull, ["path", "file_path", "filepath", "relative_path", "absolute_path"]);
  const streamContent = pickString(tool.inputFull, ["streamContent", "content", "text"]);
  const canShowFilePreview = Boolean(!changes && filePath && streamContent);
  const isAgent = getToolTypeBucket(tool.name) === "agent";
  const redundantKeys = bashCommand ? REDUNDANT_BASH_INPUT_KEYS : REDUNDANT_INPUT_KEYS;
  const leftoverInput = nonRedundantInput(visibleInput, redundantKeys);
  const showArguments =
    Object.keys(leftoverInput).length > 0 &&
    hasNonRedundantInput(visibleInput, redundantKeys) &&
    (!isAgent || isCodexAgentTool(tool));

  return (
    Boolean(tool.error) ||
    canShowFilePreview ||
    Boolean(openable) ||
    showCommandBlock ||
    showArguments ||
    Boolean(options?.hasLeadingContent) ||
    (hasVisibleToolOutput(tool.output) && !tool.error)
  );
}

/** Output size, once it is big enough that a reader cares. */
function formatSize(chars: number): string | null {
  if (chars < 1024) return null;
  return `${(chars / 1024).toFixed(1)} kB`;
}

/** How long the call took, from the row's own start/complete events. Sub-100ms
 *  is noise, so it stays off the footer entirely. */
function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 100) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallDetail({
  tool,
  workspaceCwd,
  onOpenFile,
  leadingContent
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  leadingContent?: ReactNode;
}): JSX.Element | null {
  const openFile = (path: string): void => {
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
    if (!window.argmax) return;
    void window.argmax.system
      .openPath({ path, ...(workspaceCwd ? { cwd: workspaceCwd } : {}) })
      .catch(() => undefined);
  };
  const [showFullOutput, setShowFullOutput] = useState(false);
  const changes = useMemo(
    () => interpretFileChange(tool.name, tool.inputFull),
    [tool.name, tool.inputFull]
  );
  const visibleInput = visibleInputForTool(tool);
  const bashCommand = isBashLikeTool(tool.name)
    ? pickString(tool.inputFull, BASH_COMMAND_INPUT_KEYS) ?? tool.inputPreview
    : null;
  const fullCommand = bashCommand ? displayCommandFull(bashCommand, workspaceCwd) : null;
  // The row *is* the command: an expanded bash row unwraps its target to the
  // full text (see .tool-call-row-button[aria-expanded="true"]), so repeating it
  // in the block was the same string twice in two type sizes. Only a heredoc
  // still earns a block — a row cannot carry newlines.
  const showCommandBlock = fullCommand !== null && fullCommand.includes("\n");
  const openable = tool.status !== "error" ? extractOpenablePath(tool.name, tool.inputFull) : null;
  const filePath = openable ?? pickString(tool.inputFull, ["path", "file_path", "filepath", "relative_path", "absolute_path"]);
  const streamContent = pickString(tool.inputFull, ["streamContent", "content", "text"]);
  const canShowFilePreview = !changes && filePath && streamContent;
  // Output that IS a file or a command's stdout keeps byte fidelity — a read of
  // package.json should look like package.json, not our reformatting of it.
  const verbatimOutput = isBashLikeTool(tool.name) || filePath !== null;
  const output = useMemo(
    () =>
      tool.output && !verbatimOutput
        ? formatToolOutput(tool.output)
        : { body: tool.output ?? "", title: null },
    [tool.output, verbatimOutput]
  );
  // The envelope's title is the one identifying fact worth keeping when the
  // payload is lifted out of it, and the footer line already collects facts.
  // Truncation is not a note any more: the footer offers Show all instead.
  const outputNotes = output.title !== null ? [output.title] : [];
  // The Started-agent row already shows the description; its only "raw input"
  // is description + subagent_type (prompt is dropped), so the box is pure
  // noise — and renders as an empty-looking shell before the sub-agent runs.
  // Skip it for Claude-style Task agents and let the detail collapse to
  // children/output. Codex spawn_agent rows are different: the prompt and
  // receiver thread ids are the only detail Codex gives us, so keep those
  // expandable instead of making the row feel dead.
  const isAgent = getToolTypeBucket(tool.name) === "agent";
  const redundantKeys = bashCommand ? REDUNDANT_BASH_INPUT_KEYS : REDUNDANT_INPUT_KEYS;
  // Only the leftover keys become arguments. Dumping the whole input used to
  // re-emit the command as one escaped JSON string under a disclosure labelled
  // Input, printed *below* the result it produced.
  const leftoverInput = nonRedundantInput(visibleInput, redundantKeys);
  const showArguments =
    Object.keys(leftoverInput).length > 0 &&
    hasNonRedundantInput(visibleInput, redundantKeys) &&
    (!isAgent || isCodexAgentTool(tool));
  const args = useMemo(
    () => (showArguments ? toolArguments(leftoverInput) : []),
    [showArguments, leftoverInput]
  );
  // Short scalars read as a sentence on the footer line; anything longer needs
  // the full list above the payload.
  const footerArgs = argumentsFitFooter(args) ? args : [];
  const listedArgs = footerArgs.length > 0 ? [] : args;

  const argumentList =
    listedArgs.length > 0 ? (
      <dl className="tool-call-args">
        {listedArgs.map((arg) => (
          <Fragment key={arg.key}>
            <dt>{arg.key}</dt>
            <dd>{arg.value}</dd>
          </Fragment>
        ))}
      </dl>
    ) : null;

  if (changes && changes.length > 0) {
    return (
      <div className="tool-call-detail">
        {tool.error || argumentList ? (
          <ToolCallBlock
            parts={[
              argumentList,
              tool.error ? (
                <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
              ) : null
            ]}
            footer={footerArgs.length > 0 ? <ToolCallFoot args={footerArgs} /> : null}
          />
        ) : null}
        {changes.map((change, index) => (
          <FileChangeCard
            change={change}
            key={`${change.path}-${index}`}
            workspaceCwd={workspaceCwd ?? null}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    );
  }

  // Nothing worth a block (a Task still spawning, say) → render no detail at
  // all rather than an empty fill hanging under the row.
  if (!toolCallHasExpandableDetail(tool, { hasLeadingContent: Boolean(leadingContent) })) {
    return null;
  }

  const outputBody = output.body;
  const truncated = outputBody.length > MAX_OUTPUT_CHARS;
  const shownOutput = truncated && !showFullOutput ? `${outputBody.slice(0, MAX_OUTPUT_CHARS)}\n…` : outputBody;

  const parts: (ReactNode | null)[] = [
    argumentList,
    showCommandBlock && fullCommand ? (
      // No "Command" label: the row already says Ran, and the block is
      // terminal chrome.
      <pre
        className="tool-call-code"
        title={displayCommandPreview(bashCommand ?? fullCommand, workspaceCwd)}
      >
        {fullCommand}
      </pre>
    ) : null,
    tool.error ? (
      // The one surviving label: rose text alone does not say what the block is
      // when the payload happens to be a plain sentence.
      <div className="tool-call-part">
        <p className="tool-call-part-label">Error</p>
        <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
      </div>
    ) : null,
    canShowFilePreview ? (
      <section className="tool-call-part tool-call-file-preview" aria-label={`Preview of ${filePath}`}>
        <p className="tool-call-part-label">Preview</p>
        <pre className="tool-call-code">
          {streamContent.length > MAX_INLINE_CONTENT_CHARS
            ? `${streamContent.slice(0, MAX_INLINE_CONTENT_CHARS)}\n...`
            : streamContent}
        </pre>
      </section>
    ) : null,
    // No "Output" label: it sat alone over a box as the only thing it could
    // possibly be labelling. Position and type say it instead.
    hasVisibleToolOutput(tool.output) && !tool.error ? (
      <pre className="tool-call-code">{shownOutput}</pre>
    ) : null
  ];

  // A read that printed nothing still has somewhere to go: the footer offers
  // Open. The row above already names the file, so nothing repeats it.
  const showOpenAction = Boolean(
    !canShowFilePreview && openable && !hasVisibleToolOutput(tool.output)
  );

  const footer = (
    <ToolCallFoot
      args={footerArgs}
      notes={outputNotes}
      output={hasVisibleToolOutput(tool.output) && !tool.error ? outputBody : null}
      truncated={truncated && !showFullOutput}
      onShowAll={() => setShowFullOutput(true)}
      duration={formatDuration(tool.createdAt, tool.completedAt)}
      openPath={showOpenAction && openable ? displayPath(openable, workspaceCwd) : null}
      onOpen={showOpenAction && openable ? () => openFile(openable) : undefined}
      openTitle={openable}
    />
  );

  return (
    <div className="tool-call-detail">
      {leadingContent}
      {parts.some((part) => part !== null) ? (
        <ToolCallBlock parts={parts} footer={footer} />
      ) : (
        <div className="tool-call-detail-actions">{footer}</div>
      )}
    </div>
  );
}

/** One soft fill per tool call: arguments, payload and the run's facts as a
 *  single object. Parts are separated by a hairline inside the fill rather than
 *  by a labelled box each, and the payload scrolls once — the transcript used
 *  to stack two bordered panels with a scrollbar apiece. */
function ToolCallBlock({
  parts,
  footer
}: {
  parts: readonly (ReactNode | null)[];
  footer?: ReactNode;
}): JSX.Element | null {
  const visible = parts.filter((part): part is ReactNode => part !== null && part !== false);
  if (visible.length === 0 && !footer) return null;
  return (
    <div className="tool-call-block">
      {visible.length > 0 ? (
        <div className="tool-call-block-body">
          {visible.map((part, index) => (
            <Fragment key={index}>
              {index > 0 ? <div className="tool-call-block-rule" /> : null}
              {part}
            </Fragment>
          ))}
        </div>
      ) : null}
      {footer}
    </div>
  );
}

/** The footer line: short arguments, then what came back and how long it took.
 *  One dim row, one place to look — this is where the old floating section
 *  labels and their `— showing first N of M chars` meta went. */
function ToolCallFoot({
  args = [],
  notes = [],
  output = null,
  truncated = false,
  onShowAll,
  duration = null,
  openPath = null,
  onOpen,
  openTitle = null
}: {
  args?: readonly ToolArgument[];
  notes?: readonly string[];
  output?: string | null;
  truncated?: boolean;
  onShowAll?: () => void;
  duration?: string | null;
  openPath?: string | null;
  onOpen?: () => void;
  openTitle?: string | null;
}): JSX.Element | null {
  const facts: string[] = [
    ...args.map((arg) => `${arg.key} ${arg.value}`),
    ...notes
  ];
  if (output !== null && output.length > 0) {
    // A line count of one is filler: the payload is right there. Size only
    // shows once it passes a kilobyte, for the same reason.
    const lines = output.split("\n").length;
    if (lines > 1) facts.push(`${lines.toLocaleString()} lines`);
    const size = formatSize(output.length);
    if (size) facts.push(size);
  }
  if (duration) facts.push(duration);
  const showOpen = openPath !== null && onOpen !== undefined;
  if (facts.length === 0 && !truncated && !showOpen) return null;
  return (
    <>
      <div className="tool-call-block-rule" />
      <div className="tool-call-block-foot">
        {facts.length > 0 ? <span className="tool-call-block-facts">{facts.join(" · ")}</span> : null}
        {truncated && onShowAll ? (
          <button className="tool-call-block-action" type="button" onClick={onShowAll}>
            Show all
          </button>
        ) : null}
        {showOpen ? (
          <button
            className="tool-call-block-action"
            type="button"
            onClick={onOpen}
            aria-label={`Open ${openTitle ?? openPath}`}
            title={openTitle ?? openPath ?? undefined}
          >
            Open
          </button>
        ) : null}
      </div>
    </>
  );
}
