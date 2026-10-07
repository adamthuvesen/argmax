// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/dom";
import { visualizationDocument, VISUALIZATION_CSP } from "./visualizationDocument.js";

const appearance = { dark: true, variables: { "--foreground": "#ffffff", "--font-size-base": "14px" } };
afterEach(() => document.body.replaceChildren());

function runDocument(source: string): HTMLElement {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const view = frame.contentWindow;
  if (!view) throw new Error("Test iframe is unavailable");
  Object.defineProperty(view, "ResizeObserver", { value: ResizeObserver });
  Object.defineProperty(view, "requestAnimationFrame", { value: () => 0 });
  view.document.open();
  view.document.write(source);
  view.document.close();
  return view.document.body;
}

describe("visualizationDocument", () => {
  it("puts policy and the host bootstrap before untrusted scripts without executing them", async () => {
    const document = await visualizationDocument('<div id="chart">Chart</div><script>window.untrustedVisualizationRan = true;</script>', appearance);
    const parsed = new DOMParser().parseFromString(document, "text/html");
    expect(parsed.head.firstElementChild?.getAttribute("content")).toBe(VISUALIZATION_CSP);
    expect(parsed.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(parsed.body.querySelector("#chart")?.textContent).toBe("Chart");
    expect(document.indexOf("argmax:visualization-height")).toBeLessThan(document.indexOf("window.untrustedVisualizationRan"));
    expect("untrustedVisualizationRan" in window).toBe(false);
    expect(VISUALIZATION_CSP).toContain("connect-src 'none'");
    expect(VISUALIZATION_CSP).not.toContain("unsafe-eval");
    expect(VISUALIZATION_CSP).toContain("https://cdn.jsdelivr.net");
    expect(VISUALIZATION_CSP).toContain("https://fonts.gstatic.com");
  });

  it("preserves styles, scripts, and content in full HTML documents", async () => {
    const document = await visualizationDocument('<!doctype html><html><head><style>.demo { color: red; }</style><script>const headScript = true;</script></head><body><button>Run</button><script>const bodyScript = true;</script></body></html>', appearance);
    const parsed = new DOMParser().parseFromString(document, "text/html");
    expect(parsed.body.textContent).toContain(".demo { color: red; }");
    expect(parsed.body.textContent).toContain("const headScript = true;");
    expect(parsed.body.textContent).toContain("const bodyScript = true;");
    expect(parsed.body.querySelector("button")?.textContent).toBe("Run");
    expect(document.match(/<!doctype/gi)).toHaveLength(1);
  });

  it("removes refresh, base URLs, and speculative resource links", async () => {
    const document = await visualizationDocument('<base href="https://example.com"><meta HTTP-EQUIV="Refresh" content="0;url=https://example.com"><link rel="stylesheet" href="https://cdn.jsdelivr.net/style.css"><link rel="DNS-PREFETCH" href="https://example.com"><link rel="preconnect" href="https://example.com"><link rel="alternate prefetch" href="https://example.com"><div>Chart</div>', appearance);
    const parsed = new DOMParser().parseFromString(document, "text/html");
    expect(parsed.querySelector("base")).toBeNull();
    expect(Array.from(parsed.querySelectorAll("meta")).some((meta) => meta.httpEquiv.toLowerCase() === "refresh")).toBe(false);
    expect(parsed.querySelectorAll("link")).toHaveLength(1);
    expect(parsed.querySelector("link")?.rel).toBe("stylesheet");
  });

  it("escapes script delimiters in host appearance values", async () => {
    const document = await visualizationDocument("<div>Chart</div>", { dark: false, variables: { "--font-sans": '</script><script>alert("x")</script>' } });
    const parsed = new DOMParser().parseFromString(document, "text/html");
    expect(parsed.querySelectorAll("script")).toHaveLength(2);
    expect(parsed.head.textContent).toContain("\\u003c/script>");
  });

  it("switches skill tabs with clicks and keyboard navigation while skipping disabled tabs", async () => {
    const source = await visualizationDocument(`<div class="nav nav-pills" role="tablist" aria-label="Platform">
      <button class="nav-link active" id="mac" role="tab" aria-controls="mac-panel" aria-selected="true">macOS</button>
      <button class="nav-link" id="disabled" role="tab" aria-controls="disabled-panel" disabled>Unavailable</button>
      <button class="nav-link" id="linux" role="tab" aria-controls="linux-panel" aria-selected="false">Linux</button>
    </div><div id="mac-panel" role="tabpanel" aria-labelledby="mac">macOS content</div><div id="disabled-panel" role="tabpanel" hidden>Unavailable content</div><div id="linux-panel" role="tabpanel" aria-labelledby="linux" hidden>Linux content</div>`, appearance);
    const body = runDocument(source);
    const mac = within(body).getByRole("tab", { name: "macOS" });
    const linux = within(body).getByRole("tab", { name: "Linux" });
    const macPanel = within(body).getByRole("tabpanel", { name: "macOS" });
    await waitFor(() => expect(linux.tabIndex).toBe(-1));
    fireEvent.click(linux);
    expect(linux).toHaveAttribute("aria-selected", "true");
    expect(within(body).getByRole("tabpanel", { name: "Linux" })).not.toHaveAttribute("hidden");
    expect(macPanel).toHaveAttribute("hidden");
    fireEvent.keyDown(linux, { key: "ArrowRight" });
    expect(mac).toHaveAttribute("aria-selected", "true");
    expect(body.ownerDocument.activeElement).toBe(mac);
    fireEvent.keyDown(mac, { key: "End" });
    expect(linux).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(linux, { key: "Home" });
    expect(mac).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(mac, { key: "ArrowLeft" });
    expect(linux).toHaveAttribute("aria-selected", "true");
  });

  it("keeps a shared tab panel visible and updates its accessible label", async () => {
    const source = await visualizationDocument('<div class="nav nav-pills" role="tablist" aria-label="Period"><button class="nav-link" id="week" role="tab" aria-controls="chart" aria-selected="true">Week</button><button class="nav-link" id="month" role="tab" aria-controls="chart">Month</button></div><div id="chart" role="tabpanel" aria-labelledby="week">Chart</div>', appearance);
    const body = runDocument(source);
    const month = within(body).getByRole("tab", { name: "Month" });
    await waitFor(() => expect(month.tabIndex).toBe(-1));
    fireEvent.click(month);
    expect(within(body).getByRole("tabpanel", { name: "Month" })).not.toHaveAttribute("hidden");
  });

  it("renders static icons through the maintained Lucide browser library", async () => {
    const source = await visualizationDocument('<i data-lucide="arrow-right" role="img" aria-label="Continue"></i>', appearance);
    const body = runDocument(source);
    await waitFor(() => expect(within(body).getByRole("img", { name: "Continue" }).tagName).toBe("svg"));
    const icon = within(body).getByRole("img", { name: "Continue" });
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(source).toContain("Permission to use, copy, modify, and/or distribute this software");
  });

  it("renders new icon names inserted after loading through createIcons", async () => {
    const source = await visualizationDocument(`<button id="add">Add icon</button><script>
      document.getElementById('add').addEventListener('click', () => {
        const icon = document.createElement('i');
        icon.dataset.lucide = 'chart-line';
        icon.setAttribute('role', 'img');
        icon.setAttribute('aria-label', 'Growth');
        document.body.append(icon);
        lucide.createIcons({ attrs: { width: 18, height: 18 } });
      });
    </script>`, appearance);
    const body = runDocument(source);
    fireEvent.click(within(body).getByRole("button", { name: "Add icon" }));
    const icon = within(body).getByRole("img", { name: "Growth" });
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("width", "18");
    expect(icon.querySelectorAll("path").length).toBeGreaterThan(0);
  });
});
