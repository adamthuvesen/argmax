// @vitest-environment jsdom
//
// The two scripts `browser::automation` injects into a page. They are plain
// text on the Rust side (`include_str!`), so this loads the same bytes the app
// ships and runs them against jsdom fixtures — the only place their DOM logic
// is executable without a live WKWebView.

import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SNAPSHOT_JS = readFileSync("src-tauri/src/browser/snapshot.js", "utf8");
const ACTIONS_JS = readFileSync("src-tauri/src/browser/actions.js", "utf8");
const DIALOG_JS = readFileSync("src-tauri/src/browser/dialog.js", "utf8");

interface FoundElement {
  ref: string;
  role: string;
  name: string;
  value: string;
}

interface AgentApi {
  snapshot: (options?: { interactiveOnly?: boolean }) => {
    url: string;
    title: string;
    tree: string;
    truncated: boolean;
  };
  find: (query: string) => { matches: FoundElement[] };
  linkUrl: (ref: string) => { url?: string; error?: string };
  getText: (maxChars?: number) => { text: string; truncated: boolean };
  extract: (maxChars?: number) => {
    metadata: {
      title: string;
      description: string | null;
      canonicalUrl: string | null;
      language: string | null;
      author: string | null;
      publishedTime: string | null;
      modifiedTime: string | null;
      siteName: string | null;
    };
    headings: Array<{ level: number; text: string }>;
    sections: Array<{ heading: string | null; level: number | null; text: string }>;
    tables: Array<{ caption: string | null; headers: string[]; rows: string[][] }>;
    links: Array<{ text: string | null; url: string }>;
    truncated: boolean;
  };
  rect: (ref: string) => { ok?: { width: number; height: number }; error?: string };
  click: (ref: string) => { ok?: true; error?: string; target?: string };
  type: (
    ref: string,
    text: string,
    options?: { submit?: boolean }
  ) => { ok?: true; error?: string; submitted?: boolean };
  select: (ref: string, value: string) => { ok?: true; error?: string; selected?: string };
  hover: (ref: string) => { ok?: true; error?: string };
  dragBegin: (
    id: string,
    spec: {
      ref: string;
      toRef?: string;
      startX?: number;
      startY?: number;
      endX?: number;
      endY?: number;
      deltaX?: number;
      deltaY?: number;
      steps?: number;
    }
  ) => { ok?: true; steps?: number; error?: string };
  dragStep: (id: string, index: number) => { ok?: true; error?: string };
  dragEnd: (
    id: string,
    cancel?: boolean
  ) => { ok?: true; cancelled?: true; error?: string; target?: string; droppedOn?: string };
  pressKey: (key: string, modifiers?: string[]) => { ok?: true; error?: string };
  scroll: (spec: { ref?: string; direction: string; amount?: number }) => {
    ok?: true;
    error?: string;
    scrollY?: number;
  };
  waitFor: (
    id: string,
    spec: { text?: string; ref?: string; urlIncludes?: string }
  ) => { ok?: true; pending?: boolean; error?: string };
  handleDialog: (
    accept: boolean,
    promptText?: string | null
  ) => {
    ok?: true;
    error?: string;
    armed?: boolean;
    answered?: { kind: string; message: string; autoAnswer: unknown; wasArmed: boolean } | null;
  };
}

function api(): AgentApi {
  return (window as unknown as { __argmax: AgentApi }).__argmax;
}

/** Loads both scripts the way `automation::call_script` does. The Function
 *  constructor is the point: these are script *text* on the Rust side, and a
 *  test that imported a parallel TypeScript copy would prove nothing about
 *  what the app injects. */
function install(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- loading the shipped script text is what is under test
  new Function(`${SNAPSHOT_JS}\n${ACTIONS_JS}`)();
}

/** `dialog.js` is an *initialization* script, installed before the page runs
 *  and only on tabs a session opened, so it loads on its own. */
function installDialogCapture(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call -- loading the shipped script text is what is under test
  new Function(DIALOG_JS)();
}

beforeAll(() => {
  // jsdom lays nothing out, so every rect is zero and the snapshot's
  // visibility filter would drop the whole document. Give elements a box
  // unless the fixture explicitly asks for none.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    const zero = this.hasAttribute("data-no-box");
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: zero ? 0 : 120,
      bottom: zero ? 0 : 24,
      width: zero ? 0 : 120,
      height: zero ? 0 : 24,
      toJSON: () => ({})
    };
  };
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollBy = vi.fn();
  window.scrollBy = vi.fn();
  // innerText is not implemented in jsdom; textContent is close enough for
  // the substring matching getText and waitFor do.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? "";
    }
  });
});

beforeEach(() => {
  // Metadata lives in the head, so a test that adds meta tags has to start
  // from an empty one — and `document.title` writes the element back.
  document.head.innerHTML = "";
  document.documentElement.lang = "";
  document.title = "Fixture";
  document.body.innerHTML = "";
  delete (window as unknown as { __argmax?: AgentApi }).__argmax;
  delete (window as unknown as { __argmaxDialog?: unknown }).__argmaxDialog;
});

describe("snapshot.js", () => {
  it("emits a header and an aria line per interactive node, with stable refs", () => {
    document.body.innerHTML = `
      <h1>Example Domain</h1>
      <p>This domain is for use in illustrative examples.</p>
      <a href="https://www.iana.org/domains/example">More information</a>
      <input type="search" aria-label="Search" value="tauri" />
      <button aria-label="Sign in">Sign in</button>
    `;
    install();

    const first = api().snapshot();
    expect(first.tree).toContain("url: http://localhost:3000/");
    expect(first.tree).toContain("title: Fixture");
    // Headings are structure, not handles: no ref, and their own text is not
    // repeated underneath them.
    expect(first.tree).toContain('- heading "Example Domain" level=1');
    expect(first.tree).not.toContain("- text: Example Domain");
    expect(first.tree).toMatch(
      /- link "More information" \[ref=e\d+\] href=https:\/\/www\.iana\.org\/domains\/example/
    );
    expect(first.tree).toMatch(/- searchbox "Search" \[ref=e\d+\] value="tauri"/);
    expect(first.tree).toMatch(/- button "Sign in" \[ref=e\d+\]/);
    expect(first.truncated).toBe(false);

    // Re-snapshotting reuses the attribute the node already carries, so a ref
    // an agent is holding stays pointed at the same element.
    const link = document.querySelector("a") as HTMLAnchorElement;
    const ref = link.getAttribute("data-argmax-ref");
    expect(ref).toMatch(/^e\d+$/);
    expect(api().snapshot().tree).toContain(`[ref=${ref}]`);
  });

  it("skips hidden subtrees and boxless nodes", () => {
    document.body.innerHTML = `
      <div style="display: none"><button>Hidden by display</button></div>
      <div aria-hidden="true"><button>Hidden from a11y</button></div>
      <button data-no-box>Collapsed</button>
      <button>Visible</button>
    `;
    install();

    const tree = api().snapshot().tree;
    expect(tree).toContain('- button "Visible"');
    expect(tree).not.toContain("Hidden by display");
    expect(tree).not.toContain("Hidden from a11y");
    expect(tree).not.toContain("Collapsed");
  });

  it("interactiveOnly drops prose but keeps headings and controls", () => {
    document.body.innerHTML = `
      <h2>Results</h2>
      <p>Some prose nobody can click.</p>
      <a href="/next">Next</a>
    `;
    install();

    const tree = api().snapshot({ interactiveOnly: true }).tree;
    expect(tree).toContain('- heading "Results"');
    expect(tree).toContain('- link "Next"');
    expect(tree).not.toContain("Some prose");
  });

  it("marks the tree truncated once the node cap is hit", () => {
    document.body.innerHTML = Array.from(
      { length: 900 },
      (_, index) => `<button>Row ${index}</button>`
    ).join("");
    install();

    const snapshot = api().snapshot({ interactiveOnly: true });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.tree.trimEnd().endsWith("- (truncated)")).toBe(true);
  });

  it("find matches role, name and value case-insensitively", () => {
    document.body.innerHTML = `
      <button>Accept all cookies</button>
      <a href="/help">Help centre</a>
      <input aria-label="Query" value="tauri wry" />
    `;
    install();

    expect(api().find("cookies").matches.map((match) => match.name)).toEqual([
      "Accept all cookies"
    ]);
    expect(api().find("TAURI").matches.map((match) => match.role)).toEqual(["textbox"]);
    expect(api().find("").matches).toEqual([]);
    // Every match carries a usable handle.
    for (const match of api().find("help").matches) expect(match.ref).toMatch(/^e\d+$/);
  });

  it("resolves a link ref to an absolute http URL", () => {
    document.body.innerHTML = `<a href="/details"><span>Details</span></a><button>Save</button>`;
    install();
    const linkRef = api().find("Details").matches[0]?.ref;
    const buttonRef = api().find("Save").matches[0]?.ref;

    expect(api().linkUrl(linkRef).url).toBe("http://localhost:3000/details");
    expect(api().linkUrl(buttonRef).error).toContain("not an http(s) link");
  });

  it("getText prefers main over the rest of the page and reports truncation", () => {
    document.body.innerHTML = `<nav>Skip me</nav><main>The readable part</main>`;
    install();

    expect(api().getText().text).toBe("The readable part");
    const clipped = api().getText(5);
    expect(clipped.text).toBe("The r");
    expect(clipped.truncated).toBe(true);
  });

  it("extract returns bounded article structure and metadata", () => {
    document.documentElement.lang = "en";
    document.head.insertAdjacentHTML(
      "beforeend",
      `
      <meta name="description" content="A useful description" />
      <meta name="author" content="Ada Lovelace" />
      <meta property="article:published_time" content="2026-09-03" />
      <link rel="canonical" href="https://example.com/article" />
    `
    );
    document.body.innerHTML = `
      <nav><a href="https://example.com/skip">Skip this</a></nav>
      <article>
        <h1>How the machine works</h1>
        <p>Opening summary.</p>
        <h2>Results</h2>
        <p>The useful result.</p>
        <table>
          <caption>Measurements</caption>
          <thead><tr><th>Name</th><th>Value</th></tr></thead>
          <tbody><tr><td>Speed</td><td>42</td></tr></tbody>
        </table>
        <a href="/source">Primary source</a>
      </article>
    `;
    install();

    const extracted = api().extract();
    expect(extracted.metadata).toMatchObject({
      title: "Fixture",
      description: "A useful description",
      canonicalUrl: "https://example.com/article",
      language: "en",
      author: "Ada Lovelace",
      publishedTime: "2026-09-03"
    });
    expect(extracted.headings).toEqual([
      { level: 1, text: "How the machine works" },
      { level: 2, text: "Results" }
    ]);
    expect(extracted.sections).toEqual([
      { heading: "How the machine works", level: 1, text: "Opening summary." },
      { heading: "Results", level: 2, text: "The useful result." }
    ]);
    expect(extracted.tables).toEqual([
      { caption: "Measurements", headers: ["Name", "Value"], rows: [["Speed", "42"]] }
    ]);
    expect(extracted.links).toEqual([
      { text: "Primary source", url: "http://localhost:3000/source" }
    ]);
    expect(extracted.truncated).toBe(false);
    expect(api().extract(5).truncated).toBe(true);
  });

  it("extract drops page chrome when there is no article or main to trust", () => {
    document.body.innerHTML = `
      <nav><a href="/pricing">Pricing</a><p>Menu blurb</p></nav>
      <h1>The reading</h1>
      <p>The body of it.</p>
      <a href="/cited">Cited work</a>
      <footer><a href="/legal">Legal</a><p>Copyright notice</p></footer>
    `;
    install();

    const extracted = api().extract();
    expect(extracted.headings).toEqual([{ level: 1, text: "The reading" }]);
    expect(extracted.sections).toEqual([
      { heading: "The reading", level: 1, text: "The body of it." }
    ]);
    expect(extracted.links).toEqual([{ text: "Cited work", url: "http://localhost:3000/cited" }]);
  });
});

/** The gesture Rust drives: begin, then one step per call, then end. */
function runDrag(
  spec: Parameters<AgentApi["dragBegin"]>[1],
  id = "d1"
): ReturnType<AgentApi["dragEnd"]> {
  const begun = api().dragBegin(id, spec);
  if (begun.error) return begun;
  for (let step = 1; step <= (begun.steps ?? 0); step += 1) api().dragStep(id, step);
  return api().dragEnd(id);
}

describe("actions.js", () => {
  it("clicks by ref and runs the element's default action", () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    install();
    const ref = api().find("Go").matches[0]?.ref;

    const seen: string[] = [];
    const button = document.getElementById("go") as HTMLButtonElement;
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      button.addEventListener(type, () => seen.push(type));
    }

    const result = api().click(ref);
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["mouseover", "mousedown", "mouseup", "click"]);
  });

  it("names a stale ref and says a fresh snapshot is needed", () => {
    document.body.innerHTML = `<button>Go</button>`;
    install();
    const ref = api().find("Go").matches[0]?.ref;
    document.body.innerHTML = "";

    const result = api().click(ref);
    expect(result.error).toContain(ref);
    expect(result.error).toContain("fresh snapshot");
    expect(api().rect(ref).error).toContain("fresh snapshot");
  });

  it("types through the native setter so a framework's state follows", () => {
    document.body.innerHTML = `<form><input aria-label="Search" /></form>`;
    install();
    const ref = api().find("Search").matches[0]?.ref;
    const input = document.querySelector("input") as HTMLInputElement;

    // What React installs: a value setter on the instance shadowing the
    // prototype's. Writing `element.value = x` would hit this and leave the
    // real DOM value untouched.
    const events: string[] = [];
    for (const type of ["input", "change"]) {
      input.addEventListener(type, () => events.push(type));
    }

    expect(api().type(ref, "tauri wry").ok).toBe(true);
    expect(input.value).toBe("tauri wry");
    expect(events).toEqual(["input", "change"]);
  });

  it("submitting presses Enter and falls back to the field's form", () => {
    document.body.innerHTML = `<form><input aria-label="Search" /></form>`;
    install();
    const ref = api().find("Search").matches[0]?.ref;
    const form = document.querySelector("form") as HTMLFormElement;
    const submitted = vi.fn();
    form.requestSubmit = submitted;
    const keys: string[] = [];
    document.addEventListener("keydown", (event) => keys.push(event.key));

    const result = api().type(ref, "tauri wry", { submit: true });
    expect(result.ok).toBe(true);
    expect(keys).toEqual(["Enter"]);
    expect(submitted).toHaveBeenCalledOnce();
  });

  it("a page that handles Enter itself is not double-submitted", () => {
    document.body.innerHTML = `<form><input aria-label="Search" /></form>`;
    install();
    const ref = api().find("Search").matches[0]?.ref;
    const form = document.querySelector("form") as HTMLFormElement;
    const submitted = vi.fn();
    form.requestSubmit = submitted;
    document.addEventListener("keydown", (event) => event.preventDefault());

    expect(api().type(ref, "x", { submit: true }).submitted).toBe(true);
    expect(submitted).not.toHaveBeenCalled();
  });

  it("selects an option by value or by its label", () => {
    document.body.innerHTML = `
      <select aria-label="Sort"><option value="new">Newest</option><option value="old">Oldest</option></select>
    `;
    install();
    const ref = api().find("Sort").matches[0]?.ref;
    const select = document.querySelector("select") as HTMLSelectElement;

    expect(api().select(ref, "old").selected).toBe("old");
    expect(select.value).toBe("old");
    expect(api().select(ref, "Newest").selected).toBe("new");
    expect(api().select(ref, "nope").error).toContain("no option matching");
  });

  it("refuses to type into something that is not a text field", () => {
    document.body.innerHTML = `<button>Go</button>`;
    install();
    const ref = api().find("Go").matches[0]?.ref;
    expect(api().type(ref, "hi").error).toContain("not a text field");
  });

  it("hover and pressKey reach the element and the focused node", () => {
    document.body.innerHTML = `<a href="/x">Menu</a><input aria-label="Field" />`;
    install();
    const menuRef = api().find("Menu").matches[0]?.ref;
    const hovered: string[] = [];
    const link = document.querySelector("a") as HTMLAnchorElement;
    link.addEventListener("mouseover", () => hovered.push("mouseover"));
    expect(api().hover(menuRef).ok).toBe(true);
    expect(hovered).toEqual(["mouseover"]);

    const input = document.querySelector("input") as HTMLInputElement;
    input.focus();
    const keys: string[] = [];
    input.addEventListener("keyup", (event) => keys.push(event.key));
    expect(api().pressKey("Escape").ok).toBe(true);
    expect(keys).toEqual(["Escape"]);
    expect(api().pressKey("").error).toContain("needs a key name");
  });

  it("drags between refs with stepped pointer and HTML drag events", () => {
    document.body.innerHTML = `<button id="source">Card</button><button id="target">Column</button>`;
    install();
    const sourceRef = api().find("Card").matches[0]?.ref;
    const targetRef = api().find("Column").matches[0]?.ref;
    const source = document.getElementById("source") as HTMLButtonElement;
    const target = document.getElementById("target") as HTMLButtonElement;
    source.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 100, height: 40, right: 110, bottom: 60 } as DOMRect);
    target.getBoundingClientRect = () =>
      ({ left: 200, top: 100, width: 80, height: 60, right: 280, bottom: 160 } as DOMRect);
    const sourceEvents: string[] = [];
    const targetEvents: string[] = [];
    let startPoint: [number, number] | null = null;
    let endPoint: [number, number] | null = null;
    for (const type of ["mousedown", "mousemove", "mouseup", "dragstart", "dragend"]) {
      source.addEventListener(type, () => sourceEvents.push(type));
    }
    for (const type of ["mousemove", "mouseup", "dragover", "drop"]) {
      target.addEventListener(type, () => targetEvents.push(type));
    }
    source.addEventListener("mousedown", (event) => {
      startPoint = [event.clientX, event.clientY];
    });
    target.addEventListener("mouseup", (event) => {
      endPoint = [event.clientX, event.clientY];
    });

    const result = runDrag({
      ref: sourceRef,
      toRef: targetRef,
      startX: 5,
      startY: 6,
      endX: 70,
      endY: 50,
      steps: 3
    });
    expect(result.ok).toBe(true);
    expect(sourceEvents).toContain("mousedown");
    expect(sourceEvents).toContain("dragstart");
    expect(sourceEvents).toContain("dragend");
    expect(targetEvents.filter((event) => event === "mousemove")).toHaveLength(3);
    expect(targetEvents).toContain("mouseup");
    expect(targetEvents).toContain("drop");
    expect(startPoint).toEqual([15, 26]);
    expect(endPoint).toEqual([270, 150]);
  });

  it("leaves a drop zone it crosses, and releases the pointer when cancelled", () => {
    document.body.innerHTML = `<button id="source">Card</button><button id="target">Column</button>`;
    install();
    const source = document.getElementById("source") as HTMLButtonElement;
    const target = document.getElementById("target") as HTMLButtonElement;
    source.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }) as DOMRect;
    target.getBoundingClientRect = () =>
      ({ left: 100, top: 0, width: 10, height: 10, right: 110, bottom: 10 }) as DOMRect;
    // The gesture starts over the source and ends over the target, so the
    // retarget mid-drag is what fires dragleave.
    document.elementFromPoint = (x: number) => (x >= 100 ? target : source);
    const seen: string[] = [];
    for (const type of ["dragleave", "dragenter"]) {
      source.addEventListener(type, () => seen.push(`source:${type}`));
      target.addEventListener(type, () => seen.push(`target:${type}`));
    }
    const released: string[] = [];
    for (const type of ["pointercancel", "pointerup", "drop", "dragend"]) {
      source.addEventListener(type, () => released.push(type));
      target.addEventListener(type, () => released.push(type));
    }

    const begun = api().dragBegin("d9", { ref: api().find("Card").matches[0]?.ref, toRef: api().find("Column").matches[0]?.ref, steps: 4 });
    expect(begun.steps).toBe(4);
    for (let step = 1; step <= 4; step += 1) api().dragStep("d9", step);
    expect(seen).toEqual(["source:dragleave", "target:dragenter"]);

    // Cancelling still lifts the button: a half-finished gesture would leave
    // the page thinking the mouse is held down.
    expect(api().dragEnd("d9", true).cancelled).toBe(true);
    expect(released).toEqual(["pointercancel", "dragend"]);
    // The gesture is gone, so a second end is an error rather than a re-drop.
    expect(api().dragEnd("d9").error).toContain("not in progress");
  });

  it("flushes animation frames during a drag, and restores rAF afterwards", () => {
    document.body.innerHTML = `<button id="source">Card</button><button id="target">Column</button>`;
    install();
    // A hidden agent tab never fires a real frame, so the gesture has to run
    // the callback itself; jsdom stands in for that by never calling back.
    const nativeRaf = vi.fn(() => 7);
    const nativeCancel = vi.fn();
    window.requestAnimationFrame = nativeRaf;
    window.cancelAnimationFrame = nativeCancel;

    const measured: string[] = [];
    const source = document.getElementById("source") as HTMLButtonElement;
    source.addEventListener("pointerdown", () => {
      requestAnimationFrame(() => measured.push("measured on frame"));
    });

    const begun = api().dragBegin("d5", {
      ref: api().find("Card").matches[0]?.ref,
      toRef: api().find("Column").matches[0]?.ref,
      steps: 2
    });
    // The frame is only requested at press time; nothing has run it yet.
    expect(measured).toEqual([]);
    expect(nativeRaf).toHaveBeenCalledTimes(1);

    for (let step = 1; step <= (begun.steps ?? 0); step += 1) api().dragStep("d5", step);
    expect(measured).toEqual(["measured on frame"]);

    api().dragEnd("d5");
    expect(window.requestAnimationFrame).toBe(nativeRaf);
    expect(window.cancelAnimationFrame).toBe(nativeCancel);
  });

  it("drags a range input by delta and emits input plus change", () => {
    document.body.innerHTML = `<input type="range" min="0" max="100" step="10" value="0" aria-label="Volume" />`;
    install();
    const ref = api().find("Volume").matches[0]?.ref;
    const range = document.querySelector("input") as HTMLInputElement;
    const events: string[] = [];
    range.addEventListener("input", () => events.push("input"));
    range.addEventListener("change", () => events.push("change"));

    expect(runDrag({ ref, deltaX: 60, steps: 2 }).ok).toBe(true);
    expect(range.value).toBe("100");
    expect(events).toEqual(["input", "input", "change"]);
    expect(api().dragBegin("d2", { ref }).error).toContain("toRef or deltaX/deltaY");
  });

  it("scroll rejects a direction it cannot act on", () => {
    document.body.innerHTML = `<p>content</p>`;
    install();
    expect(api().scroll({ direction: "down" }).ok).toBe(true);
    expect(api().scroll({ direction: "sideways" }).error).toContain("up, down, left, right");
  });

  it("waitFor stays pending until the page matches, then resolves once", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    install();

    expect(api().waitFor("w1", { text: "Results for" }).pending).toBe(true);
    (document.getElementById("host") as HTMLElement).textContent = "Results for tauri";
    expect(api().waitFor("w1", { text: "Results for" }).ok).toBe(true);
    // The record is consumed, so a repeat is a fresh wait against the same
    // page — which still matches.
    expect(api().waitFor("w1", { text: "Results for" }).ok).toBe(true);
    expect(api().waitFor("w2", { text: "never here" }).pending).toBe(true);
    expect(api().waitFor("w3", {}).error).toContain("text, ref or urlIncludes");
  });

  it("waitFor on a URL matches the document's own location", () => {
    install();
    expect(api().waitFor("u1", { urlIncludes: "localhost" }).ok).toBe(true);
    expect(api().waitFor("u2", { urlIncludes: "iana.org" }).pending).toBe(true);
  });
});

describe("regression: a landmark must not swallow its own subtree", () => {
  it("names a container only when its text is short enough to be a label", () => {
    // Observed against duckduckgo.com: <main> took the whole page's text as
    // its name, matched the dedupe rule, and the snapshot stopped there.
    document.body.innerHTML = `
      <main>
        ${"<p>Long body copy that goes on and on. </p>".repeat(6)}
        <a href="/next">Next page</a>
      </main>
    `;
    install();

    // The landmark keeps its line but gets no name, and the walk continues
    // into it.
    expect(api().snapshot().tree).toMatch(/^- main$/m);
    expect(api().snapshot({ interactiveOnly: true }).tree).toContain('- link "Next page"');
    expect(api().find("next page").matches).toHaveLength(1);
  });
});

describe("dialog.js", () => {
  // The capture tells Rust a dialog happened by navigating to the
  // `argmax-newtab:` scheme, the same way the panel's own init script relays a
  // popup or a shortcut. The app intercepts and blocks it; jsdom has no
  // interception and logs "Not implemented: navigation" instead. Expected.

  it("dismisses an unexpected confirm and reports it in the snapshot header", () => {
    installDialogCapture();
    install();

    expect(window.confirm("Delete this?")).toBe(false);

    const tree = api().snapshot().tree;
    expect(tree).toContain('dialog: confirm "Delete this?" pending (auto-dismissed with false)');
  });

  it("answers the next dialog the way handleDialog armed it", () => {
    installDialogCapture();
    install();

    const armed = api().handleDialog(true);
    expect(armed.armed).toBe(true);
    expect(armed.answered).toBeNull();

    expect(window.confirm("Proceed?")).toBe(true);
    expect(window.prompt("Name?", "default")).toBeNull();
    expect(api().snapshot().tree).toContain('dialog: prompt "Name?" pending');
  });

  it("prompt takes the text it was armed with", () => {
    installDialogCapture();
    install();

    api().handleDialog(true, "argmax");
    expect(window.prompt("Name?", "default")).toBe("argmax");
    expect(api().snapshot().tree).toContain('dialog: prompt "Name?" answered "argmax"');
  });

  it("acknowledges the dialog that already fired", () => {
    installDialogCapture();
    install();

    window.confirm("Are you sure?");
    const answered = api().handleDialog(true).answered;
    expect(answered?.kind).toBe("confirm");
    expect(answered?.autoAnswer).toBe(false);
    expect(answered?.wasArmed).toBe(false);
  });

  it("says so on a tab that does not capture dialogs", () => {
    install();

    expect(api().handleDialog(true).error).toContain("only tabs a session opened");
  });
});
