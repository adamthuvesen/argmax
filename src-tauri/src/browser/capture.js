// Console and network capture on a tab an agent drives.
//
// Installed as an *initialization script*, like `dialog.js`, so it is in place
// before the page's first statement runs — the first console error a page logs
// is usually the one worth having — and only on tabs a session opened. A tab
// the user opened is left alone: overriding `console` and `fetch` in a page a
// person is using changes what their devtools show.
//
// This is capture from inside the page, not a debugger attachment. Argmax's
// browser is a WKWebView child of the app with no DevTools Protocol channel,
// so what can be recorded is what the page itself can see: its own console
// calls, its uncaught errors, the requests its scripts make, and the resource
// timings the engine reports. Response bodies, request headers, and requests
// made before this script runs are not observable here, and the tools say so
// rather than implying a debugger's view.
(function () {
  var MAX_ENTRIES = 200;
  var MAX_TEXT = 2000;
  var MAX_ARGS = 10;

  var console_entries = [];
  var network_entries = [];
  var dropped = { console: 0, network: 0 };

  function push(list, kind, entry) {
    list.push(entry);
    if (list.length > MAX_ENTRIES) {
      list.shift();
      dropped[kind] += 1;
    }
  }

  function clip(text) {
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
  }

  function describe(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
      return value.name + ": " + value.message + (value.stack ? "\n" + value.stack : "");
    }
    if (typeof value === "undefined") return "undefined";
    if (value === null) return "null";
    try {
      var json = JSON.stringify(value);
      if (typeof json === "string") return json;
    } catch (error) {}
    try {
      return String(value);
    } catch (error) {
      return "[unserializable]";
    }
  }

  function message(args) {
    var parts = [];
    for (var index = 0; index < args.length && index < MAX_ARGS; index += 1) {
      parts.push(describe(args[index]));
    }
    if (args.length > MAX_ARGS) parts.push("…(" + (args.length - MAX_ARGS) + " more)");
    return clip(parts.join(" "));
  }

  function record_console(level, args) {
    push(console_entries, "console", {
      level: level,
      text: message(args),
      at: new Date().toISOString(),
      url: location.href
    });
  }

  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        record_console(level === "log" ? "log" : level, arguments);
      } catch (error) {}
      // The page keeps its own console: capture is an extra reader, never a
      // replacement, or the user's inspector goes quiet on an agent tab.
      if (original) return original.apply(console, arguments);
    };
  });

  window.addEventListener("error", function (event) {
    try {
      var where = event.filename ? " (" + event.filename + ":" + event.lineno + ")" : "";
      record_console("uncaught", [String(event.message) + where]);
    } catch (error) {}
  });

  window.addEventListener("unhandledrejection", function (event) {
    try {
      record_console("unhandledrejection", [describe(event.reason)]);
    } catch (error) {}
  });

  function record_network(entry) {
    push(network_entries, "network", entry);
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch (error) {
      return String(url);
    }
  }

  var native_fetch = window.fetch;
  if (native_fetch) {
    window.fetch = function (input, init) {
      var started = Date.now();
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var url = absolute(
        typeof input === "string" || input instanceof URL
          ? String(input)
          : (input && input.url) || ""
      );
      var settle = function (status, ok, error) {
        record_network({
          kind: "fetch",
          method: method,
          url: url,
          status: status,
          ok: ok,
          durationMs: Date.now() - started,
          error: error || null,
          at: new Date(started).toISOString()
        });
      };
      return native_fetch.apply(window, arguments).then(
        function (response) {
          settle(response.status, response.ok, null);
          return response;
        },
        function (error) {
          settle(null, false, clip(describe(error)));
          throw error;
        }
      );
    };
  }

  var NativeXhr = window.XMLHttpRequest;
  if (NativeXhr) {
    var open = NativeXhr.prototype.open;
    var send = NativeXhr.prototype.send;
    NativeXhr.prototype.open = function (method, url) {
      this.__argmaxRequest = { method: String(method || "GET").toUpperCase(), url: absolute(url) };
      return open.apply(this, arguments);
    };
    NativeXhr.prototype.send = function () {
      var request = this.__argmaxRequest;
      if (request) {
        var started = Date.now();
        var self = this;
        var settle = function (error) {
          record_network({
            kind: "xhr",
            method: request.method,
            url: request.url,
            status: self.status || null,
            ok: self.status >= 200 && self.status < 400,
            durationMs: Date.now() - started,
            error: error || null,
            at: new Date(started).toISOString()
          });
        };
        this.addEventListener("load", function () {
          settle(null);
        });
        this.addEventListener("error", function () {
          settle("network error");
        });
        this.addEventListener("timeout", function () {
          settle("timeout");
        });
      }
      return send.apply(this, arguments);
    };
  }

  // Everything the page loaded without asking a script to: images, styles,
  // scripts, navigation. No status on most engines, so it is reported as a
  // resource timing rather than dressed up as a response.
  try {
    var observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        try {
          record_network({
            kind: entry.initiatorType || "resource",
            method: null,
            url: absolute(entry.name),
            status: typeof entry.responseStatus === "number" ? entry.responseStatus : null,
            ok: null,
            durationMs: Math.round(entry.duration),
            error: null,
            at: new Date().toISOString()
          });
        } catch (error) {}
      });
    });
    observer.observe({ type: "resource", buffered: true });
  } catch (error) {}

  function read(list, kind, limit, clear) {
    var count = typeof limit === "number" && limit > 0 ? Math.min(limit, MAX_ENTRIES) : 50;
    var entries = list.slice(Math.max(0, list.length - count));
    var truncated = entries.length < list.length || dropped[kind] > 0;
    if (clear) {
      list.length = 0;
      dropped[kind] = 0;
    }
    return { url: location.href, entries: entries, truncated: truncated };
  }

  window.__argmaxCapture = {
    readConsole: function (limit, clear) {
      return read(console_entries, "console", limit, clear);
    },
    readNetwork: function (limit, clear) {
      return read(network_entries, "network", limit, clear);
    }
  };
})();
