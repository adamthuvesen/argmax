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
import { useRestoreFocus } from "../hooks/useRestoreFocus.js";
import {
  MERMAID_STREAM_DEBOUNCE_MS,
  mermaidErrorMessage,
  nativeSvgWidth,
  renderMermaidDiagram
} from "../lib/mermaidRuntime.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

function subscribeToAppearance(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-accent"]
  });
  return () => observer.disconnect();
}

function readAppearanceKey(): string {
  if (typeof document === "undefined") return "light:";
  const root = document.documentElement;
  return `${root.getAttribute("data-theme") ?? "light"}:${root.getAttribute("data-accent") ?? ""}`;
}

function useAppearanceKey(): string {
  return useSyncExternalStore(subscribeToAppearance, readAppearanceKey, () => "light:");
}

export function MermaidDiagram({ source }: { source: string }): JSX.Element {
  const streaming = useContext(StreamingCodeContext);
  const appearanceKey = useAppearanceKey();
  const reactId = useId();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bindRef = useRef<((element: Element) => void) | undefined>(undefined);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copyFlash, copy] = useCopyToClipboard();

  useRestoreFocus(expanded);

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
  }, [svg, expanded]);

  useLayoutEffect(() => {
    if (!svg || sourceOpen || expanded) {
      setOverflows(false);
      return;
    }
    const canvas = canvasRef.current;
    const drawn = canvas?.querySelector("svg");
    if (!canvas || !(drawn instanceof SVGSVGElement)) {
      setOverflows(false);
      return;
    }
    const measure = (): void => {
      const native = nativeSvgWidth(drawn);
      setOverflows(native > canvas.clientWidth + 8);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [svg, sourceOpen, expanded]);

  useEffect(() => {
    if (!expanded) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const trimmed = source.trim();
  const drawing = Boolean(trimmed) && !svg && !error;
  const copyTitle =
    copyFlash === "copied" ? "Copied!" : copyFlash === "failed" ? "Couldn't copy" : "Copy source";
  const showCanvas = Boolean(svg) && !sourceOpen && !error && !expanded;

  const handleCopy = (): void => {
    void copy(source);
  };

  const lightbox =
    expanded && svg && typeof document !== "undefined"
      ? createPortal(
          <div
            className="mermaid-diagram-overlay"
            onClick={() => setExpanded(false)}
          >
            <div
              className="mermaid-diagram-lightbox"
              role="dialog"
              aria-modal="true"
              aria-label="Full diagram"
              onClick={(event) => event.stopPropagation()}
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
