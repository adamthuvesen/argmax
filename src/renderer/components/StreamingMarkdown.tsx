import { lazy, memo, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip, normalizeFileChipPath } from "../lib/fileChipPath.js";
import { splitLogSegments } from "../lib/logDump.js";
import { isMermaidFenceClass } from "../lib/mermaidFence.js";
import { needsMath } from "../lib/needsMath.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { LogBlock } from "./LogBlock.js";
import { MarkdownTable } from "./MarkdownTable.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";
import { WebLink } from "./WebLink.js";

const MermaidDiagram = lazy(async () => ({
  default: (await import("./MermaidDiagram.js")).MermaidDiagram
}));

const ChatMathMarkdown = lazy(async () => ({
  default: (await import("./MathMarkdown.js")).ChatMathMarkdown
}));

const SMOOTH_STREAM_TICK_MS = 32;
/** Floor of the typewriter: what a block reveals per tick once it has caught up
    with delivery (~156 characters a second). */
const SMOOTH_STREAM_MIN_CHARS_PER_TICK = 5;
const SMOOTH_STREAM_MIN_CHARS = 80;
/** Ticks a newly arrived backlog is spread over (~1.3 s). Delivery is not
    typewriter-shaped: Claude sends ~130-character chunks every 0.7 s, Codex
    and OpenCode land the whole answer as one `message.completed`, and Cursor
    fires a burst of word-sized deltas inside a few hundred milliseconds. A
    fixed cadence fell behind every one of them, and whatever was still
    unrevealed when the block stopped streaming was dumped in one piece.
    Pacing each new backlog over a bounded window keeps a live stream a beat
    behind delivery and gives an atomic answer a visible sweep instead of a
    fourteen-second crawl. The same window finishes a block whose stream has
    ended, so the end of a turn completes the reveal rather than cutting it
    short. */
const SMOOTH_STREAM_DRAIN_TICKS = 40;
/** Blocks to remember reveal progress for. Bounded so a long-running app can't
    accumulate an entry per streamed block for the rest of the process. */
const MAX_REMEMBERED_BLOCKS = 200;

function chatUrlTransform(value: string): string {
  if (/^argmax-(?:asset|attachment):\/\//i.test(value)) return value;
  return defaultUrlTransform(value);
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
  return revealed === undefined ? 0 : Math.min(revealed, length);
}

/** Code points in `text`, without materialising the character array. */
function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // A high surrogate and its low surrogate are one code point.
    if (code >= 0xd800 && code <= 0xdbff) index += 1;
    length += 1;
  }
  return length;
}

type RevealState = {
  /** Code points shown so far. */
  visible: number;
  /** The stream has ended but the block is still typing out its remainder. */
  finishing: boolean;
};

type RevealPace = {
  forTarget: number;
  finishing: boolean;
  charsPerTick: number;
};

function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  revealKey: string | null | undefined
): { text: string; revealing: boolean } {
  const prefersReducedMotion = usePrefersReducedMotion();
  const paced = streaming && !prefersReducedMotion;
  const [reveal, setReveal] = useState<RevealState>(() => ({
    visible: initialVisibleLength(streaming ? codePointLength(text) : text.length, streaming, revealKey),
    finishing: false
  }));
  const revealing = paced || reveal.finishing;
  // Settled answers and unpaced reasoning never slice by code point. Keeping
  // their character arrays retained one array slot per character in history.
  const textCharacters = useMemo(() => (revealing ? Array.from(text) : null), [revealing, text]);
  const targetLength = textCharacters?.length ?? text.length;
  const targetLengthRef = useRef(targetLength);
  const paceRef = useRef<RevealPace>({
    forTarget: -1,
    finishing: false,
    charsPerTick: SMOOTH_STREAM_MIN_CHARS_PER_TICK
  });

  useEffect(() => {
    if (revealKey && streaming) rememberRevealed(revealKey, reveal.visible);
  }, [revealKey, streaming, reveal.visible]);

  // A layout effect so the render that sees the stream end never paints: with
  // `finishing` still false it would show the whole block for one frame before
  // the catch-up reveal took over.
  useLayoutEffect(() => {
    targetLengthRef.current = targetLength;
    if (prefersReducedMotion) {
      setReveal((current) =>
        current.visible === targetLength && !current.finishing
          ? current
          : { visible: targetLength, finishing: false }
      );
      return;
    }
    if (streaming) {
      setReveal((current) => {
        const visible =
          targetLength <= SMOOTH_STREAM_MIN_CHARS && current.visible === 0
            ? targetLength
            : Math.min(current.visible, targetLength);
        return visible === current.visible && !current.finishing
          ? current
          : { visible, finishing: false };
      });
      return;
    }
    // The stream ended. Whatever is still unrevealed types out at a catch-up
    // pace rather than landing as one block. `visible` counts code points and
    // `text.length` UTF-16 units, so reaching the latter proves the block is
    // fully shown without counting; only a genuine remainder pays for the count.
    setReveal((current) => {
      if (current.visible >= text.length) {
        return current.finishing ? { visible: current.visible, finishing: false } : current;
      }
      const target = codePointLength(text);
      const visible = Math.min(current.visible, target);
      const finishing = visible < target;
      return visible === current.visible && finishing === current.finishing
        ? current
        : { visible, finishing };
    });
  }, [prefersReducedMotion, streaming, targetLength, text]);

  useEffect(() => {
    if (!revealing) {
      return;
    }
    const interval = window.setInterval(() => {
      // Backgrounded windows can't show the typewriter advance, and each tick
      // pays a React re-render plus a tail re-parse — hold still until visible.
      if (document.hidden) return;
      setReveal((current) => {
        const target = targetLengthRef.current;
        if (current.visible >= target) {
          return current.finishing ? { visible: current.visible, finishing: false } : current;
        }
        // The pace is set once per arrival and held until the next one, so a
        // chunk reveals at one speed instead of pulsing as its backlog drains.
        const pace = paceRef.current;
        if (pace.forTarget !== target || pace.finishing !== current.finishing) {
          const spread = Math.ceil((target - current.visible) / SMOOTH_STREAM_DRAIN_TICKS);
          paceRef.current = {
            forTarget: target,
            finishing: current.finishing,
            charsPerTick: Math.max(
              SMOOTH_STREAM_MIN_CHARS_PER_TICK,
              // Finishing never slows a block down below the speed it was
              // already streaming at.
              current.finishing ? Math.max(pace.charsPerTick, spread) : spread
            )
          };
        }
        const visible = Math.min(current.visible + paceRef.current.charsPerTick, target);
        // The tick that lands the last character also ends the finishing
        // pass, so the block settles into its history rendering at once.
        return { visible, finishing: current.finishing && visible < target };
      });
    }, SMOOTH_STREAM_TICK_MS);
    return () => window.clearInterval(interval);
  }, [revealing]);

  if (!textCharacters || reveal.visible >= targetLength) {
    return { text, revealing };
  }
  return { text: textCharacters.slice(0, reveal.visible).join(""), revealing };
}

// Split the revealed text into a stable "committed" prefix (whole, completed
// blocks) and the block currently being typed. Splitting only at blank-line
// boundaries whose prefix has balanced code fences keeps each half independently
// valid markdown, so the committed prefix re-parses once per completed block
// instead of once per typewriter frame. react-markdown adds no wrapper element,
// so the two halves render as flat sibling blocks with normal margin collapse.
function splitStreamingMarkdown(text: string): { committed: string; tail: string } {
  // One forward pass. Walking back from the end instead re-counted the fences
  // over the whole prefix per candidate boundary, and an open fence — the state
  // an agent is in for as long as it is emitting a code block — rejects every
  // boundary inside it, so the cost grew with the square of the block.
  let openFence: string | null = null;
  let insideMath = false;
  let cut = -1;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue;
    const rawLine = text.slice(lineStart, i);
    const line = rawLine.trim();
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(line);
    if (i === lineStart) {
      // A blank line: the second "\n" of a paragraph break. End of text is not
      // one, only an unterminated last line, so it can never commit the tail.
      if (i !== text.length && lineStart > 0 && !openFence && !insideMath) cut = lineStart + 1;
    } else if (fence && !insideMath) {
      if (openFence) {
        // Shorter fences, other markers, and trailing text are code content.
        if (
          /^ {0,3}[`~]/.test(rawLine) &&
          fence[1][0] === openFence[0] &&
          fence[1].length >= openFence.length &&
          !fence[2].trim()
        ) {
          openFence = null;
        }
      } else if (fence[1][0] !== "`" || !fence[2].includes("`")) {
        openFence = fence[1];
      }
    } else if (!openFence && (line.startsWith("$$") || line.startsWith("\\["))) {
      if (line.length > 2 && (line.endsWith("$$") || line.endsWith("\\]"))) {
        // Opened and closed on the same line
      } else {
        insideMath = !insideMath;
      }
    } else if (!openFence && insideMath && (line.endsWith("$$") || line.endsWith("\\]"))) {
      insideMath = false;
    }
    lineStart = i + 1;
  }
  return cut < 0
    ? { committed: "", tail: text }
    : { committed: text.slice(0, cut), tail: text.slice(cut) };
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

// One markdown render root. Memoized on its props so a stable `text` (the
// committed prefix, which only changes when a block completes) skips re-parsing
// entirely — `workspace` and `onOpenFile` are stable from the session pane.
//
// The eager path renders without math plugins. Text that may contain math
// delegates to the lazy `ChatMathMarkdown` (KaTeX chunk) with the plain render
// as its Suspense fallback, so math pops in once the chunk lands instead of
// blocking first paint.
const MarkdownBody = memo(function MarkdownBody({
  text,
  workspace,
  onOpenFile
}: {
  text: string;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  const components: Components = useMemo(
    () => ({
        code: ({ className, children, ...rest }) => {
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
        a: ({ href, children, ...rest }) => {
          if (!href || href.startsWith("#")) {
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          }
          if (/^https?:/.test(href)) {
            return (
              <WebLink href={href} {...rest}>
                {children}
              </WebLink>
            );
          }
          if (/^mailto:/.test(href)) {
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
              <a href={href} {...rest}>
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
        img: ({ src, alt }) => (
          <MarkdownImage
            src={src}
            alt={alt}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        ),
        table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        pre: ({ children }) => <>{children}</>
    }),
    [workspace, onOpenFile]
  );

  const withMath = needsMath(text);
  const plain = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={chatUrlTransform}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
  if (!withMath) return plain;
  return (
    <Suspense fallback={plain}>
      <ChatMathMarkdown text={text} components={components} urlTransform={chatUrlTransform} />
    </Suspense>
  );
});

function MarkdownStream({
  text,
  streaming,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  // Only split while actively revealing. A completed message (or reduced-motion)
  // renders as a single root — byte-identical to the non-streaming path.
  const split = useMemo(
    () => (streaming ? splitStreamingMarkdown(text) : null),
    [streaming, text]
  );
  return (
    <>
      {split ? (
        <>
          {split.committed ? (
            <MarkdownBody text={split.committed} workspace={workspace} onOpenFile={onOpenFile} />
          ) : null}
          {split.tail ? (
            <MarkdownBody text={split.tail} workspace={workspace} onOpenFile={onOpenFile} />
          ) : null}
        </>
      ) : (
        <MarkdownBody text={text} workspace={workspace} onOpenFile={onOpenFile} />
      )}
    </>
  );
}

export function StreamingMarkdown({
  text,
  streaming,
  paced = true,
  revealKey,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  /** Reveal a streaming block at the typewriter cadence. Off, the block shows
      every character as it arrives but still keeps the committed/tail split,
      so a fast reasoning burst neither lags behind nor re-parses in full. */
  paced?: boolean;
  /** Stable identity for this block of text, unique across sessions and turns.
      Without one, a streaming block restarts its reveal on every remount. */
  revealKey?: string | null;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element | null {
  const { text: visibleText, revealing } = useSmoothStreamingText(text, streaming && paced, revealKey);
  // A block still typing out its remainder after the stream ended keeps the
  // live rendering path — the committed/tail split and deferred code
  // highlighting — until the last character lands.
  const live = streaming || revealing;
  const segments = useMemo(() => splitLogSegments(visibleText), [visibleText]);
  if (segments.length === 0 && visibleText.length > 0) return null;
  const hasLogs = segments.some((segment) => segment.kind === "log");
  const markdownText = hasLogs ? visibleText : segments.map((segment) => segment.text).join("");

  return (
    <div
      className={
        hasLogs
          ? `markdown-with-logs${live ? " markdown-streaming" : ""}`
          : `markdown${live ? " markdown-streaming" : ""}`
      }
    >
      <StreamingCodeContext.Provider value={live}>
        {hasLogs
          ? segments.map((segment, index) =>
              segment.kind === "log" ? (
                <LogBlock key={`log-${index}`} text={segment.text} />
              ) : (
                <div key={`md-${index}`} className="markdown">
                  <MarkdownBody text={segment.text} workspace={workspace} onOpenFile={onOpenFile} />
                </div>
              )
            )
          : (
            <MarkdownStream
              text={markdownText}
              streaming={live}
              workspace={workspace}
              onOpenFile={onOpenFile}
            />
          )}
      </StreamingCodeContext.Provider>
    </div>
  );
}
