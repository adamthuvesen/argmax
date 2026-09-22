import { Check, Copy, Maximize2, X } from "lucide-react";
import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX
} from "react";
import { createPortal } from "react-dom";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import {
  MERMAID_STREAM_DEBOUNCE_MS,
  mermaidBreakoutWidth,
  mermaidErrorMessage,
  mermaidLayout,
  mermaidProseWidth,
  nativeSvgWidth,
  renderMermaidDiagram
} from "../lib/mermaidRuntime.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

function subscribeToAppearance(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent", "data-background-intensity"]
  });
  return () => observer.disconnect();
}

function readAppearanceKey(): string {
  if (typeof document === "undefined") return "light:";
  const root = document.documentElement;
  return `${root.getAttribute("data-theme") ?? "light"}:${root.getAttribute("data-accent") ?? ""}:${root.getAttribute("data-background-intensity") ?? "7"}`;
}

function useAppearanceKey(): string {
  return useSyncExternalStore(subscribeToAppearance, readAppearanceKey, () => "light:");
}

export function MermaidDiagram({ source }: { source: string }): JSX.Element {
  const streaming = useContext(StreamingCodeContext);
  const appearanceKey = useAppearanceKey();
  const reactId = useId();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bindRef = useRef<((element: Element) => void) | undefined>(undefined);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [wide, setWide] = useState(false);
  const [copyFlash, copy] = useCopyToClipboard();

  useRestoreFocus(expanded);
  useDismissOnOutsideOrEscape(
    dialogRef,
    expanded,
    () => setExpanded(false),
    undefined,
    { trapFocus: true }
  );

  useEffect(() => {
    const trimmed = source.trim();
    if (!trimmed) {
      setSvg(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const delay = streaming ? MERMAID_STREAM_DEBOUNCE_MS : 0;
    const handle = window.setTimeout(() => {
      void renderMermaidDiagram(trimmed)
        .then((result) => {
          if (cancelled) return;
          bindRef.current = result.bindFunctions;
          setSvg(result.svg);
          setError(null);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          bindRef.current = undefined;
          if (streaming) {
            setError(null);
            return;
          }
          setSvg(null);
          setError(mermaidErrorMessage(caught));
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source, streaming, appearanceKey]);

  useEffect(() => {
    const host = expanded ? lightboxRef.current : canvasRef.current;
    const bind = bindRef.current;
    if (!host || !bind || !svg) return;
    bind(host);
  }, [svg, expanded, sourceOpen]);

  useLayoutEffect(() => {
    if (!svg || sourceOpen || expanded) {
      setOverflows(false);
      setWide(false);
      return;
    }
    const canvas = canvasRef.current;
    const drawn = canvas?.querySelector("svg");
    const figure = canvas?.closest<HTMLElement>(".mermaid-diagram");
    const column = figure?.parentElement;
    if (!canvas || !(drawn instanceof SVGSVGElement) || !figure || !column) {
      setOverflows(false);
      setWide(false);
      return;
    }
    const sessionColumn = figure.closest<HTMLElement>(".session-main-column");
    const transcript = figure.closest<HTMLElement>(
      ".conversation-content, .agent-activity-content"
    );
    const workspaceCard = sessionColumn?.querySelector<HTMLElement>(".workspace-card");
    const measure = (): void => {
      const proseWidth = mermaidProseWidth(column);
      const columnBounds = column.getBoundingClientRect();
      const sessionBounds = sessionColumn?.getBoundingClientRect();
      const transcriptBounds = transcript?.getBoundingClientRect();
      const sessionStyle = sessionColumn ? window.getComputedStyle(sessionColumn) : null;
      const cardClearance = Number.parseFloat(
        sessionStyle?.getPropertyValue("--workspace-card-clearance") ?? ""
      );
      const visibleCard = workspaceCard && window.getComputedStyle(workspaceCard).display !== "none";
      const safeLeft = transcriptBounds?.left ?? sessionBounds?.left ?? columnBounds.left;
      const safeRight = visibleCard
        ? workspaceCard.getBoundingClientRect().left -
          (Number.isFinite(cardClearance) ? cardClearance : 0)
        : transcriptBounds?.right ?? sessionBounds?.right ?? columnBounds.right;
      const breakout = mermaidBreakoutWidth(
        proseWidth,
        columnBounds.left,
        safeLeft,
        safeRight
      );
      figure.style.setProperty("--diagram-breakout", `${breakout}px`);
      const layout = mermaidLayout(
        nativeSvgWidth(drawn),
        proseWidth,
        figure.clientWidth
      );
      setWide(layout.wide);
      setOverflows(layout.overflow);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    observer.observe(column);
    observer.observe(figure);
    if (sessionColumn) observer.observe(sessionColumn);
    if (transcript) observer.observe(transcript);
    if (workspaceCard) observer.observe(workspaceCard);
    return () => observer.disconnect();
  }, [svg, sourceOpen, expanded]);

  useEffect(() => {
    if (!expanded) return;
    closeRef.current?.focus();
  }, [expanded]);

  const trimmed = source.trim();
  const drawing = Boolean(trimmed) && !svg && !error;
  const copyTitle =
    copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy source";
  const showCanvas = Boolean(svg) && !sourceOpen && !error && !expanded;

  const handleCopy = (): void => {
    void copy(source);
  };

  const lightbox =
    expanded && svg && typeof document !== "undefined"
      ? createPortal(
          <div className="mermaid-diagram-overlay">
            <div
              ref={dialogRef}
              className="mermaid-diagram-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label="Full diagram"
            >
              <div className="mermaid-diagram-lightbox-bar">
                <span className="mermaid-diagram-lightbox-title">Diagram</span>
                <div className="mermaid-diagram-lightbox-actions">
                  <button
                    type="button"
                    className="mermaid-diagram-copy"
                    aria-label="Copy diagram source"
                    title={copyTitle}
                    onClick={handleCopy}
                  >
                    {copyFlash === "copied" ? (
                      <Check size={12} aria-hidden="true" />
                    ) : (
                      <Copy size={12} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    ref={closeRef}
                    type="button"
                    className="mermaid-diagram-copy"
                    aria-label="Close full diagram"
                    title="Close"
                    onClick={() => setExpanded(false)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="mermaid-diagram-lightbox-body">
                <div
                  ref={lightboxRef}
                  className="mermaid-diagram-lightbox-canvas"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <figure
        className="mermaid-diagram"
        data-state={error ? "error" : svg ? "ready" : "pending"}
        data-overflow={overflows ? "true" : undefined}
        data-wide={wide ? "true" : undefined}
        aria-label="Diagram"
      >
        <div className="mermaid-diagram-toolbar">
          {svg && !error ? (
            <button
              type="button"
              className="mermaid-diagram-copy"
              aria-label="View full diagram"
              title={overflows ? "Open full-size diagram" : "View full diagram"}
              onClick={() => setExpanded(true)}
            >
              <Maximize2 size={12} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="mermaid-diagram-copy"
            aria-label="Copy diagram source"
            title={copyTitle}
            onClick={handleCopy}
          >
            {copyFlash === "copied" ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </button>
          {svg && !error ? (
            <button
              type="button"
              className="mermaid-diagram-source-toggle"
              aria-label={sourceOpen ? "Show diagram" : "Show diagram source"}
              aria-pressed={sourceOpen}
              aria-controls={sourceOpen ? `${reactId}-source` : undefined}
              onClick={() => setSourceOpen((open) => !open)}
            >
              {sourceOpen ? "Diagram" : "Source"}
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="mermaid-diagram-error" role="alert">
            {error}
          </p>
        ) : null}
        {drawing ? (
          <p className="mermaid-diagram-pending" role="status">
            Drawing diagram
          </p>
        ) : null}
        {sourceOpen || error ? (
          <pre id={`${reactId}-source`} className="mermaid-diagram-source">
            {source}
          </pre>
        ) : null}
        {showCanvas && svg ? (
          <div
            ref={canvasRef}
            className="mermaid-diagram-canvas"
            dangerouslySetInnerHTML={{ __html: svg }}
            onClick={overflows ? () => setExpanded(true) : undefined}
          />
        ) : null}
      </figure>
      {lightbox}
    </>
  );
}
