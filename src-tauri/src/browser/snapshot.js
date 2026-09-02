// Accessibility snapshot of the page an agent is looking at.
//
// Injected into a browser tab by `browser::automation`; installs
// `window.__argmax` with the read side (snapshot / find / getText / rect).
// `actions.js` extends the same object with the write side.
//
// The output is a Playwright-shaped aria tree: one indented line per node,
// interactive nodes carrying a `[ref=eN]` handle the agent then clicks or
// types into. Refs live in the DOM (`data-argmax-ref`) rather than in a table
// here, so they stay valid for as long as the element does — a re-snapshot
// after the page mutates reuses the attribute the node already carries, and
// only genuinely new elements get new numbers.
(function () {
  var REF_ATTR = "data-argmax-ref";
  var MAX_NODES = 800;
  var MAX_BYTES = 40 * 1024;
  var MAX_TEXT = 120;
  var MAX_FIND = 20;

  var INTERACTIVE_SELECTOR =
    "a[href], button, input, select, textarea, summary, [role], [contenteditable], [tabindex]";

  var LANDMARK_ROLES = {
    NAV: "navigation",
    MAIN: "main",
    HEADER: "banner",
    FOOTER: "contentinfo",
    ASIDE: "complementary",
    FORM: "form",
    SEARCH: "search"
  };

  var INPUT_ROLES = {
    checkbox: "checkbox",
    radio: "radio",
    button: "button",
    submit: "button",
    reset: "button",
    image: "button",
    range: "slider",
    file: "button"
  };

  // Highest ref already in the document, so a re-injection after a soft
  // navigation keeps numbering forward instead of colliding with live nodes.
  var refCounter = 0;
  (function () {
    var existing = document.querySelectorAll("[" + REF_ATTR + "]");
    for (var i = 0; i < existing.length; i += 1) {
      var match = /^e(\d+)$/.exec(existing[i].getAttribute(REF_ATTR) || "");
      if (match) refCounter = Math.max(refCounter, Number(match[1]));
    }
  })();

  function refFor(element) {
    var existing = element.getAttribute(REF_ATTR);
    if (existing) return existing;
    refCounter += 1;
    var ref = "e" + refCounter;
    element.setAttribute(REF_ATTR, ref);
    return ref;
  }

  function byRef(ref) {
    if (typeof ref !== "string" || !/^e\d+$/.test(ref)) return null;
    return document.querySelector("[" + REF_ATTR + '="' + ref + '"]');
  }

  function normalize(text) {
    return String(text == null ? "" : text)
      .replace(/\s+/g, " ")
      .trim();
  }

  function truncate(text, limit) {
    var value = normalize(text);
    return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
  }

  // display:none, visibility:hidden and aria-hidden all inherit, so a node
  // failing here takes its subtree with it. A zero-sized box does not:
  // wrappers collapse around absolutely positioned children all the time.
  function isVisible(element) {
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.hasAttribute("hidden")) return false;
    if (typeof element.checkVisibility === "function") return element.checkVisibility();
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function hasBox(element) {
    var rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function matchesInteractive(element) {
    return element.matches && element.matches(INTERACTIVE_SELECTOR);
  }

  function roleOf(element) {
    var explicit = element.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    var tag = element.tagName;
    if (tag === "A") return element.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return element.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "IMG") return "image";
    if (tag === "INPUT") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[type] || (type === "search" ? "searchbox" : "textbox");
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (LANDMARK_ROLES[tag]) return LANDMARK_ROLES[tag];
    if (element.isContentEditable) return "textbox";
    if (element.hasAttribute("tabindex")) return "generic";
    return null;
  }

  function labelledByText(element) {
    var ids = (element.getAttribute("aria-labelledby") || "").trim();
    if (!ids) return "";
    var parts = [];
    ids.split(/\s+/).forEach(function (id) {
      var node = document.getElementById(id);
      if (node) parts.push(node.textContent || "");
    });
    return parts.join(" ");
  }

  function nameOf(element) {
    var candidates = [
      element.getAttribute("aria-label"),
      labelledByText(element),
      element.tagName === "IMG" ? element.getAttribute("alt") : null,
      element.getAttribute("title")
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = truncate(candidates[i], MAX_TEXT);
      if (candidate) return candidate;
    }
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      var labelled = element.labels && element.labels.length ? element.labels[0].textContent : "";
      var placeholder = element.getAttribute("placeholder") || element.getAttribute("name") || "";
      return truncate(labelled || placeholder, MAX_TEXT);
    }
    if (element.tagName === "SELECT") {
      var selectLabel = element.labels && element.labels.length ? element.labels[0].textContent : "";
      return truncate(selectLabel || element.getAttribute("name") || "", MAX_TEXT);
    }
    // Text is only a name when it is short enough to *be* a label. A landmark
    // holding the whole page would otherwise take the page's text as its name,
    // and the dedupe below would then swallow the entire subtree.
    var own = normalize(element.textContent);
    return own.length <= MAX_TEXT ? own : "";
  }

  function valueOf(element) {
    if (element.tagName === "INPUT") {
      var type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") return element.checked ? "checked" : "";
      if (type === "password") return element.value ? "•••" : "";
      return truncate(element.value, MAX_TEXT);
    }
    if (element.tagName === "TEXTAREA") return truncate(element.value, MAX_TEXT);
    if (element.tagName === "SELECT") {
      var option = element.selectedOptions && element.selectedOptions[0];
      return truncate(option ? option.textContent : "", MAX_TEXT);
    }
    return "";
  }

  /**
   * One pass over the visible DOM producing snapshot entries. Text nodes come
   * through as `{ kind: "text" }`; every element that earns a line comes
   * through as `{ kind: "element" }` with its role, name and depth.
   */
  function collect(options) {
    var interactiveOnly = !!(options && options.interactiveOnly);
    var limit = options && options.limit ? options.limit : MAX_NODES;
    var entries = [];
    var truncated = false;

    function walk(node, depth) {
      if (truncated) return;
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        if (interactiveOnly) return;
        // Text belongs to its parent's box: a collapsed element's label is as
        // invisible as the element, even though the text node has no rect of
        // its own to test.
        var host = node.parentElement;
        if (host && !hasBox(host)) return;
        var text = truncate(node.nodeValue, MAX_TEXT);
        if (text) entries.push({ kind: "text", text: text, depth: depth });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      var tag = node.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") return;
      if (!isVisible(node)) return;

      var role = roleOf(node);
      var interactive = matchesInteractive(node) || tag === "IMG";
      var childDepth = depth;
      // A focusable div has role "generic" and still has to be clickable.
      var keep = role !== null && hasBox(node) && (role !== "generic" || interactive);
      if (keep && tag === "IMG" && !node.getAttribute("alt")) keep = false;
      if (keep && interactiveOnly && !interactive && role !== "heading") keep = false;

      if (keep) {
        var entry = {
          kind: "element",
          element: node,
          role: role,
          name: nameOf(node),
          value: valueOf(node),
          href: tag === "A" ? node.getAttribute("href") : null,
          level: role === "heading" ? Number(tag.slice(1)) || null : null,
          interactive: interactive,
          depth: depth
        };
        entries.push(entry);
        childDepth = depth + 1;
        if (tag === "A" || tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "INPUT") {
          return;
        }
        // The node's whole text is already its name — a heading, a label, a
        // link-shaped div — so descending would print it twice.
        if (entry.name && entry.name === normalize(node.textContent)) return;
      }
      var children = node.childNodes;
      for (var i = 0; i < children.length; i += 1) walk(children[i], childDepth);
    }

    if (document.body) walk(document.body, 0);
    return { entries: entries, truncated: truncated };
  }

  function formatEntry(entry) {
    var indent = new Array(entry.depth + 1).join("  ");
    if (entry.kind === "text") return indent + "- text: " + entry.text;
    var line = indent + "- " + entry.role;
    if (entry.name) line += ' "' + entry.name + '"';
    if (entry.interactive) line += " [ref=" + refFor(entry.element) + "]";
    if (entry.level) line += " level=" + entry.level;
    if (entry.value) line += ' value="' + entry.value + '"';
    if (entry.href) line += " href=" + truncate(entry.href, MAX_TEXT);
    return line;
  }

  function snapshot(options) {
    var collected = collect(options);
    var lines = ["url: " + location.href, "title: " + truncate(document.title, MAX_TEXT)];
    var bytes = lines[0].length + lines[1].length + 2;
    var truncated = collected.truncated;
    for (var i = 0; i < collected.entries.length; i += 1) {
      var line = formatEntry(collected.entries[i]);
      if (bytes + line.length + 1 > MAX_BYTES) {
        truncated = true;
        break;
      }
      bytes += line.length + 1;
      lines.push(line);
    }
    if (truncated) lines.push("- (truncated)");
    return {
      url: location.href,
      title: document.title,
      tree: lines.join("\n"),
      truncated: truncated
    };
  }

  function find(query) {
    var needle = String(query == null ? "" : query).toLowerCase();
    if (!needle) return { matches: [] };
    var collected = collect({});
    var matches = [];
    for (var i = 0; i < collected.entries.length && matches.length < MAX_FIND; i += 1) {
      var entry = collected.entries[i];
      if (entry.kind !== "element" || !entry.interactive) continue;
      var haystack = [entry.role, entry.name, entry.value, entry.element.textContent]
        .join(" ")
        .toLowerCase();
      if (haystack.indexOf(needle) === -1) continue;
      matches.push({
        ref: refFor(entry.element),
        role: entry.role,
        name: entry.name,
        value: entry.value
      });
    }
    return { matches: matches };
  }

  function getText(maxChars) {
    var limit = typeof maxChars === "number" && maxChars > 0 ? maxChars : 20000;
    var host = document.querySelector("main") || document.querySelector("article") || document.body;
    var text = ((host && host.innerText) || "").replace(/\n{3,}/g, "\n\n").trim();
    var truncated = text.length > limit;
    return {
      url: location.href,
      title: document.title,
      text: truncated ? text.slice(0, limit) : text,
      truncated: truncated
    };
  }

  /** Viewport rect of a ref, for cropping a screenshot to one element. */
  function rect(ref) {
    var element = byRef(ref);
    if (!element) return { error: unknownRef(ref) };
    element.scrollIntoView({ block: "center", inline: "center" });
    var box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return { error: "element " + ref + " has no visible box" };
    return {
      ok: { x: box.left, y: box.top, width: box.width, height: box.height }
    };
  }

  function unknownRef(ref) {
    return (
      "no element for ref " +
      JSON.stringify(ref) +
      " — the page has changed since the snapshot that produced it; take a fresh snapshot"
    );
  }

  window.__argmax = {
    v: 1,
    refAttr: REF_ATTR,
    byRef: byRef,
    refFor: refFor,
    unknownRef: unknownRef,
    truncate: truncate,
    isVisible: isVisible,
    snapshot: snapshot,
    find: find,
    getText: getText,
    rect: rect
  };
})();
