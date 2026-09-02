// Capture `alert` / `confirm` / `prompt` on a tab an agent drives.
//
// Installed as an *initialization script*, so it is in place before the page's
// own code runs — and only on tabs a session opened. A tab the user opened
// keeps the engine's native dialogs, because silently answering a person's
// confirm box would be a lie about what they clicked.
//
// A page's dialog call is synchronous: `confirm()` must return a boolean
// before the next statement runs, and the answer cannot wait for a round trip
// to an agent in another process. So the dialog is answered on the spot — from
// the answer `browser_handle_dialog` armed if there is one, otherwise the
// dismissing default (confirm → false, prompt → null) — and the record stays
// readable for 30 seconds afterwards, so the next snapshot tells the agent a
// dialog happened and what it was answered with.
(function () {
  var TTL_MS = 30000;
  var MAX_MESSAGE = 200;

  var state = {
    /** The most recent dialog, until it ages out. */
    last: null,
    /** Answer armed by `browser_handle_dialog`, consumed by the next dialog. */
    queued: null
  };

  function clip(value) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE - 1) + "…" : text;
  }

  // Fire-and-forget: `on_navigation` intercepts the scheme, logs the dialog and
  // blocks the navigation, so the page never moves.
  function notify(record) {
    try {
      window.location.href =
        "argmax-newtab://dialog?k=" +
        encodeURIComponent(record.kind) +
        "&m=" +
        encodeURIComponent(record.message);
    } catch (error) {}
  }

  function record(kind, message, defaultValue) {
    var queued = state.queued;
    state.queued = null;
    var accepted = queued ? !!queued.accept : false;
    var answer;
    if (kind === "alert") {
      answer = undefined;
    } else if (kind === "confirm") {
      answer = accepted;
    } else {
      answer =
        accepted && queued.promptText != null
          ? String(queued.promptText)
          : accepted
            ? String(defaultValue == null ? "" : defaultValue)
            : null;
    }
    state.last = {
      kind: kind,
      message: clip(message),
      defaultValue: defaultValue == null ? null : clip(defaultValue),
      at: Date.now(),
      armed: !!queued,
      answer: answer === undefined ? null : answer,
      acknowledged: false
    };
    notify(state.last);
    return answer;
  }

  /** The record while it is fresh; null once it has aged out. */
  state.current = function () {
    if (!state.last) return null;
    if (Date.now() - state.last.at > TTL_MS) {
      state.last = null;
      return null;
    }
    return state.last;
  };

  /**
   * Arms the answer the *next* dialog on this page gets, and acknowledges the
   * one that just fired. Answering a dialog already returned to the page is
   * not possible — see the note at the top — so the reply says which happened.
   */
  state.answer = function (accept, promptText) {
    var pending = state.current();
    state.queued = { accept: !!accept, promptText: promptText };
    if (pending) pending.acknowledged = true;
    return {
      ok: true,
      url: location.href,
      armed: true,
      answered: pending
        ? {
            kind: pending.kind,
            message: pending.message,
            autoAnswer: pending.answer,
            wasArmed: pending.armed
          }
        : null
    };
  };

  window.alert = function (message) {
    record("alert", message);
  };
  window.confirm = function (message) {
    return record("confirm", message);
  };
  window.prompt = function (message, defaultValue) {
    return record("prompt", message, defaultValue);
  };
  window.__argmaxDialog = state;
})();
