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

export function interpretFileChange(
  name: string,
  input: Record<string, unknown>
): FileChange[] | null {
  const lower = name.toLowerCase();

  // Notebook edits don't fit the line-diff abstraction — let the fallback
  // render today's view.
  if (lower.includes("notebook")) return null;

  // Codex bundles multiple files under a single tool call.
  if (lower === "file_change" || lower === "file-change" || lower === "filechange") {
    return interpretCodexFileChange(input);
  }

  // Single-file family — recognise by substring. Cursor uses camelCase like
  // `writeToolCall`, so a substring match catches both Claude and Cursor.
  const isMultiEdit = /multi[_-]?edit/.test(lower);
  const isWrite =
    !isMultiEdit && (lower.includes("write") || lower.includes("create_file") || lower.includes("createfile"));
  const isEdit =
    !isMultiEdit && (lower.includes("edit") || lower.includes("patch") || lower.includes("update_file"));
  const isDelete =
    lower.includes("delete") || lower.includes("remove_file") || lower.includes("removefile");

  if (!isWrite && !isEdit && !isMultiEdit && !isDelete) return null;

  const path = pickString(input, ["file_path", "filepath", "path", "relative_path", "absolute_path"]);
  if (!path) return null;

  if (isDelete && !isWrite && !isEdit) {
    return [{ kind: "delete", path }];
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
      const oldStr = typeof e.old_string === "string" ? e.old_string : "";
      const newStr = typeof e.new_string === "string" ? e.new_string : "";
      if (e.replace_all === true) replaceAll = true;
      const built = synthesizeHunk(oldStr, newStr);
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
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (oldStr === "" && newStr === "") return null;
    const tooLarge = oldStr.length + newStr.length > MAX_INLINE_CHARS;
    if (tooLarge) {
      return [
        {
          kind: "edit",
          path,
          hunks: [],
          addCount: countLines(newStr),
          delCount: countLines(oldStr),
          note: "Change too large to preview inline."
        }
      ];
    }
    const built = synthesizeHunk(oldStr, newStr);
    const hunks = parseUnifiedDiff(built.diff);
    const replaceAll = input.replace_all === true;
    return [
      {
        kind: "edit",
        path,
        hunks,
        addCount: built.adds,
        delCount: built.dels,
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
    const kind = pickString(entry, ["kind", "type", "operation"])?.toLowerCase() ?? null;

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
        pickString(entry, ["content", "text", "new_text"]) ??
        "";
      result.push(makeCreate(path, content));
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

export function synthesizeHunk(oldText: string, newText: string): { diff: string; adds: number; dels: number } {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
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
  if (text === "") return 0;
  return text.split("\n").length;
}

function looksBinary(text: string): boolean {
  // Cheap heuristic — NUL byte presence in the first 4KB.
  const head = text.length > 4096 ? text.slice(0, 4096) : text;
  return head.indexOf(" ") !== -1;
}
