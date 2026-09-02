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
  getText: (maxChars?: number) => { text: string; truncated: boolean };
  rect: (ref: string) => { ok?: { width: number; height: number }; error?: string };
  click: (ref: string) => { ok?: true; error?: string; target?: string };
  type: (
    ref: string,
    text: string,
    options?: { submit?: boolean }
  ) => { ok?: true; error?: string; submitted?: boolean };
  select: (ref: string, value: string) => { ok?: true; error?: string; selected?: string };
  hover: (ref: string) => { ok?: true; error?: string };
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

  it("getText prefers main over the rest of the page and reports truncation", () => {
    document.body.innerHTML = `<nav>Skip me</nav><main>The readable part</main>`;
    install();

    expect(api().getText().text).toBe("The readable part");
    const clipped = api().getText(5);
    expect(clipped.text).toBe("The r");
    expect(clipped.truncated).toBe(true);
  });
});

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
