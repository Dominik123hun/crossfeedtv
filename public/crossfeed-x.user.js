// ==UserScript==
// @name         Crossfeed — X broadcast chat bridge
// @namespace    https://crossfeed.tv
// @version      0.1.0
// @description  Scrape your live X broadcast chat from the page and forward it to your Crossfeed overlay. Beta / unofficial.
// @match        https://x.com/i/broadcasts/*
// @match        https://twitter.com/i/broadcasts/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/* ───────────────────────────────────────────────────────────────────────────
   WHAT THIS IS
   X has no official API for broadcast chat. This runs in YOUR already-logged-in
   browser tab, watches the chat with a MutationObserver, and forwards each new
   message to your Crossfeed backend over a WebSocket — which injects it into your
   overlay alongside Twitch + Kick. No credentials leave your browser.

   SETUP (edit the two CONFIG values below):
     1. CROSSFEED  — your Crossfeed origin, e.g. "https://your-app.up.railway.app"
     2. TOKEN      — your overlay token (the token=... in your overlay URL / dashboard)
   Then: install Tampermonkey/Violentmonkey, add this script, open your live
   broadcast at x.com/i/broadcasts/<id>, and keep the tab open while you stream.
   On the server set X_ENABLED=true and X_MODE=ingest, and set your X broadcast id
   in the dashboard.

   SELECTORS: X's DOM is obfuscated and changes. The defaults are best-effort
   heuristics; if nothing shows up, capture the real ones in DevTools (see
   RECON.md → "X DOM-scrape ingest") and fill in SELECTORS below.
   ─────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // ── CONFIG ────────────────────────────────────────────────────────────────
  var CROSSFEED = "https://YOUR-CROSSFEED-HOST"; // <- your Crossfeed origin
  var TOKEN = "YOUR-OVERLAY-TOKEN"; // <- your overlay token

  // TODO(recon): confirm these against the live page (DevTools → Elements).
  var SELECTORS = {
    // The scrolling chat log. Heuristics try aria-label/role first.
    container: '[aria-label*="chat" i], [aria-label*="messages" i], [role="log"]',
    // A single message row inside the container.
    message: '[data-testid*="message" i], li, [role="listitem"]',
    // Username + text within a row (relative). Fallbacks used if empty.
    author: '[data-testid*="user" i], [dir="ltr"] span',
    text: '[data-testid*="text" i], [dir="auto"]',
  };

  if (CROSSFEED.indexOf("YOUR-") === 0 || TOKEN.indexOf("YOUR-") === 0) {
    console.warn("[crossfeed-x] Set CROSSFEED and TOKEN at the top of the userscript first.");
    return;
  }

  // ── WebSocket forwarder (queue + auto-reconnect) ────────────────────────────
  var wsUrl = CROSSFEED.replace(/^http/i, "ws").replace(/\/+$/, "") + "/x-ingest?token=" + encodeURIComponent(TOKEN);
  var ws = null;
  var queue = [];
  var backoff = 1000;

  function connect() {
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      schedule();
      return;
    }
    ws.onopen = function () {
      backoff = 1000;
      console.log("[crossfeed-x] connected to Crossfeed");
      while (queue.length && ws.readyState === 1) ws.send(queue.shift());
    };
    ws.onclose = function () { ws = null; schedule(); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
    ws.onmessage = function (ev) {
      // The server only sends an error frame on a bad token.
      try { var f = JSON.parse(ev.data); if (f && f.error) console.warn("[crossfeed-x]", f.error); } catch (e) {}
    };
  }
  function schedule() {
    setTimeout(connect, backoff);
    backoff = Math.min(Math.round(backoff * 1.8), 15000);
  }
  function send(author, text) {
    var payload = JSON.stringify({ author: author, text: text });
    if (ws && ws.readyState === 1) ws.send(payload);
    else { queue.push(payload); if (queue.length > 200) queue.shift(); }
  }

  // ── Extraction helpers ──────────────────────────────────────────────────────
  function pick(root, sel) {
    if (!sel) return null;
    try { return root.querySelector(sel); } catch (e) { return null; }
  }
  function textOf(node) {
    return (node && (node.innerText || node.textContent) || "").replace(/\s+/g, " ").trim();
  }
  function extract(row) {
    // Preferred: configured selectors.
    var a = pick(row, SELECTORS.author);
    var t = pick(row, SELECTORS.text);
    var author = a ? textOf(a) : "";
    var text = t ? textOf(t) : "";
    // Heuristic fallback: a row usually reads "Name  message…". Split first token
    // off the full text if we couldn't find distinct nodes.
    if (!text) {
      var full = textOf(row);
      if (!full) return null;
      if (author && full.indexOf(author) === 0) text = full.slice(author.length).trim();
      else text = full;
    }
    if (!author) author = "x-viewer";
    if (!text) return null;
    return { author: author.slice(0, 80), text: text.slice(0, 500) };
  }

  var seen = new WeakSet();
  function handleRow(row) {
    if (!row || row.nodeType !== 1 || seen.has(row)) return;
    seen.add(row);
    var msg = extract(row);
    if (msg) send(msg.author, msg.text);
  }

  // ── Find the chat container, then observe it ───────────────────────────────
  function findContainer() {
    var c = pick(document, SELECTORS.container);
    return c || document.body; // fall back to body; we still filter to message rows
  }

  function startObserving(container) {
    // Seed: process any rows already present.
    try {
      container.querySelectorAll(SELECTORS.message).forEach(handleRow);
    } catch (e) {}
    var obs = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          // The added node may BE a message row or CONTAIN message rows.
          if (n.matches && n.matches(SELECTORS.message)) handleRow(n);
          if (n.querySelectorAll) {
            try { n.querySelectorAll(SELECTORS.message).forEach(handleRow); } catch (e) {}
          }
        }
      }
    });
    obs.observe(container, { childList: true, subtree: true });
    console.log("[crossfeed-x] watching chat for", location.pathname);
  }

  connect();
  // The chat mounts asynchronously; poll briefly for the container.
  var tries = 0;
  var iv = setInterval(function () {
    var c = pick(document, SELECTORS.container);
    if (c || ++tries > 40) {
      clearInterval(iv);
      startObserving(c || findContainer());
    }
  }, 500);
})();
