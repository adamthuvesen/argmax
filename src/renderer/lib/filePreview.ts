import { useEffect, useState } from "react";
import { BoundedMap } from "../../shared/boundedSet.js";

export interface FilePreviewData {
  snippet: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  targetLine: number | null;
}

// Module-level cache keyed by workspaceId|path|line. Bounded so a long session
// browsing many files can't grow it without limit; the cost of an evicted (or
// stale) entry is one tooltip re-fetch — the user clicks through to the live
// file anyway.
const previewCache = new BoundedMap<string, FilePreviewData>(500);

interface FetchPreviewArgs {
  workspaceId: string;
  path: string;
  line: number | null;
  contextLines?: number;
  maxLines?: number;
}

export async function fetchFilePreview({
  workspaceId,
  path,
  line,
  contextLines = 5,
  maxLines = 14
}: FetchPreviewArgs): Promise<FilePreviewData> {
  const cacheKey = `${workspaceId}|${path}|${line ?? "?"}`;
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;
  if (!window.argmax) throw new Error("IPC bridge not available");
  const result = await window.argmax.workspace.readFile(workspaceId, path);
  if (result.kind !== "text") {
    const reason =
      result.reason === "binary"
        ? "Binary file"
        : result.reason === "too-large"
          ? "File too large"
          : "Not a file";
    throw new Error(reason);
  }
  const allLines = result.content.split("\n");
  const totalLines = allLines.length;
  let startLine = 1;
  let endLine = Math.min(totalLines, maxLines);
  if (typeof line === "number" && Number.isFinite(line) && line >= 1) {
    startLine = Math.max(1, line - contextLines);
    endLine = Math.min(totalLines, line + contextLines);
    if (endLine - startLine + 1 > maxLines) {
      const half = Math.floor((maxLines - 1) / 2);
      startLine = Math.max(1, line - half);
      endLine = Math.min(totalLines, startLine + maxLines - 1);
    }
  }
  const snippet = allLines.slice(startLine - 1, endLine).join("\n");
  const data: FilePreviewData = {
    snippet,
    startLine,
    endLine,
    totalLines,
    targetLine: typeof line === "number" && Number.isFinite(line) ? line : null
  };
  previewCache.set(cacheKey, data);
  return data;
}

interface UseFilePreviewArgs {
  workspaceId: string | null;
  path: string;
  line: number | null;
  active: boolean;
}

export interface UseFilePreviewResult {
  data: FilePreviewData | null;
  loading: boolean;
  error: string | null;
}

export function useFilePreview({ workspaceId, path, line, active }: UseFilePreviewArgs): UseFilePreviewResult {
  const [data, setData] = useState<FilePreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !workspaceId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFilePreview({ workspaceId, path, line })
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load preview");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, path, line]);

  return { data, loading, error };
}
