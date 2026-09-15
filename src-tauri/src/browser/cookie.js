// Dismiss cookie / consent banners on a tab an agent drives.
//
// Installed as an initialization script on every frame of session-owned tabs,
// so it is in place before the page paints a CMP. Tabs the user opened are
// left alone. Localhost and loopback are skipped so a first-party banner an
// agent is testing still shows.
//
// Prefer a known CMP accept control, then an accept-all (or reject-all)
// button inside a cookie-shaped dialog. One click per load. Leftover banners
// still surface as `state: cookie` on a snapshot.
(function () {
  if (window.__argmaxCookies) return;

  var MAX_MS = 15000;
  var started = Date.now();
  var clicked = false;
  var observer = null;
  var timer = null;

  var ACCEPT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "#accept-recommended-btn-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "#didomi-notice-agree-button",
    "#sp-cc-accept",
    "button[id='onetrust-accept-btn-handler']",
    "[data-testid='cookie-accept']"
  ];

  var REJECT_SELECTORS = [
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyButtonDecline",
    "#didomi-notice-disagree-button",
    "[data-testid='cookie-reject']"
  ];

  var COOKIE_ROOT =
    "#onetrust-banner-sdk, #onetrust-consent-sdk, #CybotCookiebotDialog, #didomi-host, #qc-cmp2-container, #sp-cc, [id*='cookie'], [class*='cookie'], [id*='consent'], [class*='consent'], [aria-label*='cookie'], [aria-modal='true'], [role='dialog'], [role='alertdialog']";

  var ACCEPT_NAME =
    /accept all|allow all|agree to all|godkänn alla|acceptera alla|tillåt alla|alle akzeptieren|alles akzeptieren|tout accepter|accepter tout|aceptar todo|aceptar todas|accetta tutto|aceitar todos|alles accepteren|zaakceptuj wszystkie|hyväksy kaikki|godta alle|accepter alle/i;
  var REJECT_NAME =
    /reject all|decline all|refuse all|necessary only|essential only|reject cookies|avvisa alla|avvis alle|nur notwendige|nur essenzielle|tout refuser|refuser tout|rechazar todo|rifiuta tutto|rejeitar todos|alles weigeren/i;
  var ACCEPT_SHORT = /^(accept|allow|agree|godkänn|acceptera|akzeptieren|accepter|aceptar|accetta|aceitar|godta)$/i;
  var COOKIE_HINT = /cookies?|consent|gdpr|integritet|personuppgift/i;

  function hostIsLocal() {
    if (state && state.allowLocal) return false;
    var host = String(location.hostname || "").replace(/\.$/, "").toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    );
  }

  function visible(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if (element.hasAttribute("hidden") || element.disabled) return false;
    if (typeof element.checkVisibility === "function") return element.checkVisibility();
    var style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
  }

  function nameOf(element) {
    var labelled = "";
    var ids = (element.getAttribute("aria-labelledby") || "").trim();
    if (ids) {
      ids.split(/\s+/).forEach(function (id) {
        var node = document.getElementById(id);
        if (node) labelled += " " + (node.textContent || "");
      });
    }
    return String(
      element.getAttribute("aria-label") ||
        labelled ||
        element.value ||
        element.textContent ||
        ""
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  function isButton(element) {
    if (!element || element.nodeType !== 1) return false;
    var tag = element.tagName;
    if (tag === "BUTTON") return true;
    if (tag === "INPUT") {
      var type = (element.getAttribute("type") || "submit").toLowerCase();
      return type === "button" || type === "submit";
    }
    var role = (element.getAttribute("role") || "").toLowerCase();
    return role === "button";
  }

  function kindOf(element) {
    var name = nameOf(element);
    if (!name) return null;
    if (REJECT_NAME.test(name)) return "reject";
    if (ACCEPT_NAME.test(name)) return "accept";
    if (ACCEPT_SHORT.test(name)) return "accept";
    return null;
  }

  function firstMatch(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      var node = document.querySelector(selectors[i]);
      if (visible(node) && isButton(node)) return node;
    }
    return null;
  }

  function cookieRoot(element) {
    if (!element || typeof element.closest !== "function") return null;
    return element.closest(COOKIE_ROOT);
  }

  function looksLikeCookie(root) {
    if (!root || !visible(root)) return false;
    var text = String(root.innerText || root.textContent || "");
    if (COOKIE_HINT.test(text)) return true;
    var idClass = String((root.id || "") + " " + (root.className || ""));
    return /cookie|consent|gdpr|onetrust|cookiebot|didomi/i.test(idClass);
  }

  function pickIn(root) {
    var accept = null;
    var reject = null;
    var candidates = root.querySelectorAll("button, input[type='button'], input[type='submit'], [role='button']");
    for (var i = 0; i < candidates.length; i += 1) {
      var button = candidates[i];
      if (!visible(button) || !isButton(button)) continue;
      var kind = kindOf(button);
      if (kind === "accept" && !accept) accept = button;
      if (kind === "reject" && !reject) reject = button;
    }
    return accept || reject;
  }

  function click(element) {
    if (!element || clicked) return false;
    clicked = true;
    try {
      element.click();
      state.dismissed = true;
      state.target = nameOf(element) || element.id || element.tagName.toLowerCase();
      stop();
      return true;
    } catch (error) {
      clicked = false;
      return false;
    }
  }

  function scan() {
    if (clicked || hostIsLocal()) return false;
    if (Date.now() - started > MAX_MS) {
      stop();
      return false;
    }
    try {
      var known = firstMatch(ACCEPT_SELECTORS) || firstMatch(REJECT_SELECTORS);
      if (known) return click(known);
      var roots = document.querySelectorAll(COOKIE_ROOT);
      for (var i = 0; i < roots.length; i += 1) {
        if (!looksLikeCookie(roots[i])) continue;
        var button = pickIn(roots[i]);
        if (button) return click(button);
      }
    } catch (error) {}
    return false;
  }

  function stop() {
    if (observer) observer.disconnect();
    observer = null;
    if (timer) clearInterval(timer);
    timer = null;
  }

  var state = {
    dismissed: false,
    target: null,
    allowLocal: false,
    scan: scan
  };
  window.__argmaxCookies = state;

  if (hostIsLocal()) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  scan();
  if (clicked) return;
  if (typeof MutationObserver === "function" && document.documentElement) {
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  timer = setInterval(scan, 400);
  setTimeout(stop, MAX_MS);
})();
