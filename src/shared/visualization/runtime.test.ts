// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import "@testing-library/jest-dom/vitest";
import asset from "../../../assets/visualization-runtime.json";
import type { VisualizationHostMessage, VisualizationRuntimeConfig, VisualizationRuntimeMessage, VisualizationState } from "./types.js";

interface Api {
  widgetState: VisualizationState;
  capabilities: { runtimeVersion: number; controls: boolean; calendar: boolean };
  setWidgetState: (state: Partial<VisualizationState>) => Promise<void>;
  sendFollowUpMessage: (options: { prompt: string; title?: string }) => Promise<void>;
}
interface Binding {
  addSlider: (object: object, property: string, options: { min: number; max: number; label?: string }) => void;
  addToggle: (object: object, property: string) => void;
  addSelect: (object: object, property: string, options: { options: string[] }) => void;
  dispose: () => void;
}
interface Calendar extends HTMLElement { events?: Array<{ title: string; start: string; end: string; detail?: string; id?: string; video?: boolean }> }
type TestView = Window & typeof globalThis & {
  openai: Api;
  Tweak: new (options: { container: Element; onChange: () => void }) => Binding;
  __argmaxVisualizationReceive: (message: VisualizationHostMessage) => void;
  __argmaxVisualizationDiagnostics: { ready: boolean; height: number; console: Array<{ level: string; message: string }> };
};
const frames: HTMLIFrameElement[] = [];
type WithoutInstance<T> = T extends { instanceId: string } ? Omit<T, "instanceId"> : never;
afterEach(() => {
  for (const frame of frames.splice(0)) {
    frame.contentWindow?.dispatchEvent(new Event("pagehide"));
    frame.remove();
  }
  vi.restoreAllMocks();
});

function run(source: string, config: Partial<VisualizationRuntimeConfig> = {}) {
  const frame = document.createElement("iframe"); document.body.append(frame); frames.push(frame);
  const view = frame.contentWindow as TestView;
  const messages: VisualizationRuntimeMessage[] = [];
  Object.defineProperty(view, "ResizeObserver", { value: class { observe() {} disconnect() {} } });
  Object.defineProperty(view, "TextEncoder", { value: TextEncoder });
  Object.defineProperty(view, "webkit", { value: { messageHandlers: { argmaxVisualization: { postMessage: (message: VisualizationRuntimeMessage) => messages.push(message) } } } });
  Object.defineProperty(view, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => view.setTimeout(() => callback(0), 0) });
  const completeConfig: VisualizationRuntimeConfig = { instanceId: "test", appearance: { dark: true, variables: { "--foreground": "#eee" } }, capabilities: { controls: true }, ...config };
  const json = JSON.stringify(completeConfig).replace(/</g, "\\u003c");
  view.document.open();
  view.document.write(`<!doctype html><html><head><style>${asset.css}</style><script>window.__argmaxVisualizationConfig=${json};</script><script>${asset.script}</script></head><body>${source}</body></html>`);
  view.document.close();
  const receive = (message: WithoutInstance<VisualizationHostMessage>) => {
    view.__argmaxVisualizationReceive(view.JSON.parse(JSON.stringify({ instanceId: "test", ...message })) as VisualizationHostMessage);
  };
  const local = <T>(value: T): T => view.JSON.parse(JSON.stringify(value)) as T;
  return { view, body: view.document.body, messages, receive, local };
}

describe("shared visualization runtime", () => {
  it("boots helpers before content scripts, tracks diagnostics, and applies scoped themes", async () => {
    const { view, receive, messages } = run('<div>Chart</div><script>console.warn("chart warning"); window.widgetReady=Boolean(window.openai&&window.Tweak&&customElements.get("viz-calendar"));</script>');
    await waitFor(() => expect(view.__argmaxVisualizationDiagnostics.ready).toBe(true));
    expect((view as TestView & { widgetReady: boolean }).widgetReady).toBe(true);
    expect(view.__argmaxVisualizationDiagnostics.console).toContainEqual({ level: "warn", message: "chart warning" });
    expect(messages.some((message) => message.type === "argmax:visualization-height" && message.instanceId === "test")).toBe(true);
    expect(view.document.documentElement.style.colorScheme).toBe("dark");
    view.__argmaxVisualizationReceive({ type: "argmax:visualization-appearance", instanceId: "other", appearance: { dark: false, variables: {} } });
    expect(view.document.documentElement.style.colorScheme).toBe("dark");
    receive({ type: "argmax:visualization-appearance", appearance: { dark: false, variables: { "--foreground": "#111" } } });
    expect(view.document.documentElement.style.colorScheme).toBe("light");
    expect(view.document.documentElement.style.getPropertyValue("--foreground")).toBe("#111");
  });

  it("replaces snapshots optimistically, separates fields, and waits for the host acknowledgement", async () => {
    const { view, messages, receive, local } = run("<div>State</div>", { state: { modelContent: { choice: "old" }, privateContent: null } });
    const state = local({ modelContent: { choice: "new" }, privateContent: { expanded: true } });
    let settled = false;
    const promise = view.openai.setWidgetState(state).then(() => { settled = true; });
    expect(view.openai.widgetState).toEqual(state);
    const message = messages.find((message) => message.type === "argmax:visualization-state");
    if (!message || message.type !== "argmax:visualization-state") throw new Error("State request missing");
    expect(message.state).toEqual(state);
    expect(settled).toBe(false);
    receive({ type: "argmax:visualization-ack", requestId: message.requestId });
    await promise; expect(settled).toBe(true);
    const changed = vi.fn(); view.addEventListener("openai:set_globals", changed);
    receive({ type: "argmax:visualization-state", state: { modelContent: null, privateContent: { focus: "chart" } } });
    expect(view.openai.widgetState).toEqual({ modelContent: null, privateContent: { focus: "chart" } });
    expect(changed).toHaveBeenCalledOnce();
    expect(messages.filter((message) => message.type === "argmax:visualization-state")).toHaveLength(1);
  });

  it("rejects invalid, cyclic, and oversized state before sending it", async () => {
    const { view, local, messages } = run("<div>State</div>");
    await expect(view.openai.setWidgetState(local({ modelContent: "🙂".repeat(5000) }))).rejects.toThrow("16 KiB");
    await expect(view.openai.setWidgetState({ modelContent: () => 1 })).rejects.toThrow("JSON values");
    const cyclic = local({ modelContent: {} }); Object.assign(cyclic.modelContent, { loop: cyclic.modelContent });
    await expect(view.openai.setWidgetState(cyclic)).rejects.toThrow("cycles");
    expect(messages.filter((message) => message.type === "argmax:visualization-state")).toHaveLength(0);
  });

  it("prepares follow-ups through acknowledged messages and surfaces host rejection", async () => {
    const { view, messages, receive } = run("<div>Follow-up</div>");
    const pending = view.openai.sendFollowUpMessage({ prompt: "Explain the selected series", title: "Investigate series" });
    const message = messages.find((message) => message.type === "argmax:visualization-follow-up");
    if (!message || message.type !== "argmax:visualization-follow-up") throw new Error("Follow-up request missing");
    expect(message.prompt).toBe("Explain the selected series");
    receive({ type: "argmax:visualization-ack", requestId: message.requestId, error: "Chat unavailable" });
    await expect(pending).rejects.toThrow("Chat unavailable");
    await expect(view.openai.sendFollowUpMessage({ prompt: "" })).rejects.toThrow("prompt");
  });

  it("binds host-owned controls and updates the object before rendering, including reset and original preview", async () => {
    const { view, body, messages, receive, local } = run('<div id="component" aria-label="Player"></div>');
    const state = local({ radius: 18, playing: true, layout: "Compact" });
    const observed: number[] = [];
    const tweak = new view.Tweak({ container: body.querySelector("#component")!, onChange: () => observed.push(state.radius) });
    tweak.addSlider(state, "radius", { min: 0, max: 40, label: "Corner radius" }); tweak.addToggle(state, "playing"); tweak.addSelect(state, "layout", { options: ["Compact", "Editorial"] });
    await waitFor(() => expect(messages.some((message) => message.type === "argmax:visualization-controls" && message.groups[0]?.controls.length === 3)).toBe(true));
    const message = [...messages].reverse().find((message) => message.type === "argmax:visualization-controls");
    if (!message || message.type !== "argmax:visualization-controls") throw new Error("Controls missing");
    expect(message.groups[0].label).toBe("Player");
    const id = message.groups[0].controls[0].id;
    receive({ type: "argmax:visualization-control", id, value: 24 });
    expect(state.radius).toBe(24); expect(observed).toEqual([24]);
    receive({ type: "argmax:visualization-control", id, value: 999 });
    expect(state.radius).toBe(24);
    receive({ type: "argmax:visualization-original", active: true }); expect(state.radius).toBe(18);
    receive({ type: "argmax:visualization-original", active: false }); expect(state.radius).toBe(24);
    receive({ type: "argmax:visualization-reset" }); expect(state.radius).toBe(18);
    tweak.dispose();
    await waitFor(() => { const last = [...messages].reverse().find((message) => message.type === "argmax:visualization-controls"); expect(last?.type === "argmax:visualization-controls" && last.groups).toEqual([]); });
    expect(body.querySelector("input")).toBeNull();
  });

  it("enforces documented control limits", () => {
    const { view, body, local } = run('<div aria-label="Controls"></div>');
    const state = local({ enabled: true, choice: "one" });
    const tweak = new view.Tweak({ container: body.firstElementChild!, onChange: () => {} });
    expect(() => tweak.addSlider({ radius: 18 }, "radius", { min: 18, max: 18 })).toThrow("min below max");
    expect(() => tweak.addSelect(state, "choice", { options: Array.from({ length: 13 }, (_, i) => String(i)) })).toThrow("12 options");
    for (let count = 0; count < 12; count++) tweak.addToggle(state, "enabled");
    expect(() => tweak.addToggle(state, "enabled")).toThrow("12 controls");
  });

  it("restores edited controls independently of widget state and keeps source originals for reset", async () => {
    const widgetState = { modelContent: { choice: "saved" }, privateContent: { expanded: true } };
    const { view, body, local, receive, messages } = run('<div aria-label="Restored player"></div>', {
      state: widgetState, controlValues: { "control-1": 24, "control-2": false, "control-3": "invalid" }
    });
    const state = local({ radius: 18, playing: true, layout: "Compact" });
    const renders: Array<{ radius: number; playing: boolean }> = [];
    const tweak = new view.Tweak({ container: body.firstElementChild!, onChange: () => renders.push({ radius: state.radius, playing: state.playing }) });
    tweak.addSlider(state, "radius", { min: 0, max: 40 });
    expect(renders).toEqual([{ radius: 24, playing: true }]);
    tweak.addToggle(state, "playing");
    expect(renders).toEqual([{ radius: 24, playing: true }, { radius: 24, playing: false }]);
    tweak.addSelect(state, "layout", { options: ["Compact", "Editorial"] });
    expect(renders).toHaveLength(2); expect(state.layout).toBe("Compact");
    expect(view.openai.widgetState).toEqual(widgetState);
    await waitFor(() => { const last = [...messages].reverse().find((message) => message.type === "argmax:visualization-controls"); expect(last?.type === "argmax:visualization-controls" && last.groups[0].controls.map((control) => control.value)).toEqual([24, false, "Compact"]); });
    receive({ type: "argmax:visualization-original", active: true });
    expect(state).toEqual({ radius: 18, playing: true, layout: "Compact" });
    receive({ type: "argmax:visualization-original", active: false });
    expect(state).toEqual({ radius: 24, playing: false, layout: "Compact" });
    receive({ type: "argmax:visualization-reset" });
    expect(state).toEqual({ radius: 18, playing: true, layout: "Compact" });
    expect(messages.filter((message) => message.type === "argmax:visualization-state")).toHaveLength(0);
  });

  it("keeps control and group IDs stable when widget requests occur before registration", async () => {
    const first = run('<div aria-label="Controls"></div>');
    const second = run('<div aria-label="Controls"></div>');
    const pending = second.view.openai.setWidgetState(second.local({ modelContent: { selection: "A" } }));
    const request = second.messages.find((message) => message.type === "argmax:visualization-state");
    if (!request || request.type !== "argmax:visualization-state") throw new Error("State request missing");
    second.receive({ type: "argmax:visualization-ack", requestId: request.requestId });
    await pending;
    for (const host of [first, second]) {
      const state = host.local({ enabled: true });
      new host.view.Tweak({ container: host.body.firstElementChild!, onChange: () => {} }).addToggle(state, "enabled");
    }
    await waitFor(() => expect(second.messages.some((message) => message.type === "argmax:visualization-controls" && message.groups.length)).toBe(true));
    const group = (messages: VisualizationRuntimeMessage[]) => {
      const message = [...messages].reverse().find((message) => message.type === "argmax:visualization-controls");
      if (!message || message.type !== "argmax:visualization-controls") throw new Error("Controls missing");
      return message.groups[0];
    };
    expect(group(first.messages).id).toBe("group-1"); expect(group(first.messages).controls[0].id).toBe("control-1");
    expect(group(second.messages)).toEqual(group(first.messages));
  });

  it("restores design edits in standalone exports without requiring host controls", () => {
    const { view, body, local, messages } = run('<div aria-label="Exported player"></div>', {
      standalone: true, controlValues: { "control-1": 28 }
    });
    const state = local({ radius: 18 });
    const render = vi.fn(() => { body.firstElementChild!.setAttribute("data-radius", String(state.radius)); });
    new view.Tweak({ container: body.firstElementChild!, onChange: render }).addSlider(state, "radius", { min: 0, max: 40 });
    expect(state.radius).toBe(28); expect(render).toHaveBeenCalledOnce();
    expect(body.firstElementChild).toHaveAttribute("data-radius", "28");
    expect(view.openai.capabilities.controls).toBe(false); expect(messages).toEqual([]);
  });
  it("shares original and edited values across controls bound to one property", () => {
    const { view, body, local, receive } = run('<section></section><section></section>', { controlValues: { "control-1": 24 } });
    const state = local({ radius: 18 });
    for (const section of body.querySelectorAll("section")) new view.Tweak({ container: section, onChange: () => {} }).addSlider(state, "radius", { min: 0, max: 40 });
    expect(state.radius).toBe(24);
    receive({ type: "argmax:visualization-reset" });
    expect(state.radius).toBe(18);
    receive({ type: "argmax:visualization-control", id: "control-1", value: 24 });
    receive({ type: "argmax:visualization-original", active: true });
    expect(state.radius).toBe(18);
    receive({ type: "argmax:visualization-original", active: false });
    expect(state.radius).toBe(24);
  });

  it("changes carousel variants without replacing their DOM and filters controls to the visible design", async () => {
    const { view, body, local, messages } = run('<div class="viz-carousel" aria-label="Designs"><section data-variant="Compact"><input aria-label="Draft" value="keep"></section><section data-variant="Editorial" hidden></section></div>');
    const sections = body.querySelectorAll("section");
    const state = local({ enabled: true });
    for (const section of sections) new view.Tweak({ container: section, onChange: () => {} }).addToggle(state, "enabled");
    await waitFor(() => expect(within(body).getByRole("combobox", { name: "Design variant" })).toBeInTheDocument());
    const draft = within(body).getByRole("textbox", { name: "Draft" });
    fireEvent.click(within(body).getByRole("button", { name: "Next design" }));
    expect(sections[0]).toHaveAttribute("hidden"); expect(sections[1]).not.toHaveAttribute("hidden");
    await waitFor(() => { const last = [...messages].reverse().find((message) => message.type === "argmax:visualization-controls"); expect(last?.type === "argmax:visualization-controls" && last.groups.map((group) => group.variant)).toEqual(["Editorial"]); });
    fireEvent.click(within(body).getByRole("button", { name: "Previous design" }));
    expect(within(body).getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect(draft).toHaveValue("keep");
  });

  it("provides keyboard tabs and focus or touch tooltips without unsafe HTML", async () => {
    const { body } = run('<div class="nav nav-pills" role="tablist"><button class="nav-link" id="a" role="tab" aria-controls="panel-a" aria-selected="true">A</button><button class="nav-link" id="b" role="tab" aria-controls="panel-b">B</button></div><div id="panel-a" role="tabpanel">First</div><div id="panel-b" role="tabpanel" hidden>Second</div><button data-tooltip="&lt;script&gt;safe&lt;/script&gt;">Details</button>');
    const first = within(body).getByRole("tab", { name: "A" });
    await waitFor(() => expect(within(body).getByRole("tab", { name: "B" }).tabIndex).toBe(-1));
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(within(body).getByRole("tab", { name: "B" })).toHaveAttribute("aria-selected", "true");
    const details = within(body).getByRole("button", { name: "Details" });
    fireEvent.focusIn(details);
    expect(within(body).getByRole("tooltip").textContent).toBe("<script>safe</script>");
    expect(within(body).getByRole("tooltip").querySelector("script")).toBeNull();
    expect(details).toHaveAttribute("aria-describedby");
    fireEvent.keyDown(details, { key: "Escape" });
    expect(within(body).queryByRole("tooltip")).toBeNull(); expect(details).not.toHaveAttribute("aria-describedby");
  });

  it("renders calendar overlap lanes, selection, safe text, and invalid-data recovery", () => {
    const { view, body, local } = run('<viz-calendar date="2026-09-08" start="11:00" end="14:00" interactive></viz-calendar>');
    const calendar = body.querySelector("viz-calendar") as Calendar;
    const events = local([{ title: "<img onerror=bad()>", start: "12:00", end: "12:30", id: "standup", video: true }, { title: "Email", start: "12:00", end: "12:30" }, { title: "Design", start: "13:00", end: "14:00" }]);
    calendar.events = events;
    const root = calendar.shadowRoot!;
    const buttons = root.querySelectorAll("button");
    expect(buttons).toHaveLength(3); expect(root.querySelector("img")).toBeNull();
    expect(buttons[0].querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(buttons[0].style.width).toBe("calc(50% - 4px)"); expect(buttons[2].style.width).toBe("calc(100% - 4px)");
    const selected = vi.fn(); calendar.addEventListener("eventselect", selected);
    fireEvent.click(buttons[0]);
    const detail = (selected.mock.calls[0][0] as CustomEvent<{ event: unknown; index: number }>).detail;
    expect(detail.event).toBe(events[0]); expect(detail.index).toBe(0);
    calendar.events = local([{ title: "Invalid", start: "12:30", end: "12:00" }]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("after start");
    calendar.events = []; expect(root.textContent).toContain("No events"); expect(root.querySelector('[role="alert"]')).toBeNull();
    calendar.setAttribute("events", JSON.stringify(events)); expect(root.querySelectorAll("button")).toHaveLength(0);
    calendar.events = undefined; expect(root.querySelectorAll("button")).toHaveLength(3);
    expect(view.openai.capabilities.calendar).toBe(true);
  });

  it("keeps exported state local and rejects unavailable follow-up actions", async () => {
    const { view, messages, local } = run("<div>Export</div>", { standalone: true, instanceId: "export-test" });
    await view.openai.setWidgetState(local({ modelContent: { choice: "B" } }));
    expect(view.openai.widgetState).toEqual({ modelContent: { choice: "B" }, privateContent: null });
    expect(messages).toEqual([]); expect(view.openai.capabilities.controls).toBe(false);
    await expect(view.openai.sendFollowUpMessage({ prompt: "Explain" })).rejects.toThrow("conversation host");
  });
});
