/* ─────────────────────────────────────────────────────────────────────────
   CrossFeed.tv overlay client
   Connects to the backend fan-out socket and renders the merged chat feed.
   Vanilla JS, no build step. Configure entirely via query params:

     overlay.html?twitch=xqc&kick=xqc&x=<broadcastId>

   Optional params:
     server=ws://host:port   override the backend (default: same origin)
     size=20                 base font size in px (default 18)
     max=200                 max messages kept in the DOM (default 200)
     font=Arial              font-family override
     badges=0                hide badges
     status=1                show the per-platform connection HUD
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const PLATFORM_LABELS = { twitch: "Twitch", kick: "Kick", x: "X" };
  const BADGE_LABELS = {
    broadcaster: "HOST",
    moderator: "MOD",
    vip: "VIP",
    subscriber: "SUB",
    founder: "★",
    premium: "PRIME",
    turbo: "TURBO",
    staff: "STAFF",
    admin: "ADMIN",
    global_mod: "GMOD",
    partner: "✔",
    verified: "✔",
  };

  // ── Config from query params ──────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const cfg = {
    twitch: (params.get("twitch") || "").trim(),
    kick: (params.get("kick") || "").trim(),
    x: (params.get("x") || "").trim(),
    server: (params.get("server") || "").trim(),
    size: params.get("size"),
    font: params.get("font"),
    max: clampInt(params.get("max"), 200, 20, 1000),
    showBadges: params.get("badges") !== "0",
    showStatus: params.get("status") === "1",
  };

  applyTheme(cfg);

  const chatEl = document.getElementById("chat");
  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");
  const statusDots = {};
  let firstMessageSeen = false;

  if (cfg.showStatus) statusEl.classList.remove("hidden");
  maybeShowHint();

  // ── WebSocket connection with auto-reconnect ──────────────────────────────
  const wsUrl = buildWsUrl(cfg);
  let ws = null;
  let backoff = 1000;

  function connect() {
    setStatus("ws", "connecting");
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = function () {
      backoff = 1000;
      setStatus("ws", "connected");
    };
    ws.onmessage = function (ev) {
      handleFrame(ev.data);
    };
    ws.onclose = function () {
      setStatus("ws", "reconnecting");
      scheduleReconnect();
    };
    ws.onerror = function () {
      try {
        ws.close();
      } catch (e) {}
    };
  }

  function scheduleReconnect() {
    setTimeout(connect, backoff);
    backoff = Math.min(Math.round(backoff * 1.8), 15000);
  }

  function handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (frame.type === "chat") {
      enqueue(frame.msg);
    } else if (frame.type === "status") {
      setStatus(frame.platform, frame.state);
    }
  }

  // ── Render queue: batch DOM writes per animation frame to absorb bursts ───
  const queue = [];
  let scheduled = false;

  function enqueue(msg) {
    if (!firstMessageSeen) {
      firstMessageSeen = true;
      hintEl.classList.add("hidden");
    }
    queue.push(msg);
    schedule();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  }

  function flush() {
    scheduled = false;
    if (!queue.length) return;
    const frag = document.createDocumentFragment();
    // Process a bounded batch per frame; reschedule if more remain.
    const batch = queue.splice(0, 100);
    for (let i = 0; i < batch.length; i++) {
      frag.appendChild(renderMessage(batch[i]));
    }
    chatEl.appendChild(frag);
    trim();
    if (queue.length) schedule();
  }

  function trim() {
    // The flex-end + overflow:hidden container already scrolls old messages off
    // the top visually; this caps the DOM so memory stays bounded.
    while (chatEl.childElementCount > cfg.max) {
      chatEl.removeChild(chatEl.firstElementChild);
    }
  }

  // ── Message rendering (XSS-safe: text via textContent, never innerHTML) ───
  function renderMessage(msg) {
    const row = document.createElement("div");
    row.className = "msg " + safeClass(msg.platform);

    const pill = document.createElement("span");
    pill.className = "pill " + safeClass(msg.platform);
    pill.textContent = PLATFORM_LABELS[msg.platform] || msg.platform;
    row.appendChild(pill);

    if (cfg.showBadges && Array.isArray(msg.badges)) {
      for (let i = 0; i < msg.badges.length; i++) {
        const name = String(msg.badges[i]);
        const badge = document.createElement("span");
        badge.className = "badge " + safeClass(name);
        badge.textContent = BADGE_LABELS[name] || name.slice(0, 3).toUpperCase();
        badge.title = name;
        row.appendChild(badge);
      }
    }

    const author = document.createElement("span");
    author.className = "author";
    author.style.color = safeColor(msg.color);
    author.textContent = msg.author;
    row.appendChild(author);

    const colon = document.createElement("span");
    colon.className = "colon";
    colon.textContent = ":";
    row.appendChild(colon);

    const text = document.createElement("span");
    text.className = "text";
    renderText(text, msg.text, msg.emotes);
    row.appendChild(text);

    return row;
  }

  // Replace whole-token emote codes with <img>; everything else stays text.
  function renderText(container, text, emotes) {
    const map = new Map();
    if (Array.isArray(emotes)) {
      for (let i = 0; i < emotes.length; i++) {
        const e = emotes[i];
        if (e && e.code && e.url) map.set(e.code, e.url);
      }
    }
    const tokens = String(text == null ? "" : text).split(" ");
    for (let i = 0; i < tokens.length; i++) {
      if (i > 0) container.appendChild(document.createTextNode(" "));
      const tok = tokens[i];
      const url = map.get(tok);
      if (url) {
        const img = document.createElement("img");
        img.className = "emote";
        img.src = url;
        img.alt = tok;
        img.title = tok;
        img.loading = "lazy";
        img.onerror = function () {
          img.replaceWith(document.createTextNode(tok));
        };
        container.appendChild(img);
      } else {
        container.appendChild(document.createTextNode(tok));
      }
    }
  }

  // ── Status HUD ────────────────────────────────────────────────────────────
  function setStatus(name, state) {
    if (!cfg.showStatus) return;
    let dot = statusDots[name];
    if (!dot) {
      const chip = document.createElement("span");
      chip.className = "chip";
      dot = document.createElement("span");
      dot.className = "dot";
      const label = document.createElement("span");
      label.textContent = name === "ws" ? "feed" : name;
      chip.appendChild(dot);
      chip.appendChild(label);
      statusEl.appendChild(chip);
      statusDots[name] = dot;
    }
    dot.className = "dot " + safeClass(state);
    dot.title = name + ": " + state;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function buildWsUrl(cfg) {
    let base = cfg.server;
    if (base) {
      base = base.replace(/^http/i, "ws");
    } else {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const host = location.host || "localhost:8080";
      base = proto + "//" + host;
    }
    base = base.replace(/\/+$/, "");
    const q = new URLSearchParams();
    if (cfg.twitch) q.set("twitch", cfg.twitch);
    if (cfg.kick) q.set("kick", cfg.kick);
    if (cfg.x) q.set("x", cfg.x);
    return base + "/feed?" + q.toString();
  }

  function applyTheme(cfg) {
    const root = document.documentElement;
    const size = clampInt(cfg.size, 0, 8, 96);
    if (size) root.style.setProperty("--font-size", size + "px");
    if (cfg.font) root.style.setProperty("--font-family", cfg.font);
  }

  function maybeShowHint() {
    if (cfg.twitch || cfg.kick || cfg.x) return;
    hintEl.innerHTML =
      '<div class="card"><h1>CrossFeed.tv overlay</h1>' +
      "<div>No channels configured. Add them as query params:</div>" +
      "<div style=\"margin-top:10px\"><code>?twitch=xqc&amp;kick=xqc&amp;x=&lt;broadcastId&gt;</code></div>" +
      '<div class="muted">This hint disappears once messages arrive and is never shown when a channel is set.</div></div>';
    hintEl.classList.remove("hidden");
  }

  function safeColor(color) {
    if (typeof color === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
      return color;
    }
    return "#ffffff";
  }

  function safeClass(value) {
    return String(value || "").replace(/[^a-z0-9_-]/gi, "");
  }

  function clampInt(value, fallback, min, max) {
    const n = parseInt(value, 10);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Go.
  connect();
})();
