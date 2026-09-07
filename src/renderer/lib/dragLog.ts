import { listDragTypes } from "./composerAttachments.js";
import { recordRendererLog } from "./rendererLogRing.js";

// Breadcrumbs for every drag that crosses the window.
//
// Drag and drop dies in a way nothing else in the app records: after hours of
// use, dropping a screenshot on the composer or a sidebar row into the grid
// stops highlighting anything, and only relaunching brings it back. After the
// fact nothing distinguishes the three explanations — no drag event ever
// reached the page (the webview or the OS ate it), events reached it and no
// target took them (a renderer gate), or the last drag never ended and left
// WebKit's drag session open. One line per drag, plus a warning for a drag the
// page never sees finish, turns the next occurrence into a single lookup in
// Debug → Logs, scope `renderer::drag`.
//
// Read-only by construction: these listeners never call `preventDefault`, so
// they cannot themselves change which drops are taken.

const SCOPE = "renderer::drag";

/** One line per half-second of hovering. A drag across two panes is a handful
 *  of rows rather than one per frame. */
const OVER_SAMPLE_MS = 500;

/** A drag that goes this long with no further event and no `dragend` is over
 *  as far as anything can tell — the shape a wedged drag session leaves. */
const UNENDED_AFTER_MS = 15_000;

interface DragSequence {
  /** `dragstart` fired here. A Finder or screenshot-thumbnail drag enters
   *  mid-flight instead, and its `dragend` belongs to the other app. */
  startedInPage: boolean;
  dropped: boolean;
  overs: number;
  /** `dragover` events a target accepted by calling `preventDefault`. Zero
   *  across a whole drag is why nothing highlighted and nothing dropped. */
  accepted: number;
  lastSampleAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let sequence: DragSequence | null = null;

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "none";
  const tag = target.tagName.toLowerCase();
  const named = target.closest("[aria-label], [data-testid], [role]");
  const label =
    named?.getAttribute("aria-label") ??
    named?.getAttribute("data-testid") ??
    named?.getAttribute("role") ??
    null;
  return label === null ? tag : `${tag} in ${label}`;
}

function describeTypes(event: DragEvent): string {
  return event.dataTransfer === null ? "" : listDragTypes(event.dataTransfer).join(" ");
}

function endSequence(): void {
  if (sequence?.timer != null) clearTimeout(sequence.timer);
  sequence = null;
}

function armWatchdog(): void {
  const current = sequence;
  if (current === null) return;
  if (current.timer !== null) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    // A drag that came from another app has no `dragend` to wait for, so a
    // completed one is silence, not a finding.
    if (!(current.dropped && !current.startedInPage)) {
      recordRendererLog({
        scope: SCOPE,
        level: "warn",
        message: current.dropped
          ? "dropped, then no dragend — the drag source was probably unmounted"
          : "drag stopped without a drop or a dragend",
        fields: {
          startedInPage: String(current.startedInPage),
          dragovers: String(current.overs),
          accepted: String(current.accepted)
        }
      });
    }
    endSequence();
  }, UNENDED_AFTER_MS);
}

function beginSequence(startedInPage: boolean): DragSequence {
  endSequence();
  sequence = {
    startedInPage,
    dropped: false,
    overs: 0,
    accepted: 0,
    lastSampleAt: 0,
    timer: null
  };
  armWatchdog();
  return sequence;
}

/**
 * Watches the document for the whole drag lifecycle. Returns the uninstaller;
 * the app installs once at startup and never removes it.
 */
export function installDragBreadcrumbs(): () => void {
  const onDragStart = (event: DragEvent): void => {
    beginSequence(true);
    recordRendererLog({
      scope: SCOPE,
      message: "drag started",
      fields: { source: describeTarget(event.target), types: describeTypes(event) }
    });
  };

  const onDragEnter = (event: DragEvent): void => {
    if (sequence !== null) return;
    beginSequence(false);
    recordRendererLog({
      scope: SCOPE,
      message: "drag entered the window",
      fields: { target: describeTarget(event.target), types: describeTypes(event) }
    });
  };

  const onDragOver = (event: DragEvent): void => {
    const current = sequence ?? beginSequence(false);
    current.overs += 1;
    if (event.defaultPrevented) current.accepted += 1;
    armWatchdog();
    const now = Date.now();
    if (now - current.lastSampleAt < OVER_SAMPLE_MS) return;
    current.lastSampleAt = now;
    recordRendererLog({
      scope: SCOPE,
      message: "drag over",
      fields: {
        target: describeTarget(event.target),
        accepted: String(event.defaultPrevented),
        dragovers: String(current.overs)
      }
    });
  };

  const onDrop = (event: DragEvent): void => {
    const current = sequence ?? beginSequence(false);
    current.dropped = true;
    armWatchdog();
    recordRendererLog({
      scope: SCOPE,
      message: "drop",
      fields: {
        target: describeTarget(event.target),
        accepted: String(event.defaultPrevented),
        files: String(event.dataTransfer?.files.length ?? 0),
        types: describeTypes(event)
      }
    });
  };

  const onDragEnd = (): void => {
    const current = sequence;
    if (current === null) return;
    recordRendererLog({
      scope: SCOPE,
      message: "drag ended",
      fields: {
        dropped: String(current.dropped),
        dragovers: String(current.overs),
        accepted: String(current.accepted)
      }
    });
    endSequence();
  };

  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragenter", onDragEnter, true);
  // Bubble phase, after the app's own handlers: `defaultPrevented` is the only
  // way to see whether any target took the drag.
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);
  document.addEventListener("dragend", onDragEnd, true);

  return () => {
    document.removeEventListener("dragstart", onDragStart, true);
    document.removeEventListener("dragenter", onDragEnter, true);
    document.removeEventListener("dragover", onDragOver);
    document.removeEventListener("drop", onDrop);
    document.removeEventListener("dragend", onDragEnd, true);
    endSequence();
  };
}
