// The write side of the injected agent API: click, type, and the rest, all
// addressed by the `[ref=eN]` handles `snapshot.js` hands out.
//
// Every entry point answers with an envelope — `{ ok: … }` or
// `{ error: "…" }` — because WebKit's evaluate callback drops thrown errors
// (see browser/eval.rs) and a silent `undefined` is indistinguishable from a
// silent failure. A ref that no longer resolves says so in words, since the
// only fix is a fresh snapshot.
//
// `waitFor` is start-and-poll rather than a promise: `evaluateJavaScript:`
// never awaits one, so the page installs a MutationObserver, records the
// outcome, and Rust polls the record until its own deadline expires.
(function () {
  var api = window.__argmax;
  var WAIT_TTL_MS = 120000;

  function resolve(ref) {
    var element = api.byRef(ref);
    if (!element) return { error: api.unknownRef(ref) };
    return { element: element };
  }

  function centre(element) {
    var box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  function pointerEvent(type, element, point) {
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: type === "mousedown" || type === "pointerdown" ? 1 : 0
    };
    var event =
      typeof PointerEvent === "function" && type.indexOf("pointer") === 0
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init);
    element.dispatchEvent(event);
  }

  function describe(element) {
    var role = element.tagName.toLowerCase();
    var name = api.truncate(element.getAttribute("aria-label") || element.textContent || "", 60);
    return name ? role + ' "' + name + '"' : role;
  }

  function done(extra) {
    var result = { ok: true, url: location.href };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) result[key] = extra[key];
      }
    }
    return result;
  }

  function click(ref) {
    var found = resolve(ref);
    if (found.error) return found;
    var element = found.element;
    element.scrollIntoView({ block: "center", inline: "center" });
    var point = centre(element);
    // Hover first: menus that only render their items on pointerover need it,
    // and a real pointer always passes over before it presses.
    pointerEvent("pointerover", element, point);
    pointerEvent("mouseover", element, point);
    pointerEvent("pointerdown", element, point);
    pointerEvent("mousedown", element, point);
    if (typeof element.focus === "function") element.focus();
    pointerEvent("pointerup", element, point);
    pointerEvent("mouseup", element, point);
    // `.click()` rather than a dispatched click: it runs the default action
    // (following a link, submitting a form), which a synthetic event does not.
    element.click();
    return done({ target: describe(element) });
  }

  /** React and Vue track the value through the prototype setter; assigning
   *  `element.value` directly leaves their state stale and the field reverts. */
  function setNativeValue(element, value) {
    var prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function pressOn(element, key, modifiers) {
    var mods = modifiers || [];
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: key,
      code: key.length === 1 ? "Key" + key.toUpperCase() : key,
      altKey: mods.indexOf("Alt") !== -1,
      ctrlKey: mods.indexOf("Control") !== -1,
      metaKey: mods.indexOf("Meta") !== -1,
      shiftKey: mods.indexOf("Shift") !== -1
    };
    var down = new KeyboardEvent("keydown", init);
    var prevented = !element.dispatchEvent(down);
    element.dispatchEvent(new KeyboardEvent("keypress", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
    return prevented;
  }

  function submitFrom(element) {
    var form = element.form || (element.closest ? element.closest("form") : null);
    if (!form) return false;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
    return true;
  }

  function typeText(ref, text, options) {
    var found = resolve(ref);
    if (found.error) return found;
    var element = found.element;
    var value = String(text == null ? "" : text);
    element.scrollIntoView({ block: "center", inline: "center" });
    if (typeof element.focus === "function") element.focus();

    if (element.isContentEditable) {
      element.textContent = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      setNativeValue(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { error: describe(element) + " is not a text field" };
    }

    if (!(options && options.submit)) return done({ target: describe(element) });
    // Enter first, because a scripted search box usually listens for it; the
    // form fallback covers the plain HTML case where nothing did.
    var prevented = pressOn(element, "Enter", []);
    var submitted = prevented ? true : submitFrom(element);
    return done({ target: describe(element), submitted: submitted || prevented });
  }

  function select(ref, value) {
    var found = resolve(ref);
    if (found.error) return found;
    var element = found.element;
    if (!(element instanceof HTMLSelectElement)) return { error: describe(element) + " is not a select" };
    var wanted = String(value == null ? "" : value);
    var options = element.options;
    for (var i = 0; i < options.length; i += 1) {
      var option = options[i];
      if (option.value === wanted || (option.textContent || "").trim() === wanted) {
        element.selectedIndex = i;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return done({ selected: option.value });
      }
    }
    return { error: "no option matching " + JSON.stringify(wanted) + " in " + describe(element) };
  }

  function hover(ref) {
    var found = resolve(ref);
    if (found.error) return found;
    var element = found.element;
    element.scrollIntoView({ block: "center", inline: "center" });
    var point = centre(element);
    pointerEvent("pointerover", element, point);
    pointerEvent("mouseover", element, point);
    pointerEvent("pointermove", element, point);
    pointerEvent("mousemove", element, point);
    return done({ target: describe(element) });
  }

  function pressKey(key, modifiers) {
    if (typeof key !== "string" || !key) return { error: "pressKey needs a key name" };
    var element = document.activeElement || document.body;
    if (!element) return { error: "the page has no focused element to type into" };
    var prevented = pressOn(element, key, modifiers);
    if (key === "Enter" && !prevented) submitFrom(element);
    return done({ target: describe(element) });
  }

  function scroll(spec) {
    var options = spec || {};
    var amount = typeof options.amount === "number" && options.amount > 0 ? options.amount : null;
    var target = null;
    if (options.ref) {
      var found = resolve(options.ref);
      if (found.error) return found;
      target = found.element;
    }
    var box = target
      ? { width: target.clientWidth, height: target.clientHeight }
      : { width: window.innerWidth, height: window.innerHeight };
    var step = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] }[options.direction];
    if (!step) return { error: 'scroll direction must be one of up, down, left, right' };
    var dx = step[0] * (amount || box.width * 0.8);
    var dy = step[1] * (amount || box.height * 0.8);
    if (target) target.scrollBy(dx, dy);
    else window.scrollBy(dx, dy);
    return done({
      scrollY: target ? target.scrollTop : window.scrollY,
      scrollX: target ? target.scrollLeft : window.scrollX
    });
  }

  // --- waitFor -------------------------------------------------------------

  var waits = {};

  function satisfied(spec) {
    if (spec.urlIncludes && location.href.toLowerCase().indexOf(String(spec.urlIncludes).toLowerCase()) === -1) {
      return false;
    }
    if (spec.ref) {
      var element = api.byRef(spec.ref);
      if (!element || !api.isVisible(element)) return false;
    }
    if (spec.text) {
      var body = document.body;
      var haystack = ((body && body.innerText) || "").toLowerCase();
      if (haystack.indexOf(String(spec.text).toLowerCase()) === -1) return false;
    }
    return true;
  }

  function stop(entry) {
    if (entry.observer) entry.observer.disconnect();
    if (entry.timer) clearInterval(entry.timer);
    entry.observer = null;
    entry.timer = null;
  }

  /**
   * Idempotent by `id`: the first call arms the watcher, later calls read it.
   * A navigation wipes this whole object, so an unknown id simply re-arms —
   * which is exactly right for "wait until the URL becomes …".
   */
  function waitFor(id, spec) {
    if (!spec || (!spec.text && !spec.ref && !spec.urlIncludes)) {
      return { error: "waitFor needs one of text, ref or urlIncludes" };
    }
    var entry = waits[id];
    if (!entry) {
      entry = waits[id] = {
        done: false,
        result: null,
        observer: null,
        timer: null,
        started: Date.now(),
        settle: null
      };
      var settle = function () {
        // The observer can fire while the document is being torn down by a
        // navigation, and a throw there would surface as an uncaught page
        // error. A wait that can no longer read its document is over.
        try {
          if (entry.done || !satisfied(spec)) return;
          entry.done = true;
          entry.result = done({ matched: true });
        } catch (error) {
          entry.done = true;
          entry.result = { error: String(error) };
        }
        stop(entry);
      };
      entry.settle = settle;
      if (typeof MutationObserver === "function") {
        entry.observer = new MutationObserver(settle);
        entry.observer.observe(document.documentElement || document, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true
        });
      }
      // Polling as well as observing: a URL change or a canvas repaint moves
      // nothing in the DOM the observer watches.
      entry.timer = setInterval(function () {
        if (Date.now() - entry.started > WAIT_TTL_MS) {
          stop(entry);
          delete waits[id];
          return;
        }
        settle();
      }, 100);
      settle();
    }
    // Re-check on every poll, not only from the observer: a URL change moves
    // nothing in the DOM, and a mutation callback is a microtask that may not
    // have run since the last poll.
    if (entry.settle) entry.settle();
    if (!entry.done) return { pending: true, url: location.href };
    stop(entry);
    delete waits[id];
    return entry.result;
  }

  // --- dialogs -------------------------------------------------------------

  /**
   * Arms the answer for this tab's next `alert`/`confirm`/`prompt`, and
   * acknowledges the one that just fired. The recorder lives in `dialog.js`,
   * an initialization script installed only on tabs a session opened — a tab
   * the user opened keeps the engine's native dialogs.
   */
  function handleDialog(accept, promptText) {
    var capture = window.__argmaxDialog;
    if (!capture || typeof capture.answer !== "function") {
      return {
        error:
          "this tab does not capture dialogs — only tabs a session opened do; open the page with browser_open"
      };
    }
    return capture.answer(accept, promptText);
  }

  api.handleDialog = handleDialog;
  api.click = click;
  api.type = typeText;
  api.select = select;
  api.hover = hover;
  api.pressKey = pressKey;
  api.scroll = scroll;
  api.waitFor = waitFor;
})();
