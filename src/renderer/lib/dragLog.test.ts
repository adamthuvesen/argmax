// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDragBreadcrumbs } from "./dragLog.js";
import { clearRendererLog, rendererLogSnapshot } from "./rendererLogRing.js";

let uninstall: (() => void) | null = null;
let target: HTMLDivElement;

function fire(
  type: "dragstart" | "dragenter" | "dragover" | "drop" | "dragend",
  options: { accepted?: boolean; types?: string[]; files?: number } = {}
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: options.types ?? [], files: { length: options.files ?? 0 } }
  });
  if (options.accepted === true) {
    target.addEventListener(type, (e) => e.preventDefault(), { once: true });
  }
  target.dispatchEvent(event);
}

function messages(): string[] {
  return rendererLogSnapshot().map((entry) => entry.message);
}

beforeEach(() => {
  vi.useFakeTimers();
  clearRendererLog();
  target = document.createElement("div");
  target.setAttribute("aria-label", "Composer");
  document.body.append(target);
  uninstall = installDragBreadcrumbs();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  target.remove();
  vi.useRealTimers();
});

describe("drag breadcrumbs", () => {
  it("records a drag the page starts, accepts, and finishes", () => {
    fire("dragstart", { types: ["application/x-argmax-workspace"] });
    fire("dragover", { accepted: true });
    fire("drop", { accepted: true, files: 1 });
    fire("dragend");

    expect(messages()).toEqual(["drag started", "drag over", "drop", "drag ended"]);
    const over = rendererLogSnapshot()[1];
    expect(over.fields.accepted).toBe("true");
    expect(over.fields.target).toBe("div in Composer");
  });

  it("records that no target took the drag", () => {
    fire("dragenter", { types: ["Files"] });
    fire("dragover");

    expect(messages()).toEqual(["drag entered the window", "drag over"]);
    expect(rendererLogSnapshot()[1].fields.accepted).toBe("false");
  });

  it("warns when a drop is never followed by dragend", () => {
    fire("dragstart");
    fire("drop", { accepted: true });
    vi.advanceTimersByTime(20_000);

    const last = rendererLogSnapshot().at(-1);
    expect(last?.level).toBe("warn");
    expect(last?.message).toContain("no dragend");
  });

  it("warns when a drag the page started simply stops", () => {
    fire("dragstart");
    fire("dragover");
    vi.advanceTimersByTime(20_000);

    const last = rendererLogSnapshot().at(-1);
    expect(last?.level).toBe("warn");
    expect(last?.message).toBe("drag stopped without a drop or a dragend");
  });

  it("stays quiet after a completed drag from another app", () => {
    fire("dragenter", { types: ["Files"] });
    fire("drop", { accepted: true, files: 1 });
    vi.advanceTimersByTime(20_000);

    expect(messages().at(-1)).toBe("drop");
  });
});
