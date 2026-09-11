import { parseUnifiedDiff, type ParsedDiffBlock } from "./diff.js";

export type FileChange =
  | { kind: "create"; path: string; hunks: ParsedDiffBlock[]; addCount: number; note?: string }
  | {
      kind: "edit";
      path: string;
      hunks: ParsedDiffBlock[];
      addCount: number;
      delCount: number;
      note?: string;
      noLineNumbers?: boolean;
    }
  | { kind: "delete"; path: string };

const MAX_INLINE_CHARS = 200_000;

export type ChangeCounts = { adds: number; dels: number; files: number };

/** Roll a set of changes into the `+N −N` stat a chat row shows beside the
 *  file name. Deletions of whole files contribute a file to the count but no
 *  line stat: their content is unknown to us, so claiming a number would be a
 *  guess. */
export function summarizeFileChanges(changes: FileChange[]): ChangeCounts {
  let adds = 0;
  let dels = 0;
  for (const change of changes) {
    if (change.kind === "delete") continue;
    adds += change.addCount;
    if (change.kind === "edit") dels += change.delCount;
  }
  return { adds, dels, files: changes.length };
}

/** Which single-file edit family a tool name belongs to, or `null` for a tool
 *  that does not write files. Provider names range from Cursor's camelCase
 *  `writeToolCall` to Grok's `search_replace`, so recognition is by the
 *  established write verbs rather than an exhaustive name list. */
function classifySingleFileTool(lower: string): {
  isMultiEdit: boolean;
  isWrite: boolean;
  isEdit: boolean;
  isDelete: boolean;
} | null {
  const isMultiEdit = /multi[_-]?edit/.test(lower);
  const isWrite =
    !isMultiEdit && (lower.includes("write") || lower.includes("create_file") || lower.includes("createfile"));
  const isEdit =
    !isMultiEdit &&
    (lower.includes("edit") ||
      lower.includes("patch") ||
      lower.includes("replace") ||
      lower.includes("update_file"));
  const isDelete =
    lower.includes("delete") || lower.includes("remove_file") || lower.includes("removefile");
  if (!isWrite && !isEdit && !isMultiEdit && !isDelete) return null;
  return { isMultiEdit, isWrite, isEdit, isDelete };
}

const SINGLE_FILE_PATH_KEYS = [
  "file_path",
  "filePath",
  "filepath",
  "path",
  "relative_path",
  "absolute_path"
];

function isCodexFileChangeTool(lower: string): boolean {
  return lower === "file_change" || lower === "file-change" || lower === "filechange";
}

/**
 * Every file path a tool call wrote to, or `[]` for a tool that writes none.
 * Shares `interpretFileChange`'s tool recognition so the "last turn" review
 * scope and the inline diff card agree on what counts as an edit. Notebook
 * edits count here. `interpretFileChange` skips them only because they don't
 * fit its line-diff rendering, not because they aren't file writes.
 */
export function editedFilePaths(name: string, input: Record<string, unknown>): string[] {
  const lower = name.toLowerCase();
  if (isCodexFileChangeTool(lower)) {
    return unique((interpretCodexFileChange(input) ?? []).map((change) => change.path));
  }
  if (classifySingleFileTool(lower) === null) return [];
  const path = pickString(input, SINGLE_FILE_PATH_KEYS);
  return path ? [path] : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// Edit tools carry the before/after pair in snake_case (Claude) or camelCase
// (opencode `edit`/`patch`); read both so one input-shape table serves every
// provider.
function editPair(source: Record<string, unknown>): { old: string; new: string } {
  return {
    old: typeof source.old_string === "string"
      ? source.old_string
      : typeof source.oldString === "string"
        ? source.oldString
        : "",
    new: typeof source.new_string === "string"
      ? source.new_string
      : typeof source.newString === "string"
        ? source.newString
        : ""
  };
}

export function interpretFileChange(
  name: string,
  input: Record<string, unknown>
): FileChange[] | null {
  const lower = name.toLowerCase();

  // Notebook edits don't fit the line-diff abstraction — let the fallback
  // render today's view.
  if (lower.includes("notebook")) return null;

  // Codex bundles multiple files under a single tool call.
  if (isCodexFileChangeTool(lower)) {
    return interpretCodexFileChange(input);
  }

  const shape = classifySingleFileTool(lower);
  if (shape === null) return null;
  const { isMultiEdit, isWrite, isEdit, isDelete } = shape;

  const path = pickString(input, SINGLE_FILE_PATH_KEYS);
  if (!path) return null;

  const reportedOperation = pickString(input, ["operation", "kind", "type"])?.toLowerCase();
  if (reportedOperation === "delete" || reportedOperation === "remove") {
    return [{ kind: "delete", path }];
  }
  if (isDelete && !isWrite && !isEdit) {
    return [{ kind: "delete", path }];
  }

  // A provider that names one path and hands over the diff itself. Cursor
  // reports every write this way (its ACP stream sends whole-file before and
  // after text, reduced to a diff in cursor_acp.rs), and it is the shape
  // measured diffs write back onto a Codex row.
  const provided = pickString(input, ["unified_diff", "diff", "patch"]);
  if (provided) {
    const hunks = parseUnifiedDiff(provided);
    const { adds, dels } = tallyHunks(hunks);
    if (hunks.length > 0) {
      return isCreationDiff(hunks, dels)
        ? [{ kind: "create", path, hunks, addCount: adds }]
        : [{ kind: "edit", path, hunks, addCount: adds, delCount: dels }];
    }
  }

  if (reportedOperation === "create" || reportedOperation === "add") {
    const content = typeof input.content === "string" ? input.content : "";
    return [makeCreate(path, content)];
  }

  if (isMultiEdit) {
    const edits = input.edits;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    const hunks: ParsedDiffBlock[] = [];
    let addCount = 0;
    let delCount = 0;
    let replaceAll = false;
    for (const raw of edits) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const pair = editPair(e);
      if (e.replace_all === true || e.replaceAll === true) replaceAll = true;
      const built = synthesizeHunk(pair.old, pair.new);
      const parsed = parseUnifiedDiff(built.diff);
      for (const block of parsed) hunks.push(block);
      addCount += built.adds;
      delCount += built.dels;
    }
    if (hunks.length === 0) return null;
    return [
      {
        kind: "edit",
        path,
        hunks,
        addCount,
        delCount,
        noLineNumbers: true,
        ...(replaceAll ? { note: "Applies to all matches" } : {})
      }
    ];
  }

  if (isEdit) {
    const pair = editPair(input);
    if (pair.old === "" && pair.new === "") return null;
    const tooLarge = pair.old.length + pair.new.length > MAX_INLINE_CHARS;
    if (tooLarge) {
      return [
        {
          kind: "edit",
          path,
          hunks: [],
          addCount: countLines(pair.new),
          delCount: countLines(pair.old),
          note: "Change too large to preview inline."
        }
      ];
    }
    const built = synthesizeHunk(pair.old, pair.new);
    const hunks = parseUnifiedDiff(built.diff);
    const replaceAll = input.replace_all === true || input.replaceAll === true;
    return [
      {
        kind: "edit",
        path,
        hunks,
        addCount: built.adds,
        delCount: built.dels,
        // These values are replacement snippets, not whole-file snapshots.
        // Their synthetic hunk starts at 1 only because the provider does not
        // report the real line. Showing that number would make it a false
        // clickable claim.
        noLineNumbers: true,
        ...(replaceAll ? { note: "Applies to all matches" } : {})
      }
    ];
  }

  // isWrite (Claude Write, Cursor writeToolCall, create_file)
  const content = typeof input.content === "string" ? input.content : "";
  return [makeCreate(path, content)];
}

function makeCreate(path: string, content: string): FileChange {
  if (looksBinary(content)) {
    return { kind: "create", path, hunks: [], addCount: 0, note: "Binary file — content not shown." };
  }
  if (content.length > MAX_INLINE_CHARS) {
    return {
      kind: "create",
      path,
      hunks: [],
      addCount: countLines(content),
      note: "File is too large to preview inline."
    };
  }
  const built = synthesizeHunk("", content);
  const hunks = parseUnifiedDiff(built.diff);
  return { kind: "create", path, hunks, addCount: built.adds };
}

function interpretCodexFileChange(input: Record<string, unknown>): FileChange[] | null {
  const changes = input.changes;
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const result: FileChange[] = [];
  for (const raw of changes) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const path = pickString(entry, ["path", "file_path", "filepath"]);
    if (!path) continue;
    const kind = codexChangeKind(entry);

    if (kind === "delete" || kind === "remove") {
      result.push({ kind: "delete", path });
      continue;
    }

    const addBag = objectAt(entry, "add") ?? objectAt(entry, "create");
    const updateBag = objectAt(entry, "update") ?? objectAt(entry, "edit");
    const diffString =
      pickString(entry, ["unified_diff", "diff", "patch"]) ??
      (updateBag ? pickString(updateBag, ["unified_diff", "diff", "patch"]) : null);

    if (kind === "add" || kind === "create" || addBag) {
      const content =
        (addBag ? pickString(addBag, ["content", "text"]) : null) ??
        pickString(entry, ["content", "text", "new_text"]);
      // Codex names a created path and sends no body, so the diff Argmax
      // measured from git is the only account of what landed. It reads as a
      // create either way: the file is still new to the tree.
      if (content === null && diffString) {
        const hunks = parseUnifiedDiff(diffString);
        // Current Codex sends a new file's body in `diff`, without unified
        // headers. Older and measured rows send a real unified diff.
        if (hunks.length === 0) {
          result.push(makeCreate(path, diffString));
        } else {
          result.push({ kind: "create", path, hunks, addCount: tallyHunks(hunks).adds });
        }
        continue;
      }
      result.push(makeCreate(path, content ?? ""));
      continue;
    }

    if (diffString) {
      const hunks = parseUnifiedDiff(diffString);
      const { adds, dels } = tallyHunks(hunks);
      result.push({ kind: "edit", path, hunks, addCount: adds, delCount: dels });
      continue;
    }

    const before = (updateBag ? pickString(updateBag, ["before", "old"]) : null) ??
      pickString(entry, ["before", "old"]);
    const after = (updateBag ? pickString(updateBag, ["after", "new"]) : null) ??
      pickString(entry, ["after", "new"]);
    if (before !== null || after !== null) {
      const built = synthesizeHunk(before ?? "", after ?? "");
      const hunks = parseUnifiedDiff(built.diff);
      result.push({ kind: "edit", path, hunks, addCount: built.adds, delCount: built.dels });
      continue;
    }

    // Recognised path + kind but no parseable content — surface a note rather
    // than vanishing the entry. Treat as edit so it gets amber styling.
    result.push({
      kind: "edit",
      path,
      hunks: [],
      addCount: 0,
      delCount: 0,
      note: "No diff content provided."
    });
  }
  return result.length > 0 ? result : null;
}

/** Codex app-server originally sent `kind: "update"` and now sends
 *  `kind: { type: "update", move_path: null }`. Accept both generations so
 *  creates and deletes do not silently degrade to generic edits. */
function codexChangeKind(entry: Record<string, unknown>): string | null {
  const direct = pickString(entry, ["kind", "type", "operation"]);
  if (direct) return direct.toLowerCase();
  const kind = objectAt(entry, "kind");
  return kind ? pickString(kind, ["type", "kind", "operation"])?.toLowerCase() ?? null : null;
}

export function synthesizeHunk(oldText: string, newText: string): { diff: string; adds: number; dels: number } {
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  const oldStart = oldLines.length === 0 ? 0 : 1;
  const newStart = newLines.length === 0 ? 0 : 1;
  const header = `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`;
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`)
  ].join("\n");
  return {
    diff: body.length > 0 ? `${header}\n${body}` : header,
    adds: newLines.length,
    dels: oldLines.length
  };
}

/** Whether a diff describes a file that did not exist before: git's own
 *  `@@ -0,0` marker for an empty left side, with nothing removed. */
function isCreationDiff(blocks: ParsedDiffBlock[], dels: number): boolean {
  if (dels > 0) return false;
  const first = blocks.find((block) => block.kind === "hunk");
  return first !== undefined && first.kind === "hunk" && first.header.startsWith("@@ -0,0 ");
}

function tallyHunks(blocks: ParsedDiffBlock[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const block of blocks) {
    if (block.kind !== "hunk") continue;
    for (const line of block.lines) {
      if (line.kind === "addition") adds += 1;
      else if (line.kind === "deletion") dels += 1;
    }
  }
  return { adds, dels };
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = input[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countLines(text: string): number {
  return textLines(text).length;
}

/** Logical file lines. A final newline terminates the preceding line; it does
 *  not create another empty one. More than one final newline still preserves
 *  the intentionally blank lines before the last terminator. */
function textLines(text: string): string[] {
  if (text === "") return [];
  return text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
}

function looksBinary(text: string): boolean {
  // Cheap heuristic — NUL byte presence in the first 4KB.
  const head = text.length > 4096 ? text.slice(0, 4096) : text;
  return head.indexOf(" ") !== -1;
}
