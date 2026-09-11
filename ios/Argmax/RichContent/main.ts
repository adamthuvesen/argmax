import katex from "katex";
import "katex/dist/katex.min.css";
import mermaid from "mermaid";
import "./style.css";

type RichPayload = {
  kind: "mermaid" | "math";
  source: string;
  theme: "light" | "dark";
  display: boolean;
  expanded: boolean;
};

declare global {
  interface Window {
    renderArgmaxRich: (payload: RichPayload) => Promise<void>;
  }
}

// This entry runs in its own WKWebView. Keep its optional message handler
// local rather than redeclaring the older embed page's global Window shape.
const richWindow = window as Window & {
  webkit?: { messageHandlers?: { argmaxRich?: { postMessage: (value: unknown) => void } } };
};

const content = document.querySelector<HTMLElement>("#content");
let renderCount = 0;

function reportSize(error?: string): void {
  requestAnimationFrame(() => {
    const height = Math.ceil(document.documentElement.scrollHeight);
    richWindow.webkit?.messageHandlers?.argmaxRich?.postMessage({ height, error });
  });
}

window.renderArgmaxRich = async (payload): Promise<void> => {
  if (!content) return;
  const generation = ++renderCount;
  document.documentElement.dataset.theme = payload.theme;
  document.documentElement.dataset.expanded = String(payload.expanded);
  content.replaceChildren();
  delete content.dataset.error;
  try {
    if (payload.kind === "math") {
      katex.render(payload.source, content, {
        displayMode: payload.display || payload.expanded || payload.source.includes("\\begin{"),
        output: "htmlAndMathml",
        strict: "warn",
        throwOnError: false,
        trust: false
      });
    } else {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: payload.theme === "dark" ? "dark" : "neutral",
        fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        flowchart: { htmlLabels: false, useMaxWidth: !payload.expanded }
      });
      const id = `argmax-rich-${generation}`;
      const rendered = await mermaid.render(id, payload.source.trim());
      if (generation !== renderCount) return;
      content.innerHTML = rendered.svg;
      rendered.bindFunctions?.(content);
    }
    reportSize();
  } catch (caught) {
    if (generation !== renderCount) return;
    content.textContent = caught instanceof Error ? caught.message : "Could not render this content.";
    content.dataset.error = "true";
    reportSize(content.textContent);
  }
};

new ResizeObserver(() => reportSize()).observe(content ?? document.documentElement);
