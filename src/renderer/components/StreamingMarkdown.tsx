import { createContext, useContext, lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type JSX, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip, normalizeFileChipPath } from "../lib/fileChipPath.js";
import { splitLogSegments } from "../lib/logDump.js";
import { isMermaidFenceClass } from "../lib/mermaidFence.js";
import type * as MarkdownBlocks from "../lib/markdownBlocks.js";
import type { MarkdownBlock, MarkdownBlockSplit } from "../lib/markdownBlocks.js";
import { revealBoundary } from "../lib/streamingText.js";
import { needsMath } from "../lib/needsMath.js";
import { importChunk } from "../lib/importChunk.js";
import {
  FRESH_RUN_FADE_MS,
  NO_FRESH_RUNS,
  paintFreshRuns,
  rehypeFreshRuns,
  trackFreshRuns,
  type FreshRun
} from "../lib/streamFreshRuns.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { LogBlock } from "./LogBlock.js";
import { MarkdownTable } from "./MarkdownTable.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";
import { WebLink } from "./WebLink.js";
import { withToast } from "../lib/withToast.js";
import { showToast } from "../state/toast.js";

// Through importChunk because a paired phone keeps its page alive across
// renderer rebuilds: the hashed chunk it asks for is gone, and a rejected
// lazy load inside the transcript takes the whole app to the error boundary.
const MermaidDiagram = lazy(() =>
  importChunk(async () => ({
    default: (await import("./MermaidDiagram.js")).MermaidDiagram
  }))
);

const ChatMathMarkdown = lazy(() =>
  importChunk(async () => ({
    default: (await import("./MathMarkdown.js")).ChatMathMarkdown
  }))
);

/** Seconds of arrived text the reveal keeps in hand. Enough to ride out the
    gaps between deliveries, so the writing never stops and starts, and little
    enough that the answer still reads as live. */
const REVEAL_LAG_S = 0.25;
/** How quickly the reveal's speed follows a change in delivery rate. Speed
    eases toward the target rather than jumping, so a burst of deltas speeds
    the writing up instead of landing as a block. */
const REVEAL_SPEED_SMOOTHING_S = 0.15;
/** Floor, so the last few words of a stream never crawl. */
const REVEAL_MIN_CHARS_PER_S = 60;
/** Ceiling for steady streaming (~15 words a frame would read as a jump). */
const REVEAL_MAX_CHARS_PER_S = 2400;
/** A larger backlog still lands within this long. Codex and OpenCode deliver a
    whole answer as one `message.completed`; it sweeps in rather than crawls. */
const REVEAL_BURST_S = 1.1;
/** A frame gap this long means the window was hidden or throttled. The text
    that arrived meanwhile had no reader, so it shows at once. */
const REVEAL_RESYNC_GAP_MS = 1000;
/** A block this short shows at once instead of being typed. */
const SMOOTH_STREAM_MIN_CHARS = 80;
/** Blocks to remember reveal progress for. Bounded so a long-running app can't
    accumulate an entry per streamed block for the rest of the process. */
const MAX_REMEMBERED_BLOCKS = 200;

/**
 * One animation-frame loop for every block that is revealing. A live turn with
 * subagents can have several bubbles typing at once across panes; one shared
 * loop lets React batch every bubble's advance into a single render per frame,
 * and the loop stops with the last block.
 */
const frameListeners = new Set<(now: number) => void>();
let frameHandle: number | null = null;

function runRevealFrame(now: number): void {
  frameHandle = null;
  for (const listener of frameListeners) listener(now);
  if (frameListeners.size > 0 && frameHandle === null) {
    frameHandle = window.requestAnimationFrame(runRevealFrame);
  }
}

function subscribeToRevealFrames(listener: (now: number) => void): () => void {
  frameListeners.add(listener);
  if (frameHandle === null) frameHandle = window.requestAnimationFrame(runRevealFrame);
  return () => {
    frameListeners.delete(listener);
    if (frameListeners.size === 0 && frameHandle !== null) {
      window.cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
  };
}

function chatUrlTransform(value: string): string {
  if (/^argmax-(?:asset|attachment):\/\//i.test(value)) return value;
  return defaultUrlTransform(value);
}

type BlockTools = typeof MarkdownBlocks;
let blockTools: BlockTools | null = null;
let blockToolsLoad: Promise<BlockTools> | null = null;

function loadBlockTools(): Promise<BlockTools> {
  blockToolsLoad ??= importChunk(() => import("../lib/markdownBlocks.js"));
  return blockToolsLoad;
}

// A block latches whole or split the first time it is live, so the tools must
// be here before the first answer of a fresh chat streams, when no earlier
// Markdown has mounted to fetch them. Fetch them once the chat code is idle.
if (typeof window !== "undefined") {
  const whenIdle = typeof window.requestIdleCallback === "function"
    ? (run: () => void) => window.requestIdleCallback(run)
    : (run: () => void) => window.setTimeout(run, 0);
  whenIdle(() => {
    loadBlockTools().then(
      (loaded) => {
        blockTools = loaded;
      },
      () => {
        blockToolsLoad = null;
      }
    );
  });
}

/** The block splitter and tail healer. Fetched at idle once this module loads,
    and by the first Markdown to mount if that has not landed yet. */
function useBlockTools(): BlockTools | null {
  const [tools, setTools] = useState(blockTools);
  useEffect(() => {
    if (tools) return;
    let cancelled = false;
    loadBlockTools().then(
      (loaded) => {
        blockTools = loaded;
        if (!cancelled) setTools(loaded);
      },
      () => {
        blockToolsLoad = null;
      }
    );
    return () => {
      cancelled = true;
    };
  }, [tools]);
  return tools;
}

/**
 * How much of each block the reader has already watched appear, kept outside
 * React because the component doesn't survive what it has to survive: switching
 * sessions remounts the whole pane, and a live block would otherwise type
 * itself out again from nothing every time the user came back to it.
 */
const revealedLengths = new Map<string, number>();

function rememberRevealed(key: string, length: number): void {
  // Re-insert so the map stays in least-recently-revealed order for trimming.
  revealedLengths.delete(key);
  revealedLengths.set(key, length);
  if (revealedLengths.size > MAX_REMEMBERED_BLOCKS) {
    const oldest = revealedLengths.keys().next();
    if (!oldest.done) revealedLengths.delete(oldest.value);
  }
}

function readPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (): void => setPrefersReducedMotion(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

function initialVisibleLength(
  length: number,
  streaming: boolean,
  revealKey: string | null | undefined
): number {
  if (!streaming || length <= SMOOTH_STREAM_MIN_CHARS) return length;
  // Text already revealed once is history, so resume there instead of retyping it.
  const revealed = revealKey ? revealedLengths.get(revealKey) : undefined;
  if (revealed !== undefined) return Math.min(revealed, length);
  // Text that arrived while the window was in the background never had a
  // reader. Showing it at once avoids finished bubbles typing out together
  // when the user comes back.
  if (typeof document !== "undefined" && document.hidden) return length;
  return 0;
}

type RevealState = {
  /** UTF-16 units shown so far, always on a word or surrogate boundary. */
  visible: number;
  /** The stream has ended but the block is still writing out its remainder. */
  finishing: boolean;
};

/**
 * The typewriter. Each frame moves a reveal position toward the end of the
 * arrived text at a speed that eases toward `backlog / REVEAL_LAG_S`: it keeps
 * about a quarter second of text in hand, so the words flow at the rate they
 * arrive, a burst speeds the writing up smoothly instead of landing in one
 * piece, and a pause in delivery drains to a stop rather than cutting off.
 * React only renders when the reveal crosses into a new word.
 */
function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  revealKey: string | null | undefined,
  restoring = false
): { text: string; revealing: boolean } {
  const prefersReducedMotion = usePrefersReducedMotion();
  const paced = streaming && !prefersReducedMotion && !restoring;
  const [reveal, setReveal] = useState<RevealState>(() => ({
    visible: initialVisibleLength(text.length, paced, revealKey),
    finishing: false
  }));
  const revealing = paced || reveal.finishing;
  const textRef = useRef(text);
  const streamingRef = useRef(streaming);
  const motionRef = useRef({ position: reveal.visible, speed: 0, lastFrame: null as number | null });

  useEffect(() => {
    if (revealKey && streaming) rememberRevealed(revealKey, reveal.visible);
  }, [revealKey, streaming, reveal.visible]);

  // A layout effect so the render that sees the stream end never paints: with
  // `finishing` still false it would show the whole block for one frame before
  // the catch-up reveal took over.
  useLayoutEffect(() => {
    textRef.current = text;
    streamingRef.current = streaming;
    const motion = motionRef.current;
    if (prefersReducedMotion || restoring) {
      motion.position = text.length;
      setReveal((current) =>
        current.visible === text.length && !current.finishing
          ? current
          : { visible: text.length, finishing: false }
      );
      return;
    }
    if (streaming) {
      setReveal((current) => {
        const visible =
          text.length <= SMOOTH_STREAM_MIN_CHARS && current.visible === 0
            ? text.length
            : Math.min(current.visible, text.length);
        if (visible < motion.position) motion.position = visible;
        return visible === current.visible && !current.finishing
          ? current
          : { visible, finishing: false };
      });
      return;
    }
    // The stream ended. Whatever is still unrevealed writes out at the pace it
    // was going rather than landing as one block.
    setReveal((current) => {
      const visible = Math.min(current.visible, text.length);
      const finishing = visible < text.length;
      return visible === current.visible && finishing === current.finishing
        ? current
        : { visible, finishing };
    });
  }, [prefersReducedMotion, restoring, streaming, text]);

  useEffect(() => {
    if (!revealing) return;
    const motion = motionRef.current;
    motion.lastFrame = null;
    return subscribeToRevealFrames((now) => {
      const current = textRef.current;
      const target = current.length;
      const lastFrame = motion.lastFrame;
      motion.lastFrame = now;
      if (document.hidden || (lastFrame !== null && now - lastFrame > REVEAL_RESYNC_GAP_MS)) {
        // Backgrounded or throttled: catch up silently. Pausing at the last
        // painted prefix made every finished bubble in a live turn type out
        // together when the user came back.
        motion.position = target;
        motion.speed = 0;
      } else if (motion.position < target) {
        const dt = lastFrame === null ? 1 / 60 : Math.max(0, now - lastFrame) / 1000;
        const backlog = target - motion.position;
        const wanted = Math.min(
          Math.max(backlog / REVEAL_LAG_S, REVEAL_MIN_CHARS_PER_S),
          Math.max(REVEAL_MAX_CHARS_PER_S, backlog / REVEAL_BURST_S)
        );
        motion.speed += (wanted - motion.speed) * (1 - Math.exp(-dt / REVEAL_SPEED_SMOOTHING_S));
        motion.position = Math.min(target, motion.position + Math.max(motion.speed, REVEAL_MIN_CHARS_PER_S) * dt);
      }
      const boundary = revealBoundary(current, motion.position, streamingRef.current);
      setReveal((state) => {
        const visible = Math.max(state.visible, Math.min(boundary, target));
        // The frame that lands the last character also ends the finishing
        // pass, so the block settles into its history rendering at once.
        const finishing = state.finishing && visible < target;
        return visible === state.visible && finishing === state.finishing ? state : { visible, finishing };
      });
    });
  }, [revealing]);

  if (!revealing || reveal.visible >= text.length) {
    return { text, revealing };
  }
  return { text: text.slice(0, reveal.visible), revealing };
}

/**
 * The runs of this block still fading up. Tracked during render, not in an
 * effect: the tick that reveals a run has to render it already marked, or its
 * characters land at full ink for a frame before the fade takes them back.
 */
function useFreshRuns(end: number, active: boolean): readonly FreshRun[] {
  const runsRef = useRef<readonly FreshRun[]>(NO_FRESH_RUNS);
  const lastEndRef = useRef<number | null>(null);
  const [, settle] = useReducer((count: number) => count + 1, 0);
  const runs = active
    ? trackFreshRuns(runsRef.current, lastEndRef.current, end, performance.now())
    // A block whose reveal just ended keeps its last runs until they have
    // finished; dropping them with the reveal would snap the final words to
    // full ink.
    : runsRef.current;
  runsRef.current = runs;
  lastEndRef.current = active ? end : null;

  // Nothing else re-renders a block once its stream is over, so the last runs
  // would stay in the tree. One wake-up, after the newest run has finished,
  // clears them all.
  const newest = runs.at(-1)?.at ?? null;
  useEffect(() => {
    if (newest === null) return;
    const timer = window.setTimeout(() => {
      runsRef.current = NO_FRESH_RUNS;
      settle();
    }, Math.max(newest + FRESH_RUN_FADE_MS - performance.now(), 0) + 16);
    return () => window.clearTimeout(timer);
  }, [newest]);

  return runs;
}

function MermaidDiagramFallback(): JSX.Element {
  return (
    <figure className="mermaid-diagram" data-state="pending" aria-label="Diagram">
      <p className="mermaid-diagram-pending" role="status">
        Drawing diagram
      </p>
    </figure>
  );
}

type MarkdownContextValue = {
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
};

const MarkdownContext = createContext<MarkdownContextValue>({});

// React Markdown treats these functions as component types. Keep them stable
// across dashboard updates so code scrollers and image state survive.
const markdownComponents: Components = {
  code: function MarkdownCode({ className, children, ...rest }) {
    const { workspace, onOpenFile } = useContext(MarkdownContext);
    const hasLanguage = typeof className === "string" && className.includes("language-");
    const codeText = Array.isArray(children)
      ? children.map((c) => (typeof c === "string" ? c : "")).join("")
      : typeof children === "string"
        ? children
        : "";
    if (isMermaidFenceClass(className)) {
      return (
        <Suspense fallback={<MermaidDiagramFallback />}>
          <MermaidDiagram source={codeText.replace(/\n$/, "")} />
        </Suspense>
      );
    }
    if (hasLanguage || codeText.includes("\n")) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    const match = matchFileChip(codeText);
    if (match) {
      const path = normalizeFileChipPath(match.path, workspace?.path);
      return (
        <FileChip
          path={path}
          line={match.line}
          workspaceId={workspace?.id ?? null}
          workspaceCwd={workspace?.path ?? null}
          onOpen={onOpenFile}
        />
      );
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
  a: function MarkdownAnchor({ href, children, ...rest }) {
    const { workspace, onOpenFile } = useContext(MarkdownContext);
    if (!href || href.startsWith("#")) {
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    }
    if (/^https?:/i.test(href) || href.startsWith("//")) {
      return (
        <WebLink href={href.startsWith("//") ? `https:${href}` : href} {...rest}>
          {children}
        </WebLink>
      );
    }
    if (/^mailto:/i.test(href)) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
          {children}
        </a>
      );
    }
    const normalizedHref = normalizeFileChipPath(href, workspace?.path);
    const match = matchFileChip(normalizedHref);
    if (!match) {
      return (
        <a
          href={href}
          {...rest}
          onClick={(event) => {
            // Directory and extensionless links must never navigate the app webview.
            event.preventDefault();
            const api = window.argmax;
            if (!api) return;
            const path = normalizeFileChipPath(href, null);
            void withToast(
              () => api.system.openPath({
                path,
                cwd: path.startsWith("/") ? undefined : workspace?.path
              }),
              showToast,
              "Could not open this path."
            );
          }}
        >
          {children}
        </a>
      );
    }
    return (
      <FileChip
        path={match.path}
        line={match.line}
        workspaceId={workspace?.id ?? null}
        workspaceCwd={workspace?.path ?? null}
        onOpen={onOpenFile}
      />
    );
  },
  img: function MarkdownImg({ src, alt }) {
    const { workspace, onOpenFile } = useContext(MarkdownContext);
    return (
      <MarkdownImage
        src={src}
        alt={alt}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    );
  },
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  pre: ({ children }) => <>{children}</>
};

/**
 * Parsed trees of settled Markdown, keyed by the text. `ReactMarkdown` is a
 * pure function of its source, and a chat reopened after a switch parsed
 * every message again (about 19 ms of a switch's script). The trees hold no
 * state: components inside them still mount fresh and read the current
 * workspace from context. Bounded by source characters, least recent first.
 */
const parsedMarkdown = new Map<string, JSX.Element>();
let parsedMarkdownChars = 0;
const PARSED_MARKDOWN_CHAR_LIMIT = 4_000_000;

function parsedMarkdownTree(text: string): JSX.Element {
  const cached = parsedMarkdown.get(text);
  if (cached) {
    parsedMarkdown.delete(text);
    parsedMarkdown.set(text, cached);
    return cached;
  }
  const tree = ReactMarkdown({
    children: text,
    remarkPlugins: [remarkGfm],
    urlTransform: chatUrlTransform,
    components: markdownComponents
  });
  parsedMarkdown.set(text, tree);
  parsedMarkdownChars += text.length;
  for (const [oldest] of parsedMarkdown) {
    if (parsedMarkdownChars <= PARSED_MARKDOWN_CHAR_LIMIT) break;
    parsedMarkdown.delete(oldest);
    parsedMarkdownChars -= oldest.length;
  }
  return tree;
}

// Keep the plain render visible while the optional math chunk loads.
const MarkdownBody = memo(function MarkdownBody({
  text,
  freshRuns,
  settled = false,
  workspace,
  onOpenFile
}: MarkdownContextValue & {
  text: string;
  freshRuns?: readonly FreshRun[];
  /** The text will not change: a finished message, or a closed block of a
      live one. Only settled text is worth keeping parsed. */
  settled?: boolean;
}): JSX.Element {
  const context = useMemo(() => ({ workspace, onOpenFile }), [workspace, onOpenFile]);
  const withMath = needsMath(text);
  // Math renders through its own pipeline, where a span cut into a formula's
  // source would be a rendering bug rather than a fade.
  const rehypePlugins = useMemo(
    () => (freshRuns && freshRuns.length > 0 && !withMath ? [rehypeFreshRuns(freshRuns)] : undefined),
    [freshRuns, withMath]
  );
  // Settled text renders from the parse cache. Live text changes every frame,
  // and a fading block's tree changes with its runs, so those parse as they go.
  // Both paths call the parser directly rather than mounting a
  // <ReactMarkdown> element, so the tree has the same shape either way and a
  // block settling keeps its DOM (and a code block its scroll position).
  const plain = withMath ? (
    // Only the fallback while the math chunk loads, so it stays lazy.
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={chatUrlTransform} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  ) : !settled || rehypePlugins
      ? ReactMarkdown({
          children: text,
          remarkPlugins: [remarkGfm],
          rehypePlugins,
          urlTransform: chatUrlTransform,
          components: markdownComponents
        })
      : parsedMarkdownTree(text);
  return (
    <MarkdownContext.Provider value={context}>
      {withMath ? (
        <Suspense fallback={plain}>
          <ChatMathMarkdown text={text} components={markdownComponents} urlTransform={chatUrlTransform} />
        </Suspense>
      ) : plain}
    </MarkdownContext.Provider>
  );
});

/** Fresh runs clipped and shifted into one block's own offsets. The same
    array comes back while nothing about the block's runs changed, so a
    finished block is not re-parsed every frame while the tail is writing. */
function blockFreshRuns(
  runs: readonly FreshRun[],
  block: MarkdownBlock,
  cache: Map<number, readonly FreshRun[]>
): readonly FreshRun[] {
  const end = block.start + block.text.length;
  const inside: FreshRun[] = [];
  for (const run of runs) {
    if (run.end <= block.start || run.start >= end) continue;
    inside.push({
      start: Math.max(0, run.start - block.start),
      end: Math.min(block.text.length, run.end - block.start),
      at: run.at
    });
  }
  const previous = cache.get(block.start) ?? NO_FRESH_RUNS;
  const same =
    previous.length === inside.length &&
    inside.every(
      (run, index) =>
        run.start === previous[index].start && run.end === previous[index].end && run.at === previous[index].at
    );
  const next = same ? previous : inside.length === 0 ? NO_FRESH_RUNS : inside;
  cache.set(block.start, next);
  return next;
}

export function StreamingMarkdown({
  text,
  streaming,
  paced = true,
  restoring = false,
  revealKey,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  /** Reveal a streaming block at the typewriter cadence. Off, the block shows
      every character as it arrives. */
  paced?: boolean;
  /** The pane is painting content that was already there (session switch
      remount). Already-arrived text shows in full; only growth after restore
      is typed. */
  restoring?: boolean;
  /** Stable identity for this block of text, unique across sessions and turns.
      Without one, a streaming block restarts its reveal on every remount. */
  revealKey?: string | null;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element | null {
  const { text: visibleText, revealing } = useSmoothStreamingText(
    text,
    streaming && paced,
    revealKey,
    restoring
  );
  // A block still typing out its remainder after the stream ended keeps the
  // live rendering path until the last character lands.
  const live = streaming || revealing;
  // Whether this block renders block by block is decided once, the first
  // time it is live, and kept: finishing must not swap its DOM for a
  // whole-document render, nor may the tools arriving mid-stream swap it the
  // other way. History that was never live renders as one document.
  const splitRef = useRef<MarkdownBlockSplit | null>(null);
  const tools = useBlockTools();
  const splitModeRef = useRef<boolean | null>(null);
  if (live && splitModeRef.current === null) splitModeRef.current = tools !== null;
  const segments = useMemo(() => splitLogSegments(visibleText), [visibleText]);
  const hasLogs = segments.some((segment) => segment.kind === "log");
  const markdownText = hasLogs ? visibleText : segments.map((segment) => segment.text).join("");
  const splitMode = splitModeRef.current === true;
  const split = useMemo(
    () => (tools && splitMode && !hasLogs ? tools.splitMarkdownBlocks(markdownText, splitRef.current) : null),
    [tools, splitMode, hasLogs, markdownText]
  );
  useLayoutEffect(() => {
    splitRef.current = split;
  }, [split]);
  const blockRunsRef = useRef(new Map<number, readonly FreshRun[]>());
  // A fresh run is an offset into the markdown the parser sees. Lifting a log
  // dump out of the prose moves every offset after it, so a block with logs in
  // it reveals the way it always did.
  const freshRuns = useFreshRuns(
    visibleText.length,
    // Only the typewriter's own output fades. An unpaced block — a live thought
    // — still drains its remainder through `revealing`, and its words are not
    // the answer being written.
    revealing && paced && markdownText.length === visibleText.length
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // After the paint that adds a run, never before it: the fade has to be on the
  // span in the same frame its characters appear.
  useLayoutEffect(() => {
    if (freshRuns.length > 0) paintFreshRuns(bodyRef.current);
  });
  if (segments.length === 0 && visibleText.length > 0) return null;

  let body: ReactNode;
  if (hasLogs) {
    body = segments.map((segment, index) =>
      segment.kind === "log" ? (
        <LogBlock key={`log-${index}`} text={segment.text} />
      ) : (
        <div key={`md-${index}`} className="markdown">
          <MarkdownBody text={segment.text} settled={!live} workspace={workspace} onOpenFile={onOpenFile} />
        </div>
      )
    );
  } else if (split) {
    // Only the last block is still being written, so only it re-parses as the
    // reveal advances; the others keep their rendering, and a finished code
    // block highlights the moment the next block starts.
    body = split.blocks.map((block, index) => {
      const open = live && index === split.blocks.length - 1;
      return (
        <StreamingCodeContext.Provider key={block.start} value={open}>
          <MarkdownBody
            text={open && tools ? tools.healStreamingTail(block.text) : block.text}
            freshRuns={blockFreshRuns(freshRuns, block, blockRunsRef.current)}
            settled={index < split.blocks.length - 2 || !live}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        </StreamingCodeContext.Provider>
      );
    });
  } else {
    body = (
      <MarkdownBody
        text={markdownText}
        freshRuns={freshRuns}
        settled={!live}
        workspace={workspace}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div
      ref={bodyRef}
      className={
        hasLogs
          ? `markdown-with-logs${live ? " markdown-streaming" : ""}`
          : `markdown${live ? " markdown-streaming" : ""}`
      }
    >
      {split ? body : <StreamingCodeContext.Provider value={live}>{body}</StreamingCodeContext.Provider>}
    </div>
  );
}
