import type {
  VisualizationAppearance, VisualizationControl, VisualizationControlGroup,
  VisualizationHostMessage, VisualizationRuntimeConfig, VisualizationRuntimeMessage, VisualizationState
} from "./types.js";

// The build script removes type imports and emits this file as a classic script.
(() => {
  interface PendingRequest { resolve: () => void; reject: (error: Error) => void; timer: number }
  interface Diagnostics { ready: boolean; height: number; console: Array<{ level: string; message: string }>; missingImages: string[] }
  interface WidgetApi {
    widgetState: VisualizationState;
    capabilities: { runtimeVersion: number; state: boolean; followUp: boolean; controls: boolean; calendar: boolean; carousel: boolean };
    setWidgetState: (state: Partial<VisualizationState>) => Promise<void>;
    sendFollowUpMessage: (options: { prompt: string; title?: string }) => Promise<void>;
  }
  type RuntimeWindow = Omit<Window, "webkit"> & {
    __argmaxVisualizationConfig?: VisualizationRuntimeConfig;
    __argmaxVisualizationReceive?: (message: VisualizationHostMessage) => void;
    __argmaxVisualizationDiagnostics?: Diagnostics;
    webkit?: { messageHandlers?: { argmaxVisualization?: { postMessage: (message: VisualizationRuntimeMessage) => void } } };
    openai?: WidgetApi;
    Tweak?: typeof Tweak;
    lucide?: {
      createIcons: (options?: { attrs: Record<string, string | number> }) => void;
      createElement: (icon: unknown, attrs: Record<string, string | number>) => SVGElement;
      icons: Record<string, unknown>;
    };
  };
  const view = window as RuntimeWindow;
  const config = view.__argmaxVisualizationConfig ?? {
    instanceId: "standalone", appearance: { dark: false, variables: {} }, standalone: true
  };
  const instanceId = config.instanceId;
  const hasHost = !config.standalone && (Boolean(view.webkit?.messageHandlers?.argmaxVisualization) || parent !== window);
  const controlsSupported = hasHost && config.capabilities?.controls === true;
  const diagnostics: Diagnostics = { ready: false, height: 0, console: [], missingImages: [] };
  view.__argmaxVisualizationDiagnostics = diagnostics;
  let requestSequence = 0;
  let groupSequence = 0;
  let controlSequence = 0;
  const controlOriginals = new WeakMap<object, Map<string, string | number | boolean>>();
  const controlEdits = new WeakMap<object, Map<string, string | number | boolean>>();
  const pending = new Map<string, PendingRequest>();
  const send = (message: VisualizationRuntimeMessage) => {
    const native = view.webkit?.messageHandlers?.argmaxVisualization;
    if (native && !config.standalone) native.postMessage(message);
    else if (parent !== window && !config.standalone) parent.postMessage(message, "*");
  };
  const capture = (level: string, values: unknown[]) => {
    if (diagnostics.console.length >= 100) return;
    const message = values.map((value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.message;
      try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
    }).join(" ").slice(0, 4000);
    diagnostics.console.push({ level, message });
  };
  for (const level of ["warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => { capture(level, values); original(...values); };
  }
  window.addEventListener("error", (event: Event) => {
    if (event instanceof ErrorEvent) capture("error", [event.message]);
    else if (event.target instanceof HTMLScriptElement || event.target instanceof HTMLLinkElement) {
      capture("error", [`Resource unavailable: ${event.target.getAttribute("src") ?? event.target.getAttribute("href") ?? "unknown"}`]);
    }
  }, true);
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => capture("error", [event.reason]));

  const cloneJson = (input: unknown): unknown => {
    const seen = new Set<object>();
    const validate = (value: unknown, depth: number) => {
      if (depth > 64) throw new Error("Visualization state is nested too deeply");
      if (value === null || typeof value === "string" || typeof value === "boolean") return;
      if (typeof value === "number" && Number.isFinite(value)) return;
      if (typeof value !== "object") throw new Error("Visualization state must contain JSON values only");
      if (seen.has(value)) throw new Error("Visualization state must not contain cycles");
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new Error("Visualization state must contain JSON objects only");
      }
      seen.add(value);
      for (const child of Object.values(value)) validate(child, depth + 1);
      seen.delete(value);
    };
    validate(input, 0);
    return JSON.parse(JSON.stringify(input)) as unknown;
  };
  const normalizeState = (input: Partial<VisualizationState> | null | undefined): VisualizationState => {
    if (input !== null && input !== undefined && (typeof input !== "object" || Array.isArray(input))) {
      throw new Error("Visualization state must be an object");
    }
    if (input && Object.keys(input).some((key) => key !== "modelContent" && key !== "privateContent")) {
      throw new Error("Visualization state accepts modelContent and privateContent only");
    }
    const state = cloneJson({ modelContent: input?.modelContent ?? null, privateContent: input?.privateContent ?? null }) as VisualizationState;
    if (new TextEncoder().encode(JSON.stringify(state)).byteLength > 16 * 1024) {
      throw new Error("Visualization state exceeds 16 KiB");
    }
    return state;
  };
  const globalsChanged = (globals: Record<string, unknown>) => {
    window.dispatchEvent(new CustomEvent("openai:set_globals", { detail: { globals } }));
  };
  const request = (create: (requestId: string) => VisualizationRuntimeMessage): Promise<void> => {
    if (!hasHost) return Promise.reject(new Error("This action requires the conversation host"));
    const requestId = `request-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("The conversation host did not acknowledge this action"));
      }, 15000);
      pending.set(requestId, { resolve, reject, timer });
      send(create(requestId));
    });
  };
  const api: WidgetApi = {
    widgetState: normalizeState(config.state),
    capabilities: { runtimeVersion: 1, state: true, followUp: hasHost, controls: controlsSupported, calendar: true, carousel: true },
    setWidgetState(input) {
      let state: VisualizationState;
      try { state = normalizeState(input); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error("Invalid visualization state")); }
      api.widgetState = state;
      if (!hasHost) {
        // Exported documents keep state locally. Sandboxed previews may deny storage.
        try { localStorage.setItem(`argmax-visualization:${instanceId}`, JSON.stringify(state)); } catch { /* Local interactions still work. */ }
        return Promise.resolve();
      }
      return request((requestId) => ({ type: "argmax:visualization-state", instanceId, requestId, state }));
    },
    sendFollowUpMessage(options) {
      if (!options || typeof options.prompt !== "string" || !options.prompt.trim() || options.prompt.length > 32000) {
        return Promise.reject(new Error("A follow-up prompt must contain 1 to 32,000 characters"));
      }
      if (options.title !== undefined && (typeof options.title !== "string" || options.title.length > 250)) {
        return Promise.reject(new Error("A follow-up title must contain at most 250 characters"));
      }
      return request((requestId) => ({ type: "argmax:visualization-follow-up", instanceId, requestId, prompt: options.prompt, ...(options.title === undefined ? {} : { title: options.title }) }));
    }
  };
  if (!hasHost) {
    try {
      const saved = localStorage.getItem(`argmax-visualization:${instanceId}`);
      if (saved) api.widgetState = normalizeState(JSON.parse(saved) as VisualizationState);
    } catch { /* Stored state is optional in standalone exports. */ }
  }
  view.openai = api;
  const applyAppearance = (appearance: VisualizationAppearance) => {
    if (!appearance || typeof appearance.dark !== "boolean" || !appearance.variables || typeof appearance.variables !== "object") return;
    document.documentElement.style.colorScheme = appearance.dark ? "dark" : "light";
    document.documentElement.dataset.theme = appearance.dark ? "dark" : "light";
    for (const [name, value] of Object.entries(appearance.variables)) {
      if (/^--[\w-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
    }
    globalsChanged({ theme: appearance.dark ? "dark" : "light" });
  };
  applyAppearance(config.appearance);

  interface Binding { schema: VisualizationControl; object: Record<string, unknown>; property: string; original: string | number | boolean; edited: string | number | boolean }
  interface ControlOptions { label?: string; reference?: string; min?: number; max?: number; step?: number; unit?: string; options?: Array<string | { label: string; value: string }> }
  const tweaks = new Map<string, Tweak>();
  let publishScheduled = false;
  const publishControls = () => {
    if (publishScheduled || !controlsSupported) return;
    publishScheduled = true;
    queueMicrotask(() => {
      publishScheduled = false;
      const groups: VisualizationControlGroup[] = [];
      for (const tweak of tweaks.values()) {
        const variant = tweak.container.closest<HTMLElement>("[data-variant]");
        if (variant?.hidden || !tweak.container.isConnected) continue;
        groups.push({ id: tweak.id, label: tweak.container.getAttribute("aria-label") || "Design", ...(variant ? { variant: variant.dataset.variant } : {}), controls: tweak.bindings.map((binding) => ({ ...binding.schema, value: binding.object[binding.property] as string | number | boolean })) });
      }
      send({ type: "argmax:visualization-controls", instanceId, groups });
    });
  };
  const validControlValue = (schema: VisualizationControl, value: unknown) => {
    if (schema.kind === "toggle") return typeof value === "boolean";
    if (schema.kind === "color") return typeof value === "string" && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value);
    if (schema.kind === "select") return typeof value === "string" && schema.options?.some((option) => option.value === value);
    return typeof value === "number" && Number.isFinite(value) && value >= (schema.min ?? 0) && value <= (schema.max ?? 100);
  };
  class Tweak {
    readonly supported = controlsSupported;
    readonly id = `group-${++groupSequence}`;
    readonly container: Element;
    readonly bindings: Binding[] = [];
    readonly onChange: () => void;
    private disposed = false;
    constructor(options: { container: Element; onChange: () => void }) {
      if (!(options?.container instanceof Element) || typeof options.onChange !== "function") throw new Error("Tweak requires a container and onChange function");
      if (tweaks.size >= 32) throw new Error("A visualization accepts at most 32 Tweak groups");
      this.container = options.container;
      this.onChange = options.onChange;
      tweaks.set(this.id, this);
    }
    private add(kind: VisualizationControl["kind"], object: object, property: string, options: ControlOptions = {}) {
      if (this.disposed) throw new Error("This Tweak group was disposed");
      if (this.bindings.length >= 12) throw new Error("A Tweak group accepts at most 12 controls");
      if (!object || !Object.hasOwn(object, property)) throw new Error("Tweak requires an existing object property");
      if (options.reference && !/^[\w./:@$#-]+$/.test(options.reference)) throw new Error("Tweak reference contains unsupported characters");
      if (options.label !== undefined && (typeof options.label !== "string" || options.label.length > 250)) throw new Error("Tweak labels accept at most 250 characters");
      const values = object as Record<string, unknown>;
      const schema: VisualizationControl = { id: `control-${controlSequence + 1}`, kind, label: options.label ?? property, value: values[property] as string | number | boolean };
      if (options.reference) schema.reference = options.reference;
      if (kind === "slider") {
        if (!Number.isFinite(options.min) || !Number.isFinite(options.max) || (options.min ?? 0) >= (options.max ?? 0) || !Number.isFinite(options.step ?? 1) || (options.step ?? 1) <= 0) throw new Error("Tweak slider requires min below max and a positive step");
        Object.assign(schema, { min: options.min, max: options.max, step: options.step ?? 1, ...(options.unit ? { unit: options.unit.slice(0, 30) } : {}) });
      }
      if (kind === "select") {
        if (!options.options?.length || options.options.length > 12) throw new Error("Tweak select requires 1 to 12 options");
        schema.options = options.options.map((option) => typeof option === "string" ? { label: option, value: option } : { ...option });
        if (schema.options.some((option) => typeof option.label !== "string" || typeof option.value !== "string" || option.label.length > 250 || option.value.length > 250)) throw new Error("Tweak select options require short strings");
      }
      if (!validControlValue(schema, schema.value)) throw new Error(`Tweak ${kind} has an invalid initial value`);
      controlSequence++;
      let originals = controlOriginals.get(object);
      if (!originals) { originals = new Map(); controlOriginals.set(object, originals); }
      if (!originals.has(property)) originals.set(property, schema.value);
      const binding: Binding = { schema, object: values, property, original: originals.get(property)!, edited: schema.value };
      this.bindings.push(binding);
      let edits = controlEdits.get(object);
      if (!edits) { edits = new Map(); controlEdits.set(object, edits); }
      if (!edits.has(property)) edits.set(property, schema.value);
      const restored = config.controlValues?.[schema.id];
      if (restored !== undefined && validControlValue(schema, restored)) {
        values[property] = restored;
        binding.edited = restored;
        edits.set(property, restored);
        this.onChange();
      }
      publishControls();
      return this;
    }
    addSlider(object: object, property: string, options: ControlOptions) { return this.add("slider", object, property, options); }
    addColorPicker(object: object, property: string, options?: ControlOptions) { return this.add("color", object, property, options); }
    addToggle(object: object, property: string, options?: ControlOptions) { return this.add("toggle", object, property, options); }
    addSelect(object: object, property: string, options: ControlOptions) { return this.add("select", object, property, options); }
    dispose() { this.disposed = true; tweaks.delete(this.id); publishControls(); }
  }
  view.Tweak = Tweak;
  const receive = (message: VisualizationHostMessage) => {
    if (!message || message.instanceId !== instanceId) return;
    if (message.type === "argmax:visualization-appearance") applyAppearance(message.appearance);
    else if (message.type === "argmax:visualization-state") {
      try { api.widgetState = normalizeState(message.state); globalsChanged({ widgetState: api.widgetState }); } catch (error) { capture("error", [error]); }
    } else if (message.type === "argmax:visualization-ack") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve();
    } else if (message.type === "argmax:visualization-control") {
      (config.controlValues ??= {})[message.id] = message.value;
      for (const tweak of tweaks.values()) {
        const binding = tweak.bindings.find((candidate) => candidate.schema.id === message.id);
        if (!binding || !validControlValue(binding.schema, message.value)) continue;
        binding.object[binding.property] = message.value;
        binding.edited = message.value;
        controlEdits.get(binding.object)?.set(binding.property, message.value);
        tweak.onChange();
        publishControls();
        break;
      }
    } else if (message.type === "argmax:visualization-reset" || message.type === "argmax:visualization-original") {
      if (message.type === "argmax:visualization-reset" && !message.groupId) config.controlValues = {};
      for (const tweak of tweaks.values()) {
        if (message.groupId && tweak.id !== message.groupId) continue;
        for (const binding of tweak.bindings) {
          if (message.type === "argmax:visualization-reset") {
            delete config.controlValues?.[binding.schema.id];
            controlEdits.get(binding.object)?.set(binding.property, binding.original);
          }
          binding.object[binding.property] = message.type === "argmax:visualization-original" && !message.active ? controlEdits.get(binding.object)?.get(binding.property) ?? binding.edited : binding.original;
        }
        tweak.onChange();
      }
      publishControls();
    }
  };
  view.__argmaxVisualizationReceive = receive;
  window.addEventListener("message", (event: MessageEvent<VisualizationHostMessage>) => {
    if (event.source === parent && parent !== window) receive(event.data);
  });
  document.addEventListener("click", (event) => {
    const target = event.composedPath().find((item): item is Element => item instanceof Element);
    const anchor = target?.closest<HTMLAnchorElement>("a[href], area[href]");
    if (!anchor) return;
    const raw = anchor.getAttribute("href") ?? "";
    if (raw.startsWith("#")) return;
    event.preventDefault();
    if (!event.isTrusted || !hasHost) return;
    let url: URL;
    try { url = new URL(raw); } catch { return; }
    if (url.protocol === "https:" || url.protocol === "http:") send({ type: "argmax:visualization-link", instanceId, url: url.href });
  }, true);

  const tabsFor = (list: Element) => Array.from(list.querySelectorAll<HTMLButtonElement>('.nav-link[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === list);
  const tabEnabled = (tab: HTMLButtonElement) => !tab.disabled && tab.getAttribute("aria-disabled") !== "true";
  const activateTab = (list: Element, selected: HTMLButtonElement, focus = false) => {
    const tabs = tabsFor(list);
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.classList.toggle("active", active);
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      if (panel?.getAttribute("role") === "tabpanel") {
        panel.hidden = panel.id !== selected.getAttribute("aria-controls");
        if (!panel.hidden) panel.setAttribute("aria-labelledby", selected.id);
      }
    }
    if (focus) selected.focus();
  };
  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const tab = event.target.closest<HTMLButtonElement>('.nav-link[role="tab"]');
    const list = tab?.closest('.nav-pills[role="tablist"]');
    if (tab && list && tabEnabled(tab)) activateTab(list, tab);
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const list = event.target.closest('.nav-pills[role="tablist"]');
    if (!list) return;
    const tabs = tabsFor(list).filter(tabEnabled);
    const current = tabs.indexOf(event.target);
    if (current < 0 || !tabs.length) return;
    const vertical = list.getAttribute("aria-orientation") === "vertical";
    let next: number;
    if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = (current + 1) % tabs.length;
    else if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = (current + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(list, tabs[next], true);
  });
  const initializedTabs = new WeakSet<Element>();
  const carousels = new WeakSet<Element>();
  const initializeHelpers = () => {
    for (const list of document.querySelectorAll('.nav-pills[role="tablist"]')) {
      if (initializedTabs.has(list)) continue;
      initializedTabs.add(list);
      const tabs = tabsFor(list).filter(tabEnabled);
      const selected = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
      if (selected) activateTab(list, selected);
    }
    for (const root of document.querySelectorAll<HTMLElement>(".viz-carousel")) {
      if (carousels.has(root)) continue;
      const variants = Array.from(root.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute("data-variant"));
      if (variants.length < 2) continue;
      const names = variants.map((variant) => variant.dataset.variant ?? "");
      if (names.some((name) => !name) || new Set(names).size !== names.length) { capture("error", ["Carousel variant names must be nonempty and unique"]); continue; }
      carousels.add(root);
      const navigation = document.createElement("div");
      navigation.className = "viz-carousel-controls";
      navigation.setAttribute("role", "group");
      navigation.setAttribute("aria-label", root.getAttribute("aria-label") ?? "Design variants");
      const previous = document.createElement("button");
      previous.type = "button"; previous.className = "btn btn-ghost";
      previous.textContent = "‹"; previous.setAttribute("aria-label", root.dataset.previousLabel ?? "Previous design");
      const next = document.createElement("button");
      next.type = "button"; next.className = "btn btn-ghost";
      next.textContent = "›"; next.setAttribute("aria-label", root.dataset.nextLabel ?? "Next design");
      const picker = document.createElement("select");
      picker.className = "form-select"; picker.setAttribute("aria-label", "Design variant");
      for (const name of names) picker.add(new Option(name, name));
      const count = document.createElement("output");
      count.className = "text-small text-muted tabular-nums"; count.setAttribute("aria-live", "polite");
      let index = Math.max(0, variants.findIndex((variant) => !variant.hidden));
      const select = (selected: number) => {
        index = (selected + variants.length) % variants.length;
        variants.forEach((variant, position) => { variant.hidden = position !== index; });
        picker.value = names[index]; count.textContent = `${index + 1} / ${variants.length}`;
        publishControls();
      };
      previous.addEventListener("click", () => select(index - 1)); next.addEventListener("click", () => select(index + 1));
      picker.addEventListener("change", () => select(names.indexOf(picker.value)));
      navigation.append(previous, picker, count, next); root.append(navigation); select(index);
    }
  };

  let tooltip: HTMLElement | undefined;
  let tooltipTarget: Element | undefined;
  const hideTooltip = () => {
    if (tooltip && tooltipTarget) {
      const remaining = (tooltipTarget.getAttribute("aria-describedby") ?? "").split(/\s+/).filter((id) => id && id !== tooltip?.id);
      if (remaining.length) tooltipTarget.setAttribute("aria-describedby", remaining.join(" ")); else tooltipTarget.removeAttribute("aria-describedby");
    }
    tooltip?.remove(); tooltip = undefined; tooltipTarget = undefined;
  };
  const showTooltip = (target: Element) => {
    const text = target.getAttribute("data-tooltip");
    if (!text) return;
    hideTooltip(); tooltipTarget = target;
    tooltip = document.createElement("div"); tooltip.className = "tooltip"; tooltip.setAttribute("role", "tooltip");
    tooltip.id = `argmax-tooltip-${instanceId}`; tooltip.textContent = text.slice(0, 2000);
    document.body.append(tooltip);
    const rect = target.getBoundingClientRect(); const size = tooltip.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = document.documentElement.clientHeight || innerHeight;
    const placement = target.getAttribute("data-tooltip-placement") ?? "top";
    let left = rect.left + (rect.width - size.width) / 2; let top = rect.top - size.height - 6;
    if (placement === "bottom" || top < 8) top = rect.bottom + 6;
    if (placement === "right") { left = rect.right + 6; top = rect.top; }
    if (placement === "left") { left = rect.left - size.width - 6; top = rect.top; }
    tooltip.style.left = `${Math.max(8, Math.min(left, viewportWidth - size.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, viewportHeight - size.height - 8))}px`;
    const described = target.getAttribute("aria-describedby")?.split(/\s+/).filter(Boolean) ?? [];
    if (!described.includes(tooltip.id)) target.setAttribute("aria-describedby", [...described, tooltip.id].join(" "));
  };
  const tooltipFor = (event: Event) => event.composedPath().find((item): item is Element => item instanceof Element && item.hasAttribute("data-tooltip"));
  document.addEventListener("pointerover", (event) => { const target = tooltipFor(event); if (target && target !== tooltipTarget) showTooltip(target); });
  document.addEventListener("pointerout", (event) => { if (tooltipFor(event) === tooltipTarget) hideTooltip(); });
  document.addEventListener("focusin", (event) => { const target = tooltipFor(event); if (target) showTooltip(target); });
  document.addEventListener("focusout", hideTooltip);
  document.addEventListener("click", (event) => { const target = tooltipFor(event); if (target) showTooltip(target); else hideTooltip(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTooltip(); });
  window.addEventListener("scroll", hideTooltip, true);

  const minutes = (value: string, end = false): number => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && !(end && value === "24:00")) throw new Error("Calendar times must use HH:MM");
    const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute;
  };
  interface CalendarEvent { title: string; start: string; end: string; tone?: string; detail?: string; video?: boolean; [key: string]: unknown }
  class VizCalendar extends HTMLElement {
    static get observedAttributes() { return ["date", "start", "end", "now", "time-zone", "lang", "empty-label", "events", "interactive"]; }
    private supplied: CalendarEvent[] | undefined;
    constructor() { super(); }
    connectedCallback() {
      this.classList.add("widget");
      if (Object.hasOwn(this, "events")) {
        const events = this.events; delete (this as { events?: CalendarEvent[] }).events; this.events = events;
      } else if (!this.shadowRoot || this.supplied !== undefined) this.render();
    }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    get events(): CalendarEvent[] | undefined { return this.supplied; }
    set events(value: CalendarEvent[] | undefined) { this.supplied = value; this.render(); }
    private render() {
      if (!this.isConnected) return;
      const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
      shadow.replaceChildren();
      const style = document.createElement("style");
      style.textContent = ":host{display:block;color:var(--foreground);font:14px/1.5 var(--font-sans);padding:12px;border:1px solid var(--border);border-radius:10px;background:var(--card)}*{box-sizing:border-box}.heading{display:flex;justify-content:space-between;gap:12px;margin-bottom:10px;font-weight:500}.schedule{position:relative;margin-inline-start:50px}.hour{position:absolute;inset-inline:0;border-top:1px solid var(--border);color:var(--muted-foreground);font-size:12px}.hour span{position:absolute;inset-inline-start:-50px;top:-9px}.event{position:absolute;border:0;border-radius:4px;padding:2px 5px;text-align:start;color:var(--foreground);background:color-mix(in srgb,var(--event-tone) 20%,var(--card));overflow:hidden;font:inherit;cursor:var(--cursor-interaction,pointer)}.event span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.time{font-size:12px}.now{position:absolute;inset-inline:0;border-top:2px solid var(--red);pointer-events:none}.error{color:var(--destructive)}:focus-visible{outline:2px solid var(--ring);outline-offset:2px}@media(pointer:coarse){.event{padding:2px 4px}}";
      shadow.append(style);
      try {
        const date = this.getAttribute("date") ?? "";
        const parsed = new Date(`${date}T12:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Calendar requires a valid YYYY-MM-DD date");
        const start = minutes(this.getAttribute("start") ?? "09:00"); const end = minutes(this.getAttribute("end") ?? "17:00", true);
        if (end <= start) throw new Error("Calendar end must be after start");
        const data = this.supplied ?? (JSON.parse(this.getAttribute("events") ?? "[]") as CalendarEvent[]);
        if (!Array.isArray(data) || data.length > 200) throw new Error("Calendar accepts at most 200 events");
        const events = data.map((event, index) => {
          if (!event || typeof event.title !== "string" || !event.title || event.title.length > 1000 || typeof event.start !== "string" || typeof event.end !== "string") throw new Error("Calendar events require title, start, and end");
          if (event.detail !== undefined && typeof event.detail !== "string") throw new Error("Calendar detail must be text");
          if (event.video !== undefined && typeof event.video !== "boolean") throw new Error("Calendar video must be boolean");
          if (event.tone !== undefined && !["blue", "green", "red", "orange", "purple", "yellow"].includes(event.tone)) throw new Error("Calendar event tone is unsupported");
          const from = minutes(event.start); const to = minutes(event.end, true);
          if (to <= from) throw new Error("Calendar event end must be after start");
          return { event, index, from: Math.max(start, from), to: Math.min(end, to), lane: 0, lanes: 1 };
        }).filter((event) => event.to > event.from).sort((a, b) => a.from - b.from || a.to - b.to);
        const heading = document.createElement("div"); heading.className = "heading";
        const label = document.createElement("span");
        label.textContent = new Intl.DateTimeFormat(this.getAttribute("lang") ?? navigator.language, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(parsed);
        const zone = document.createElement("span"); zone.textContent = this.getAttribute("time-zone") ?? ""; heading.append(label, zone); shadow.append(heading);
        if (!events.length) { const empty = document.createElement("p"); empty.textContent = this.getAttribute("empty-label") ?? "No events"; shadow.append(empty); return; }
        // Each connected overlap group shares its maximum lane count.
        let group: typeof events = []; let groupEnd = -1;
        const assignLanes = () => {
          const occupied: number[] = [];
          for (const entry of group) {
            let lane = occupied.findIndex((until) => until <= entry.from);
            if (lane < 0) lane = occupied.length;
            occupied[lane] = entry.to; entry.lane = lane;
          }
          for (const entry of group) entry.lanes = occupied.length;
        };
        for (const entry of events) {
          if (entry.from >= groupEnd) { assignLanes(); group = []; groupEnd = -1; }
          group.push(entry); groupEnd = Math.max(groupEnd, entry.to);
        }
        assignLanes();
        const schedule = document.createElement("div"); schedule.className = "schedule";
        const scale = Math.max(.7, Math.min(1.8, 360 / (end - start))); const height = (end - start) * scale;
        schedule.style.height = `${height}px`;
        for (let time = start; time < end; time += 60) {
          const hour = document.createElement("div"); hour.className = "hour"; hour.style.top = `${(time - start) * scale}px`;
          const text = document.createElement("span"); text.textContent = `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`; hour.append(text); schedule.append(hour);
        }
        for (const entry of events) {
          const { event } = entry;
          const button = document.createElement("button"); button.type = "button"; button.className = "event";
          const details = `${event.title} · ${event.start}–${event.end}${event.detail ? ` · ${event.detail}` : ""}${event.video ? " · Video call" : ""}`;
          button.setAttribute("aria-label", details); button.dataset.tooltip = details;
          button.style.top = `${(entry.from - start) * scale}px`; button.style.height = `${Math.max(1, (entry.to - entry.from) * scale - 2)}px`;
          button.style.left = `calc(${entry.lane / entry.lanes * 100}% + 2px)`; button.style.width = `calc(${100 / entry.lanes}% - 4px)`;
          button.style.setProperty("--event-tone", `var(--${event.tone ?? "blue"})`);
          const title = document.createElement("span"); title.textContent = event.title;
          if (event.video && view.lucide?.icons.Video) {
            const icon = view.lucide.createElement(view.lucide.icons.Video, { width: 14, height: 14, "aria-hidden": "true", style: "vertical-align:-2px;margin-inline-end:4px" });
            title.prepend(icon);
          }
          button.append(title);
          if ((entry.to - entry.from) * scale >= 46) { const time = document.createElement("span"); time.className = "time"; time.textContent = `${event.start}–${event.end}`; button.append(time); }
          button.addEventListener("click", () => {
            if (this.hasAttribute("interactive")) this.dispatchEvent(new CustomEvent("eventselect", { bubbles: true, composed: true, detail: { event, index: entry.index } }));
          });
          schedule.append(button);
        }
        const now = this.getAttribute("now");
        if (now) { const time = minutes(now); if (time >= start && time <= end) { const marker = document.createElement("div"); marker.className = "now"; marker.style.top = `${(time - start) * scale}px`; marker.setAttribute("aria-label", `Current time ${now}`); schedule.append(marker); } }
        shadow.append(schedule);
      } catch (error) {
        const alert = document.createElement("p"); alert.className = "error"; alert.setAttribute("role", "alert"); alert.textContent = error instanceof Error ? error.message : "Invalid calendar data"; shadow.append(alert);
      }
    }
  }
  if (!customElements.get("viz-calendar")) customElements.define("viz-calendar", VizCalendar);

  const ready = () => {
    view.lucide?.createIcons({ attrs: { width: 16, height: 16 } });
    initializeHelpers(); publishControls();
    let resizeScheduled = false;
    let stopped = false;
    const resize = () => {
      if (resizeScheduled) return;
      resizeScheduled = true;
      requestAnimationFrame(() => {
        resizeScheduled = false;
        if (stopped) return;
        diagnostics.height = Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight));
        send({ type: "argmax:visualization-height", instanceId, height: diagnostics.height });
      });
    };
    const resizeObserver = new ResizeObserver(resize);
    const mutationObserver = new MutationObserver(() => { if (!stopped) { initializeHelpers(); publishControls(); resize(); } });
    const observe = () => {
      resizeObserver.observe(document.body);
      mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    };
    observe();
    window.addEventListener("pagehide", () => {
      stopped = true; resizeObserver.disconnect(); mutationObserver.disconnect(); hideTooltip();
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Visualization closed before acknowledgement")); }
      pending.clear();
    });
    window.addEventListener("pageshow", (event) => { if (event.persisted) { stopped = false; observe(); resize(); } });
    const complete = () => {
      const fonts = document.fonts?.ready ?? Promise.resolve();
      void fonts.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (stopped) return;
        diagnostics.missingImages = Array.from(document.images).filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.currentSrc || image.src).slice(0, 100);
        diagnostics.ready = true;
        resize();
      })));
    };
    if (document.readyState === "complete") complete(); else window.addEventListener("load", complete, { once: true });
    window.addEventListener("load", resize); resize();
  };
  if (document.readyState === "loading" || !document.body) document.addEventListener("DOMContentLoaded", ready, { once: true }); else ready();
})();
