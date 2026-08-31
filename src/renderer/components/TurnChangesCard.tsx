import {
  Braces,
  ChevronRight,
  Cog,
  FileText,
  FlaskConical,
  Hash,
  SquareCode,
  Terminal,
  type LucideIcon
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { displayPath } from "../lib/displayPath.js";
import { fileFamily, type FileFamily } from "../lib/fileFamily.js";
import { summarizeTurnFileChanges, type TurnFileChange } from "../lib/turnFileChanges.js";
import type { FileChipOpenOptions } from "./FileChip.js";

// One glyph per family, and each a different shape. A single file outline
// recolored seven ways reads as a repeated blob down the column; a hash, a pair
// of braces and a flask are told apart before the name is read.
const FAMILY_ICONS: Record<FileFamily, LucideIcon> = {
  script: SquareCode,
  style: Hash,
  test: FlaskConical,
  rust: Cog,
  data: Braces,
  shell: Terminal,
  doc: FileText
};

const KIND_LABELS: Record<TurnFileChange["kind"], string> = {
  create: "Created",
  edit: "Edited",
  delete: "Deleted"
};

/**
 * The files a finished turn wrote, as one card under the turn's last reply.
 * A row opens that file's diff in the review panel; the header's Review action
 * opens the panel from the top. The header itself toggles the list, and which
 * state a turn starts in is a setting (`argmax.turnChanges.expanded`).
 */
export function TurnChangesCard({
  changes,
  workspaceCwd,
  defaultExpanded = true,
  onOpenDiff,
  onOpenFile,
  onOpenReview
}: {
  changes: readonly TurnFileChange[];
  workspaceCwd?: string | null;
  defaultExpanded?: boolean;
  /** Open this file's diff in the review panel's Changes view. What a row is
   *  for: the question a changed-files row raises is "what changed", and the
   *  file-tree preview answers a different one. */
  onOpenDiff?: (path: string) => void;
  /** Fallback for a host with no Changes view of its own (the mobile shell). */
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  onOpenReview?: () => void;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const totals = useMemo(() => summarizeTurnFileChanges(changes), [changes]);
  const rows = useMemo(
    () =>
      changes.map((change) => {
        const shown = displayPath(change.path, workspaceCwd);
        const slash = shown.lastIndexOf("/");
        // Name only. A transcript is scanned for "which file", and the
        // directory repeats what its neighbours already say — it stays in the
        // row's tooltip and accessible name, where it settles the rare case of
        // two files sharing a basename.
        return {
          change,
          name: slash === -1 ? shown : shown.slice(slash + 1),
          relativePath: shown
        };
      }),
    [changes, workspaceCwd]
  );

  if (rows.length === 0) return null;

  const fileLabel = `${totals.files} ${totals.files === 1 ? "file" : "files"} changed`;

  return (
    <section className="turn-changes" data-expanded={expanded ? "true" : undefined}>
      <div className="turn-changes-head">
        <button
          type="button"
          className="turn-changes-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Hide ${fileLabel}` : `Show ${fileLabel}`}
          onClick={() => setExpanded((open) => !open)}
        >
          <ChevronRight
            size={12}
            className={`turn-changes-chevron${expanded ? " expanded" : ""}`}
            aria-hidden="true"
          />
          <span className="turn-changes-title">{fileLabel}</span>
          <TurnChangesStat adds={totals.adds} dels={totals.dels} />
        </button>
        {onOpenReview ? (
          <button
            type="button"
            className="turn-changes-review"
            aria-label="Review changed files"
            onClick={onOpenReview}
          >
            Review
          </button>
        ) : null}
      </div>
      {expanded ? (
        <div className="turn-changes-list">
          {rows.map(({ change, name, relativePath }) => {
            const family = fileFamily(change.path);
            const Icon = FAMILY_ICONS[family];
            return (
              <button
                type="button"
                key={change.path}
                className="turn-changes-row"
                data-family={family}
                data-kind={change.kind}
                aria-label={`${KIND_LABELS[change.kind]} ${relativePath}`}
                title={change.path}
                // The review panel keys on workspace-relative paths, so hand it
                // the relativized path — the agent's own path is absolute.
                onClick={() => (onOpenDiff ? onOpenDiff(relativePath) : onOpenFile?.(relativePath))}
              >
                <Icon className="turn-changes-icon" size={13} aria-hidden="true" />
                <span className="turn-changes-name">{name}</span>
                <TurnChangesStat adds={change.adds} dels={change.dels} />
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

/** The `+N −N` stat. Adds and deletes each get their own cell so the digits
 *  line up down the card instead of drifting with the size of the number. */
function TurnChangesStat({ adds, dels }: { adds: number; dels: number }): JSX.Element | null {
  if (adds === 0 && dels === 0) return null;
  return (
    <span className="turn-changes-stat">
      <span className="turn-changes-add">{adds > 0 ? `+${adds}` : ""}</span>
      <span className="turn-changes-del">{dels > 0 ? `\u2212${dels}` : ""}</span>
    </span>
  );
}
