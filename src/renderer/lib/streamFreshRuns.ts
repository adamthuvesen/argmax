import type { Element, Nodes, Parents, RootContent } from "hast";

/**
 * The streaming reveal's fade. `StreamingMarkdown` uncovers a block a tick at a
 * time; without help, each tick's characters land at full ink and the answer
 * reads as a stutter of blocks rather than as writing. A *fresh run* is one
 * tick's characters: the reveal records where each one started and when, the
 * rehype plugin below splits the rendered tree at those offsets, and
 * `paintFreshRuns` fades each run up from the ground.
 *
 * Opacity, and only opacity: it composites, so several runs can fade at once in
 * every open bubble without repainting the words underneath. The phase comes
 * from the wall clock rather than from the element, because a run does not keep
 * one element — re-parsing the markdown every tick hands a run's text to
 * whatever span sits in that position now. Anchoring each animation's
 * `startTime` to the moment the text was revealed makes that handover invisible.
 */

export const FRESH_RUN_CLASS = "stream-fresh";

/** How long a run takes to reach full ink. About six ticks: enough runs are in
    flight at once to read as one soft gradient behind the writing head. */
export const FRESH_RUN_FADE_MS = 420;

/** Where a run starts, against the ground. */
const FRESH_RUN_FROM_OPACITY = 0.3;

/** One tick's worth of revealed text: `[start, end)` in the markdown source. */
export type FreshRun = {
  start: number;
  end: number;
  /** `performance.now()` when the run was first shown. */
  at: number;
};

export const NO_FRESH_RUNS: readonly FreshRun[] = [];

/** Drops the runs that have finished fading, keeping the array's identity while
    nothing changes so the markdown body can skip a re-parse. */
export function expireFreshRuns(runs: readonly FreshRun[], now: number): readonly FreshRun[] {
  const live = runs.filter((run) => run.at > now - FRESH_RUN_FADE_MS);
  if (live.length === runs.length) return runs;
  return live.length === 0 ? NO_FRESH_RUNS : live;
}

/**
 * The runs still fading, given what was revealed last render. `lastEnd` is null
 * for a block that has not been seen before, and a shrinking `end` means the
 * block was replaced — neither fades, so restored history never types itself in.
 */
export function trackFreshRuns(
  previous: readonly FreshRun[],
  lastEnd: number | null,
  end: number,
  now: number
): readonly FreshRun[] {
  if (lastEnd === null || end < lastEnd) return NO_FRESH_RUNS;
  return expireFreshRuns(
    end > lastEnd ? [...previous, { start: lastEnd, end, at: now }] : previous,
    now
  );
}

/** Tags whose text is not prose: a code block has its own reveal, and fading
    its lines would fight the highlighter's own committed/tail split. */
const OPAQUE_TAGS = new Set(["code", "pre"]);

function runAt(runs: readonly FreshRun[], offset: number): FreshRun | null {
  for (const run of runs) {
    if (offset >= run.start && offset < run.end) return run;
  }
  return null;
}

function freshElement(value: string, run: FreshRun): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { className: [FRESH_RUN_CLASS], dataAt: String(Math.round(run.at)) },
    children: [{ type: "text", value }]
  };
}

/**
 * Splits every text node that overlaps a fresh run, wrapping each piece in a
 * span the painter can find. Nodes the parser gave no position — anything a
 * plugin generated rather than read — are left alone, as is everything before
 * the oldest run: that text has already settled.
 */
export function rehypeFreshRuns(runs: readonly FreshRun[]) {
  const oldest = runs.reduce((low, run) => Math.min(low, run.start), Number.POSITIVE_INFINITY);
  return function attach() {
    return function transform(tree: Nodes): void {
      if (runs.length === 0) return;
      visit(tree as Parents);
    };
  };

  function visit(parent: Parents): void {
    if (!("children" in parent)) return;
    const next: RootContent[] = [];
    let changed = false;
    for (const child of parent.children) {
      const end = child.position?.end.offset;
      if (child.type === "element") {
        if (!OPAQUE_TAGS.has(child.tagName) && (end === undefined || end > oldest)) visit(child);
        next.push(child);
        continue;
      }
      const start = child.position?.start.offset;
      if (child.type !== "text" || start === undefined || end === undefined || end <= oldest) {
        next.push(child);
        continue;
      }
      const pieces = split(child.value, start);
      changed = changed || pieces.length > 1 || pieces[0] !== child;
      next.push(...pieces);
    }
    if (changed) parent.children = next;
  }

  /** The node's text, cut wherever a run begins or ends inside it. A cut is
      placed by source offset, so an escape or an entity earlier in the same
      node moves it by the characters the source spent on them — a word either
      side of where the tick landed, never a wrong character. */
  function split(value: string, start: number): RootContent[] {
    const cuts = new Set<number>([0, value.length]);
    for (const run of runs) {
      for (const offset of [run.start - start, run.end - start]) {
        if (offset > 0 && offset < value.length) cuts.add(offset);
      }
    }
    const bounds = [...cuts].sort((a, b) => a - b);
    const pieces: RootContent[] = [];
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const from = bounds[index];
      const to = bounds[index + 1];
      const text = value.slice(from, to);
      const run = runAt(runs, start + from);
      pieces.push(run ? freshElement(text, run) : { type: "text", value: text });
    }
    return pieces;
  }
}

type Fade = { at: number; animation: Animation };

const fades = new WeakMap<HTMLElement, Fade>();

/**
 * Puts every fresh run inside `root` on a fade anchored to when it was
 * revealed. Runs a run's animation from the shared document timeline, so a span
 * that changed hands between ticks picks the fade up mid-way instead of
 * starting over — which is what an element-bound CSS animation would do.
 */
export function paintFreshRuns(root: HTMLElement | null): void {
  // A run's `at` is wall clock, and an animation's `startTime` is on the
  // document's timeline. The two share an origin in Blink but not in WebKit,
  // where the timeline starts at the document and the difference is however
  // long the app has been open — enough to park every fade before its first
  // frame, holding the run at the ground for good.
  // `timeline` is missing in jsdom and null before the document's first frame.
  const timeline = Number(root?.ownerDocument.timeline?.currentTime);
  if (root === null || !Number.isFinite(timeline)) return;
  const now = performance.now();
  const startedAt = (at: number): number => timeline - (now - at);
  for (const node of root.querySelectorAll<HTMLElement>(`.${FRESH_RUN_CLASS}`)) {
    const at = Number(node.dataset.at);
    if (!Number.isFinite(at)) continue;
    const fade = fades.get(node);
    if (fade) {
      if (fade.at !== at) {
        fade.at = at;
        fade.animation.startTime = startedAt(at);
      }
      continue;
    }
    // jsdom and any engine without the Web Animations API: the run stays at its
    // own ink, which is the reveal the app had before the fade.
    if (typeof node.animate !== "function") return;
    const animation = node.animate(
      [{ opacity: String(FRESH_RUN_FROM_OPACITY) }, { opacity: "1" }],
      { duration: FRESH_RUN_FADE_MS, easing: "ease-out", fill: "both" }
    );
    animation.startTime = startedAt(at);
    // Cancelling on finish drops the held value and the animation with it; the
    // run is at its own ink by then, and a long answer never accumulates one
    // live animation per tick it has streamed.
    animation.addEventListener("finish", () => {
      fades.delete(node);
      animation.cancel();
    });
    fades.set(node, { at, animation });
  }
}
