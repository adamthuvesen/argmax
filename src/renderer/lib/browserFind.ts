/**
 * Find-in-page for the browser panel. WKWebView has no find API exposed
 * through wry, so search runs as a page script over `browser:evaluate`: the
 * first call installs a small runtime (guarded by `window.__argmaxFind`, so
 * re-evaluating after a navigation re-arms it), walks visible text nodes and
 * wraps each match in a custom element the page's own CSS cannot override.
 *
 * Matches are found per text node. A query spanning an element boundary
 * ("hello <b>world</b>") is not found — the same trade every per-node
 * highlighter makes, and worth it for not rewriting the page's structure.
 */

export interface BrowserFindResult {
  count: number;
  /** 1-based position of the current match; 0 when there are none. */
  index: number;
}

const FIND_RUNTIME = `
(function () {
  var s = window.__argmaxFind;
  if (!s) {
    s = window.__argmaxFind = { marks: [], index: -1, lastQuery: null };
    var style = document.createElement("style");
    style.textContent = "argmax-find-hl{background:#ffe066;color:#000;border-radius:2px}argmax-find-hl[data-current]{background:#ff9632;color:#000}";
    (document.head || document.documentElement).appendChild(style);
  }
  var SKIP = "script,style,noscript,template,textarea,select,svg,math,argmax-find-hl";
  function clearAll() {
    for (var i = 0; i < s.marks.length; i++) {
      var m = s.marks[i];
      var p = m.parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    }
    s.marks = [];
    s.index = -1;
    s.lastQuery = null;
  }
  function show(i) {
    for (var j = 0; j < s.marks.length; j++) {
      if (j !== i) s.marks[j].removeAttribute("data-current");
    }
    var m = s.marks[i];
    if (!m) return;
    m.setAttribute("data-current", "");
    m.scrollIntoView({ block: "center" });
  }
  function wrapNode(node, lower) {
    var text = node.nodeValue;
    var t = text.toLowerCase();
    var frag = document.createDocumentFragment();
    var pos = 0;
    var at = t.indexOf(lower, pos);
    while (at !== -1) {
      if (at > pos) frag.appendChild(document.createTextNode(text.slice(pos, at)));
      var mark = document.createElement("argmax-find-hl");
      mark.textContent = text.slice(at, at + lower.length);
      frag.appendChild(mark);
      s.marks.push(mark);
      pos = at + lower.length;
      at = t.indexOf(lower, pos);
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
  function search(q) {
    clearAll();
    if (!q || !document.body) return { count: 0, index: 0 };
    var lower = q.toLowerCase();
    var walker = document.createTreeWalker(document.body, 4, {
      acceptNode: function (n) {
        var v = n.nodeValue;
        if (!v || v.toLowerCase().indexOf(lower) === -1) return 2;
        var p = n.parentElement;
        if (!p || p.closest(SKIP)) return 2;
        return 1;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) wrapNode(nodes[i], lower);
    s.lastQuery = q;
    if (s.marks.length) {
      s.index = 0;
      show(0);
      return { count: s.marks.length, index: 1 };
    }
    return { count: 0, index: 0 };
  }
  function step(delta, q) {
    if (s.lastQuery !== q) return search(q);
    var n = s.marks.length;
    if (!n) return { count: 0, index: 0 };
    s.index = (s.index + delta + n) % n;
    show(s.index);
    return { count: n, index: s.index + 1 };
  }
  s.clear = clearAll;
  s.search = search;
  s.step = step;
})();
`;

/** A full script for `browser:evaluate`: install the runtime, run one action. */
export function browserFindScript(
  action: "search" | "step" | "clear",
  query = "",
  delta = 0
): string {
  const runtime = FIND_RUNTIME;
  if (action === "search") {
    return `${runtime};window.__argmaxFind.search(${JSON.stringify(query)});`;
  }
  if (action === "step") {
    return `${runtime};window.__argmaxFind.step(${delta}, ${JSON.stringify(query)});`;
  }
  return `${runtime};window.__argmaxFind.clear();`;
}

/** `resultJson` is empty when the script returned undefined — or threw. */
export function parseFindResult(resultJson: string): BrowserFindResult {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as BrowserFindResult).count === "number" &&
      typeof (parsed as BrowserFindResult).index === "number"
    ) {
      return parsed as BrowserFindResult;
    }
  } catch {
    // Fall through to the empty result.
  }
  return { count: 0, index: 0 };
}
