// Lets the agent API find this frame. Installed in every frame of an agent
// tab, in Argmax's own isolated content world, so the page cannot see the
// message handler it talks to.
//
// `snapshot.js` in the parent document tags each <iframe> with an id and posts
// `{ __argmaxFrameProbe: { id, nonce } }` into it. This listener answers
// through the `argmaxFrame` handler, and WebKit attaches the sending frame's
// `WKFrameInfo` to the message — which is the only handle Rust can evaluate a
// script in a cross-origin frame with. Rust accepts the answer only with the
// exact nonce the parent posted to this frame, so a frame that relays a made-up
// probe into a child of its own cannot take another frame's id. See
// browser/frames.rs.
(function () {
  if (window === window.top) return;
  var handlers = window.webkit && window.webkit.messageHandlers;
  var handler = handlers && handlers.argmaxFrame;
  if (!handler) return;
  window.addEventListener(
    "message",
    function (event) {
      var data = event.data;
      var probe = data && typeof data === "object" ? data.__argmaxFrameProbe : null;
      if (!probe || typeof probe.id !== "string" || typeof probe.nonce !== "string") return;
      // Only the parent may name this frame. A sibling relaying a probe it
      // intercepted would otherwise claim the parent's id for itself.
      if (event.source !== window.parent) return;
      // The probe is Argmax's, not the page's: keep it out of the page's own
      // message handlers, which may not expect an object they did not send.
      event.stopImmediatePropagation();
      handler.postMessage(
        JSON.stringify({ id: probe.id, nonce: probe.nonce, url: String(location.href) })
      );
    },
    true
  );
})();
