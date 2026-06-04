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
     thirdparty=0            disable 7TV/BTTV/FFZ global emotes (Twitch)
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const PLATFORM_LABELS = { twitch: "Twitch", kick: "Kick", x: "X" };

  // Inline brand glyphs for the source pills (trusted constants, not user data).
  const PLATFORM_LOGOS = {
    twitch:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.3 0 1 3.3v13.4h4.6V20l3.3-3.3h2.7L17.7 11V0H4.3zm12 10.3-2.7 2.7H11l-2.3 2.3v-2.3H5.6V1.3h10.7v9z"/><path d="M14.7 3.7h-1.4v4h1.4v-4zm-3.7 0H9.6v4H11v-4z"/></svg>',
    kick:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2h5.5v6.5L13 2h6.5l-6 8 6 8H13L8.5 11.5V18H3z"/></svg>',
    x:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z"/></svg>',
  };
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
    token: (params.get("token") || "").trim(),
    twitch: (params.get("twitch") || "").trim(),
    kick: (params.get("kick") || "").trim(),
    x: (params.get("x") || "").trim(),
    server: (params.get("server") || "").trim(),
    size: params.get("size"),
    font: params.get("font"),
    max: clampInt(params.get("max"), 200, 20, 1000),
    showBadges: params.get("badges") !== "0",
    showStatus: params.get("status") === "1",
    thirdParty: params.get("thirdparty") !== "0",
  };

  applyTheme(cfg);

  const chatEl = document.getElementById("chat");
  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");
  const statusDots = {};
  let firstMessageSeen = false;

  if (cfg.showStatus) statusEl.classList.remove("hidden");
  maybeShowHint();

  // ── Global emote registry (extensible: 7TV / BTTV / FFZ / …) ──────────────
  // code -> url. Message-level emotes always take priority over these.
  const globalEmotes = new Map();

  // Each provider is a {url, parse} pair; add channel-scoped sets here later by
  // pushing more providers (they only need to populate `globalEmotes`).
  function loadThirdPartyEmotes() {
    if (!cfg.thirdParty) return;
    const providers = [
      {
        url: "https://api.betterttv.net/3/cached/emotes/global",
        parse: (data) => {
          (data || []).forEach((e) => {
            if (e && e.code && e.id)
              globalEmotes.set(e.code, "https://cdn.betterttv.net/emote/" + e.id + "/2x.webp");
          });
        },
      },
      {
        url: "https://api.frankerfacez.com/v1/set/global",
        parse: (data) => {
          const sets = (data && data.sets) || {};
          Object.keys(sets).forEach((k) => {
            (sets[k].emoticons || []).forEach((e) => {
              const u = e.urls && (e.urls["2"] || e.urls["1"]);
              if (e.name && u) globalEmotes.set(e.name, u.indexOf("http") === 0 ? u : "https:" + u);
            });
          });
        },
      },
      {
        url: "https://7tv.io/v3/emote-sets/global",
        parse: (data) => {
          ((data && data.emotes) || []).forEach((e) => {
            if (e && e.name && e.id)
              globalEmotes.set(e.name, "https://cdn.7tv.app/emote/" + e.id + "/2x.webp");
          });
        },
      },
    ];
    providers.forEach((p) => {
      fetch(p.url)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => p.parse(d))
        .catch(() => {
          /* enhancement only — message-level emotes still render */
        });
    });
  }
  loadThirdPartyEmotes();

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
    // Connect watchdog: browsers don't time out a hanging WS connect.
    let opened = false;
    const watchdog = setTimeout(function () {
      if (!opened) {
        try {
          ws.close();
        } catch (e) {}
      }
    }, 10000);
    ws.onopen = function () {
      opened = true;
      clearTimeout(watchdog);
      backoff = 1000;
      setStatus("ws", "connected");
    };
    ws.onmessage = function (ev) {
      handleFrame(ev.data);
    };
    ws.onclose = function () {
      clearTimeout(watchdog);
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
      setStatus(frame.platform, frame.state, frame.detail);
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
    // Bound memory if rAF is throttled (e.g. hidden tab) during a heavy burst:
    // only the most recent messages can ever be on screen anyway.
    const cap = cfg.max * 4;
    if (queue.length > cap) queue.splice(0, queue.length - cap);
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
    row.className = "msg " + safeClass(msg.platform) + (msg.test ? " is-test" : "");

    const pill = document.createElement("span");
    pill.className = "pill " + safeClass(msg.platform);
    const logo = PLATFORM_LOGOS[msg.platform];
    if (logo) pill.insertAdjacentHTML("afterbegin", logo); // trusted constant
    const label = document.createElement("span");
    label.textContent = PLATFORM_LABELS[msg.platform] || msg.platform;
    pill.appendChild(label);
    row.appendChild(pill);

    if (msg.test) {
      const tag = document.createElement("span");
      tag.className = "test-tag";
      tag.textContent = "TEST";
      row.appendChild(tag);
    }

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
  // Message-level emotes (Twitch native, Kick) win over global 7TV/BTTV/FFZ.
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
      const url = map.get(tok) || globalEmotes.get(tok);
      if (url) {
        const img = document.createElement("img");
        img.className = "emote";
        img.src = url;
        img.alt = tok;
        img.title = tok;
        img.loading = "lazy";
        img.decoding = "async";
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
  function setStatus(name, state, detail) {
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
    dot.title = name + ": " + state + (detail ? " — " + detail : "");
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
    if (cfg.token) {
      // Multi-tenant: the token resolves to the user's channels server-side.
      q.set("token", cfg.token);
    } else {
      if (cfg.twitch) q.set("twitch", cfg.twitch);
      if (cfg.kick) q.set("kick", cfg.kick);
      if (cfg.x) q.set("x", cfg.x);
    }
    return base + "/feed?" + q.toString();
  }

  function applyTheme(cfg) {
    const root = document.documentElement;
    const size = clampInt(cfg.size, 0, 8, 96);
    if (size) root.style.setProperty("--font-size", size + "px");
    if (cfg.font) root.style.setProperty("--font-family", cfg.font);
  }

  function maybeShowHint() {
    if (cfg.token || cfg.twitch || cfg.kick || cfg.x) return;
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

  // Overlay's own "Send test" control — asks the server (which knows our token)
  // to inject test messages into our feed. Works from a browser tab or OBS Interact.
  const testBtn = document.getElementById("testBtn");
  if (testBtn) {
    testBtn.addEventListener("click", function () {
      if (ws && ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: "test" }));
        } catch (e) {}
      }
    });
  }

  // Go.
  connect();
})();
