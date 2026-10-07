import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { visualizationDocument, type VisualizationAppearance } from "../lib/visualizationDocument.js";

const MAX_VISUALIZATION_BYTES = 1_000_000;

function readAppearance(element: HTMLElement): VisualizationAppearance {
  const styles = getComputedStyle(element);
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  const foreground = token("--text", "#1c1b18");
  const background = token("--bg", "#f7f7f7");
  const border = token("--line", "#d9dde0");
  const accent = token("--accent", "#56815c");
  const series = [
    token("--activity-blue", "#1c65a9"), token("--activity-gold", "#c16f16"),
    token("--activity-green", "#1b7249"), token("--activity-coral", "#a73924"),
    token("--activity-purple", "#7449a8"), token("--activity-red", "#c72e43")
  ];
  return {
    dark: document.documentElement.dataset.theme === "dark",
    variables: {
      "--background": background,
      "--foreground": foreground,
      "--card": token("--panel", "#ffffff"),
      "--card-foreground": foreground,
      "--popover": token("--panel", "#ffffff"),
      "--popover-foreground": foreground,
      "--primary": foreground,
      "--primary-foreground": background,
      "--secondary": token("--panel-soft", "#f9f9f9"),
      "--secondary-foreground": foreground,
      "--muted": token("--panel-sunken", "#eeeeee"),
      "--muted-foreground": token("--muted", "#8a857b"),
      "--accent": token("--accent-soft", "#e3eee4"),
      "--accent-foreground": accent,
      "--destructive": series[5],
      "--border": border,
      "--input": border,
      "--ring": accent,
      "--font-size-base": token("--text-base", "14px"),
      "--font-sans": token("--font-ui", "system-ui, sans-serif"),
      "--font-mono": token("--font-mono", "ui-monospace, monospace"),
      "--blue": series[0],
      "--orange": series[1],
      "--green": series[2],
      "--red": series[5],
      "--purple": series[4],
      "--yellow": series[1],
      ...Object.fromEntries(series.map((color, index) => [`--viz-series-${index + 1}`, color]))
    }
  };
}

type VisualizationState =
  | { kind: "loading" }
  | { kind: "ready"; document: string }
  | { kind: "error"; message: string };

export function HtmlVisualization({ workspaceId, path, mode, title = "Visualization" }: {
  workspaceId: string;
  path: string;
  mode?: "wide";
  title?: string;
}): JSX.Element {
  const figureRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<VisualizationState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [height, setHeight] = useState(480);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setHeight(480);
    setExpanded(false);
    const workspace = window.argmax?.workspace;
    if (!workspace) {
      setState({ kind: "error", message: "Visualization file access is unavailable." });
      return;
    }
    void workspace.readVisualization({ kind: "workspace", id: workspaceId }, path).then(async (file) => {
      if (cancelled) return;
      if (file.kind === "skipped") {
        const message = file.reason === "too-large" ? "Visualization exceeds the 1 MB limit."
          : file.reason === "binary" ? "Visualization must be an HTML text file."
            : "Visualization file is unavailable.";
        setState({ kind: "error", message });
        return;
      }
      if (file.size > MAX_VISUALIZATION_BYTES || new TextEncoder().encode(file.content).byteLength > MAX_VISUALIZATION_BYTES) {
        setState({ kind: "error", message: "Visualization exceeds the 1 MB limit." });
        return;
      }
      const figure = figureRef.current;
      if (figure) {
        const document = await visualizationDocument(file.content, readAppearance(figure));
        if (!cancelled) setState({ kind: "ready", document });
      }
    }).catch((caught: unknown) => {
      if (!cancelled) setState({ kind: "error", message: `Could not load visualization: ${caught instanceof Error ? caught.message : String(caught)}` });
    });
    return () => { cancelled = true; };
  }, [workspaceId, path, retry]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type !== "argmax:visualization-height" || !("height" in data)) return;
      if (typeof data.height === "number" && Number.isFinite(data.height)) {
        setHeight(Math.min(1200, Math.max(120, Math.ceil(data.height))));
      }
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(() => {
      const figure = figureRef.current;
      if (figure) iframeRef.current?.contentWindow?.postMessage({ type: "argmax:visualization-appearance", appearance: readAppearance(figure) }, "*");
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => {
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const figure = figureRef.current;
    const column = figure?.parentElement;
    if (mode !== "wide" || !figure || !column) return;
    const transcript = figure.closest<HTMLElement>(".conversation-content, .agent-activity-content");
    const session = figure.closest<HTMLElement>(".session-main-column");
    const card = session?.querySelector<HTMLElement>(".workspace-card");
    const measure = (): void => {
      const bounds = column.getBoundingClientRect();
      const safe = (transcript ?? session ?? column).getBoundingClientRect();
      const clearance = session ? Number.parseFloat(getComputedStyle(session).getPropertyValue("--workspace-card-clearance")) || 0 : 0;
      const right = card && getComputedStyle(card).display !== "none" ? Math.min(safe.right, card.getBoundingClientRect().left - clearance) : safe.right;
      const breakout = Math.max(0, Math.min(bounds.left - safe.left, right - bounds.right, (1024 - bounds.width) / 2));
      figure.style.setProperty("--visualization-breakout", `${breakout}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [column, transcript, session, card]) if (element) observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  return (
    <figure ref={figureRef} className="html-visualization" data-wide={mode === "wide" ? "true" : undefined} aria-label={title}>
      <div className="html-visualization-toolbar">
        <span className="html-visualization-title">{title}</span>
        {state.kind === "ready" ? (
          <button type="button" className="html-visualization-expand" aria-label={expanded ? "Collapse visualization" : "Expand visualization"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {state.kind === "loading" ? <p className="html-visualization-status" role="status">Loading visualization</p> : null}
      {state.kind === "error" ? (
        <div className="html-visualization-status">
          <p role="alert">{state.message}</p>
          <button type="button" className="html-visualization-retry" onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      ) : null}
      {state.kind === "ready" ? (
        <iframe ref={iframeRef} title={title} className="html-visualization-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={state.document} style={{ height: expanded ? Math.max(height, 900) : Math.min(height, 480) }} />
      ) : null}
    </figure>
  );
}
