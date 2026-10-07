import { Code2, Download, Maximize2, Minimize2, SlidersHorizontal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import type { VisualizationRead } from "../../shared/types.js";
import type { VisualizationAppearance, VisualizationControl, VisualizationControlGroup, VisualizationHostMessage } from "../../shared/visualization/types.js";
import { decodeVisualizationMessage } from "../lib/visualizationBridge.js";
import { restoreDraft } from "../lib/composerDrafts.js";
import { openWebUrl } from "../lib/openWebUrl.js";

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

type ViewerState = { kind: "loading" } | { kind: "ready"; value: VisualizationRead } | { kind: "error"; message: string };

function download(content: string, title: string, mime = "text/html"): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title.replace(/[^\p{L}\p{N}_.-]+/gu, "-").slice(0, 100) || "visualization"}.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HtmlVisualization({ sessionId, artifactId, path, sourceEventId, mode, title = "Visualization" }: {
  sessionId: string;
  artifactId?: string;
  path?: string;
  sourceEventId?: string;
  mode?: "wide";
  title?: string;
}): JSX.Element {
  const figureRef = useRef<HTMLElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<ViewerState>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  const [height, setHeight] = useState(480);
  const [expanded, setExpanded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [groups, setGroups] = useState<VisualizationControlGroup[]>([]);
  const [visible, setVisible] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<{ requestId: string; prompt: string; title?: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const stateWrites = useRef<Promise<unknown>>(Promise.resolve());
  const savedState = useRef<VisualizationRead["state"] | null>(null);
  const savedControls = useRef<Record<string, string | number | boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    savedState.current = null;
    savedControls.current = {};
    setGroups([]);
    setHeight(480);
    const api = window.argmax?.visualization;
    if (!api) { setState({ kind: "error", message: "Visualization access is unavailable." }); return; }
    void (async () => {
      let id = artifactId;
      if (!id) {
        if (!path) throw new Error("Visualization reference has no artifact or file.");
        id = (await api.import({ sessionId, path, title, mode: mode ?? null, summary: null, sourceEventId: sourceEventId ?? null })).id;
      }
      const value = await api.read({ sessionId, artifactId: id });
      if (!cancelled) {
        for (const [key, entry] of Object.entries(value.controlValues)) if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") savedControls.current[key] = entry;
        setState({ kind: "ready", value });
      }
    })().catch((error: unknown) => {
      if (!cancelled) setState({ kind: "error", message: `Could not load visualization: ${error instanceof Error ? error.message : String(error)}` });
    });
    return () => { cancelled = true; };
  }, [sessionId, artifactId, path, sourceEventId, title, mode, retry]);

  const send = (message: VisualizationHostMessage): void => iframeRef.current?.contentWindow?.postMessage(message, "*");

  useLayoutEffect(() => {
    if (state.kind !== "ready") return;
    const id = state.value.artifact.id;
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!iframeRef.current?.contentWindow || event.source !== iframeRef.current.contentWindow) return;
      const message = decodeVisualizationMessage(event.data, id);
      if (!message) return;
      if (message.type === "argmax:visualization-height") {
        setHeight(Math.min(2000, Math.max(120, Math.ceil(message.height))));
      } else if (message.type === "argmax:visualization-controls") {
        setGroups(message.groups);
      } else if (message.type === "argmax:visualization-state") {
        savedState.current = message.state;
        const frame = iframeRef.current.contentWindow;
        stateWrites.current = stateWrites.current.catch(() => {}).then(async () => {
          try {
            const api = window.argmax?.visualization;
            if (!api) throw new Error("Visualization state storage is unavailable.");
            await api.setState({ sessionId, artifactId: id, state: message.state });
            frame.postMessage({ type: "argmax:visualization-ack", instanceId: id, requestId: message.requestId }, "*");
          } catch (error) {
            frame.postMessage({ type: "argmax:visualization-ack", instanceId: id, requestId: message.requestId, error: String(error) }, "*");
          }
        });
      } else if (message.type === "argmax:visualization-follow-up") {
        setFollowUp({ requestId: message.requestId, prompt: message.prompt, title: message.title });
        send({ type: "argmax:visualization-ack", instanceId: id, requestId: message.requestId });
      } else if (message.type === "argmax:visualization-link") {
        setLink(message.url);
      }
    };
    window.addEventListener("message", onMessage);
    const observer = new MutationObserver(() => {
      if (figureRef.current) send({ type: "argmax:visualization-appearance", instanceId: id, appearance: readAppearance(figureRef.current) });
    });
    observer.observe(document.documentElement, { attributes: true });
    return () => { window.removeEventListener("message", onMessage); observer.disconnect(); };
  }, [state, sessionId]);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "300px" });
    observer.observe(figure);
    return () => observer.disconnect();
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

  const persistControls = (): void => {
    if (state.kind !== "ready") return;
    const id = state.value.artifact.id;
    const values = { ...savedControls.current };
    stateWrites.current = stateWrites.current.catch(() => {}).then(async () => {
      const api = window.argmax?.visualization;
      if (!api) throw new Error("Visualization design storage is unavailable.");
      await api.setControls({ sessionId, artifactId: id, controlValues: values });
    }).catch(error => setActionError(`Could not save design controls: ${String(error)}`));
  };
  const updateControl = (control: VisualizationControl, value: string | number | boolean): void => {
    if (state.kind !== "ready") return;
    savedControls.current[control.id] = value;
    persistControls();
    send({ type: "argmax:visualization-control", instanceId: state.value.artifact.id, id: control.id, value });
  };
  const exportDocument = async (): Promise<void> => {
    if (state.kind !== "ready") return;
    setActionError(null);
    try {
      if (state.value.artifact.format === "image") {
        const link = document.createElement("a");
        link.href = state.value.source;
        link.download = `${state.value.artifact.title.replace(/[^\p{L}\p{N}_.-]+/gu, "-")}.${state.value.source.slice(11, state.value.source.indexOf(";"))}`;
        link.click();
      } else {
        const api = window.argmax?.visualization;
        if (!api) throw new Error("Visualization export is unavailable.");
        await stateWrites.current;
        download(await api.export({ sessionId, artifactId: state.value.artifact.id }), state.value.artifact.title);
      }
    } catch (error) { setActionError(`Could not export visualization: ${String(error)}`); }
  };
  const frameHeight = expanded ? Math.max(height, 900) : Math.min(height, 480);
  return (
    <figure ref={figureRef} className="html-visualization" data-wide={mode === "wide" ? "true" : undefined} aria-label={state.kind === "ready" ? state.value.artifact.title : title}>
      <div className="html-visualization-toolbar">
        <span className="html-visualization-title">{state.kind === "ready" ? state.value.artifact.title : title}</span>
        {state.kind === "ready" ? <div className="html-visualization-actions">
          {groups.length > 0 ? <button type="button" className="html-visualization-expand" aria-label="Design controls" aria-expanded={controlsOpen} onClick={() => setControlsOpen(value => !value)}><SlidersHorizontal size={14} /></button> : null}
          <button type="button" className="html-visualization-expand" aria-label="View visualization source" aria-expanded={sourceOpen} onClick={() => setSourceOpen(value => !value)}><Code2 size={14} /></button>
          <button type="button" className="html-visualization-expand" aria-label="Download visualization" onClick={() => { void exportDocument(); }}><Download size={14} /></button>
          <button type="button" className="html-visualization-expand" aria-label={expanded ? "Collapse visualization" : "Expand visualization"} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
        </div> : null}
      </div>
      {state.kind === "loading" ? <p className="html-visualization-status" role="status">Loading visualization</p> : null}
      {state.kind === "error" ? <div className="html-visualization-status"><p role="alert">{state.message}</p><button type="button" className="html-visualization-retry" onClick={() => setRetry(value => value + 1)}>Retry</button></div> : null}
      {actionError ? <p role="alert" className="html-visualization-status">{actionError}</p> : null}
      {followUp && state.kind === "ready" ? <div className="html-visualization-status">
        <p>{followUp.title ?? "Ask in chat"}</p><p>{followUp.prompt}</p>
        <button type="button" onClick={() => {
          restoreDraft(sessionId, { text: followUp.prompt, attachments: [] });
          setFollowUp(null);
        }}>Prepare follow-up</button>
        <button type="button" onClick={() => {
          setFollowUp(null);
        }}>Cancel</button>
      </div> : null}
      {link ? <div className="html-visualization-status"><span>{link}</span><button type="button" onClick={() => { openWebUrl(link); setLink(null); }}>Open link</button><button type="button" onClick={() => setLink(null)}>Dismiss</button></div> : null}
      {state.kind === "ready" ? <>
        <figcaption className="sr-only">{state.value.artifact.summary}</figcaption>
        {state.value.artifact.format === "image" ? <img className="html-visualization-image" src={state.value.source} alt={state.value.artifact.summary} style={{ maxHeight: expanded ? undefined : 480 }} />
          : visible || expanded ? <iframe ref={iframeRef} title={state.value.artifact.title} className="html-visualization-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={state.value.document} style={{ height: frameHeight }} onLoad={() => {
            const id = state.value.artifact.id;
            if (figureRef.current) send({ type: "argmax:visualization-appearance", instanceId: id, appearance: readAppearance(figureRef.current) });
            const snapshot = savedState.current ?? state.value.state;
            send({ type: "argmax:visualization-state", instanceId: id, state: { modelContent: snapshot.modelContent ?? null, privateContent: snapshot.privateContent ?? null } });
            send({ type: "argmax:visualization-reset", instanceId: id });
            for (const [controlId, value] of Object.entries(savedControls.current)) {
              if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") send({ type: "argmax:visualization-control", instanceId: id, id: controlId, value });
            }
          }} /> : <div className="html-visualization-placeholder" style={{ height: frameHeight }}><button type="button" onClick={() => setVisible(true)}>Activate visualization</button></div>}
        {controlsOpen ? <div className="html-visualization-controls">{groups.map(group => <fieldset key={group.id}><legend>{group.label}</legend>{group.controls.map(control => <label key={control.id}>{control.label}
          {control.kind === "slider" ? <><input type="range" aria-label={control.label} min={control.min} max={control.max} step={control.step ?? 1} value={Number(control.value)} onChange={event => updateControl(control, Number(event.target.value))} /><output>{String(control.value)}{control.unit}</output></>
            : control.kind === "toggle" ? <input type="checkbox" checked={Boolean(control.value)} onChange={event => updateControl(control, event.target.checked)} />
            : control.kind === "color" ? <input type="color" value={String(control.value).replace(/^#([\da-f])([\da-f])([\da-f])$/i, "#$1$1$2$2$3$3")} onChange={event => updateControl(control, event.target.value)} />
            : <select value={String(control.value)} onChange={event => updateControl(control, event.target.value)}>{control.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
        </label>)}<button type="button" onClick={() => {
          for (const control of group.controls) delete savedControls.current[control.id];
          persistControls();
          send({ type: "argmax:visualization-reset", instanceId: state.value.artifact.id, groupId: group.id });
        }}>Reset {group.label}</button></fieldset>)}
          <button type="button" aria-pressed={original} onClick={() => { send({ type: "argmax:visualization-original", instanceId: state.value.artifact.id, active: !original }); setOriginal(value => !value); }}>Preview original</button>
          <button type="button" onClick={() => restoreDraft(sessionId, { text: `Apply these visualization design changes:\n${groups.flatMap(group => group.controls.map(control => `${group.label}: ${control.label} = ${String(control.value)}`)).join("\n")}`, attachments: [] })}>Use changes in chat</button>
        </div> : null}
        {sourceOpen ? <pre className="html-visualization-source" aria-label="Visualization source">{state.value.source}</pre> : null}
        {state.value.artifact.externalDependencies.length > 0 ? <details className="html-visualization-dependencies"><summary>External resources</summary><ul>{state.value.artifact.externalDependencies.map(url => <li key={url}>{url}</li>)}</ul></details> : null}
      </> : null}
    </figure>
  );
}
