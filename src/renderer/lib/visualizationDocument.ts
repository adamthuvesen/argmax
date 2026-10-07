import lucideSource from "lucide/dist/umd/lucide.min.js?raw";
import lucideLicense from "lucide/LICENSE?raw";

const VISUALIZATION_CDNS = "https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com";

export const VISUALIZATION_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${VISUALIZATION_CDNS}`,
  `style-src 'unsafe-inline' ${VISUALIZATION_CDNS} https://fonts.googleapis.com https://fonts.bunny.net`,
  `font-src data: ${VISUALIZATION_CDNS} https://fonts.gstatic.com https://fonts.bunny.net`,
  `img-src data: blob: ${VISUALIZATION_CDNS}`,
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'"
].join("; ");

export interface VisualizationAppearance {
  dark: boolean;
  variables: Record<string, string>;
}

const VISUALIZATION_RESET = `
* { box-sizing: border-box; }
html { color-scheme: light; }
body { margin: 0; padding: 12px; background: var(--background); color: var(--foreground); font: var(--font-size-base)/1.5 var(--font-sans); overflow-wrap: anywhere; }
button, input, select, textarea { font: inherit; color: inherit; }
button, select { cursor: pointer; }
input, select, textarea { max-width: 100%; }
img, svg, canvas { max-width: 100%; }
.card { padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--card-foreground); }
.btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--secondary); color: var(--secondary-foreground); }
.btn-primary, .btn[aria-pressed="true"] { background: var(--primary); color: var(--primary-foreground); }
.text-muted { color: var(--muted-foreground); }
.text-small { font-size: max(11px, calc(var(--font-size-base) - 2px)); }
.table-responsive { overflow-x: auto; }
.viz-row, .nav-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.viz-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.nav-pills .nav-link { padding: 6px 12px; border: 0; border-radius: 6px; color: var(--muted-foreground); background: transparent; }
.nav-pills .nav-link.active { color: var(--foreground); background: var(--muted); }
.nav-justified .nav-link { flex: 1 1 0; min-width: 0; }
.lucide { width: 1em; height: 1em; vertical-align: -0.125em; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
`;

export function visualizationDocument(html: string, appearance: VisualizationAppearance): Promise<string> {
  // A detached template neither executes scripts nor fetches embedded resources.
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const element of template.content.querySelectorAll("base, meta[http-equiv], link")) {
    const refresh = element.tagName === "META" &&
      element.getAttribute("http-equiv")?.toLowerCase() === "refresh";
    const speculativeLink = element.tagName === "LINK" &&
      element.getAttribute("rel")?.toLowerCase().split(/\s+/).some((rel) =>
        ["prefetch", "dns-prefetch", "preconnect", "prerender"].includes(rel));
    if (element.tagName === "BASE" || refresh || speculativeLink) element.remove();
  }
  const serializedAppearance = JSON.stringify(appearance).replace(/</g, "\\u003c");
  const lucideScript = `/*\n${lucideLicense.replace(/\*\//g, "*\\/")}\n*/\n${lucideSource}`.replace(/<\/script/gi, "<\\/script");
  const bootstrap = `
(() => {
  const tabListFor = (target) => target instanceof Element ? target.closest('.nav-pills[role="tablist"]') : null;
  const tabsFor = (list) => Array.from(list.querySelectorAll('.nav-link[role="tab"]')).filter((tab) => tab.closest('[role="tablist"]') === list);
  const tabEnabled = (tab) => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true';
  const activateTab = (list, selected, focus = false) => {
    const tabs = tabsFor(list);
    for (const tab of tabs) {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('active', active);
      tab.tabIndex = active ? 0 : -1;
    }
    const selectedPanel = selected.getAttribute('aria-controls');
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel?.getAttribute('role') === 'tabpanel') {
        const active = panel.id === selectedPanel;
        panel.hidden = !active;
        if (active) panel.setAttribute('aria-labelledby', selected.id);
      }
    }
    if (focus) selected.focus();
  };
  document.addEventListener('click', (event) => {
    const list = tabListFor(event.target);
    const tab = event.target instanceof Element ? event.target.closest('.nav-link[role="tab"]') : null;
    if (list && tab && tabEnabled(tab)) activateTab(list, tab);
  });
  document.addEventListener('keydown', (event) => {
    const list = tabListFor(event.target);
    if (!list) return;
    const tabs = tabsFor(list).filter(tabEnabled);
    const current = tabs.indexOf(event.target);
    if (current < 0 || tabs.length === 0) return;
    const vertical = list.getAttribute('aria-orientation') === 'vertical';
    const next = vertical ? 'ArrowDown' : 'ArrowRight';
    const previous = vertical ? 'ArrowUp' : 'ArrowLeft';
    let index;
    if (event.key === next) index = (current + 1) % tabs.length;
    else if (event.key === previous) index = (current + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(list, tabs[index], true);
  });
  const applyAppearance = (appearance) => {
    document.documentElement.style.colorScheme = appearance.dark ? 'dark' : 'light';
    document.documentElement.dataset.theme = appearance.dark ? 'dark' : 'light';
    for (const [name, value] of Object.entries(appearance.variables)) {
      document.documentElement.style.setProperty(name, value);
    }
  };
  applyAppearance(${serializedAppearance});
  window.addEventListener('message', (event) => {
    if (event.source === parent && event.data?.type === 'argmax:visualization-appearance') {
      applyAppearance(event.data.appearance);
    }
  });
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a, area')) event.preventDefault();
  }, true);
  window.addEventListener('DOMContentLoaded', () => {
    window.lucide.createIcons({ attrs: { width: 16, height: 16 } });
    for (const list of document.querySelectorAll('.nav-pills[role="tablist"]')) {
      const tabs = tabsFor(list).filter(tabEnabled);
      const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0];
      if (selected) activateTab(list, selected);
    }
    let scheduled = false;
    const resize = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        parent.postMessage({ type: 'argmax:visualization-height', height: Math.ceil(Math.max(document.body.getBoundingClientRect().height, document.body.scrollHeight)) }, '*');
      });
    };
    new ResizeObserver(resize).observe(document.body);
    window.addEventListener('load', resize);
    resize();
  });
})();`;
  return Promise.resolve(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${VISUALIZATION_RESET}</style><script>${lucideScript}</script><script>${bootstrap}</script></head><body>${template.innerHTML}</body></html>`);
}
