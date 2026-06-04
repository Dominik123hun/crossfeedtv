/* ─────────────────────────────────────────────────────────────────────────
   Crossfeed landing page.

   ╔═══════════════════════════════════════════════════════════════════════╗
   ║  EDIT MARKETING COPY HERE — everything visitor-facing lives in COPY.   ║
   ╚═══════════════════════════════════════════════════════════════════════╝
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  var COPY = {
    eyebrow: "Twitch · Kick · X",
    headlineHtml: 'Every chat, <span class="accent">one feed.</span>',
    subhead:
      "Twitch, X, and Kick — live, labeled, in one place. Stop tabbing between windows and read everyone talking to you in a single stream that drops straight into OBS.",
    ctaPrimary: "Start free",
    ctaSecondary: "See how it works",
    trust: ["No API keys", "Transparent OBS overlay", "10-second setup"],
    feedNote: "A real merged feed — not a diagram. This is what your viewers' chat becomes.",

    featuresTitle: "Three platforms, one stream you can actually read.",
    features: [
      {
        cls: "tw",
        icon: "merge",
        title: "All three, for real.",
        body: "Genuine live chat from Twitch, Kick, and X at once — actual real-time messages, not polled replies or screenshots.",
      },
      {
        cls: "kk",
        icon: "pill",
        title: "Always labeled.",
        body: "Every message carries a colored source pill — Twitch purple, Kick green, X black — so you always know who's talking where.",
      },
      {
        cls: "xx",
        icon: "shield",
        title: "Never drops.",
        body: "Each platform connects independently and reconnects on its own. One source hiccupping never takes the rest of your feed down.",
      },
    ],

    howTitle: "Live in about ten seconds.",
    steps: [
      {
        title: "Point it at your channels",
        body: "Add your Twitch, Kick, and X handles in the dashboard. No config files, no API keys.",
      },
      {
        title: "We run Crossfeed for you",
        body: "Our hosted service merges all three live chats into one labeled feed, isolated to your account.",
      },
      {
        title: "Add the overlay URL to OBS",
        body: "Copy your unique overlay link into an OBS Browser Source. Transparent background — it just floats over your scene.",
        code: "/overlay?token=•••",
      },
    ],

    obsTitle: "Looks like it belongs in your scene.",
    obsLead:
      "The overlay is a transparent browser source with readable, outlined text and inline emotes. Drop it in once and forget it.",

    faqTitle: "Questions, answered.",
    faq: [
      {
        q: "Does X really have live chat?",
        a: "Yes — via live broadcasts (the descendant of Periscope). Crossfeed reads that broadcast chat and merges it in alongside Twitch and Kick.",
      },
      {
        q: "Is it free?",
        a: "Crossfeed is free to use while it's in early access. Paid tiers will come later; for now, connect your channels and go.",
      },
      {
        q: "Do I need API keys or developer accounts?",
        a: "No. Twitch connects anonymously, and Kick and X are handled for you. You just enter your channel names.",
      },
      {
        q: "Which platforms are supported?",
        a: "Twitch, Kick, and X broadcasts today. The renderer is built so more sources and custom emotes (7TV/BTTV/FFZ) can slot in.",
      },
      {
        q: "How do I add it to OBS?",
        a: "Add a Browser Source, paste your unique overlay URL, and set a tall size like 460×900. The background is already transparent — no chroma key needed.",
      },
    ],

    finalCtaTitle: "Read everyone. In one place.",
    footerNote:
      "Crossfeed merges Twitch, Kick, and X live chat into one OBS overlay. Built for people who stream.",
  };

  // ── Mock feed data (the signature hero element) ──────────────────────────
  var PLATFORM_LOGOS = {
    twitch:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.3 0 1 3.3v13.4h4.6V20l3.3-3.3h2.7L17.7 11V0H4.3zm12 10.3-2.7 2.7H11l-2.3 2.3v-2.3H5.6V1.3h10.7v9z"/><path d="M14.7 3.7h-1.4v4h1.4v-4zm-3.7 0H9.6v4H11v-4z"/></svg>',
    kick: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2h5.5v6.5L13 2h6.5l-6 8 6 8H13L8.5 11.5V18H3z"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.68l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z"/></svg>',
  };
  var LABEL = { twitch: "Twitch", kick: "Kick", x: "X" };
  function tw(id) {
    return "https://static-cdn.jtvnw.net/emoticons/v2/" + id + "/default/dark/2.0";
  }

  var MESSAGES = [
    { p: "twitch", a: "ninjaslayer", c: "#ff7f50", b: ["SUB"], parts: ["no shot that actually worked", { e: "Kappa", u: tw(25) }] },
    { p: "kick", a: "KickKing", c: "#53fc18", b: ["VIP"], parts: ["green side stand UP", { j: "🟢" }] },
    { p: "x", a: "@spaces_fan", c: "#ffffff", parts: ["caught the broadcast, you're cooking", { j: "👀" }] },
    { p: "twitch", a: "pixelmage", c: "#8a2be2", b: ["MOD"], parts: ["CLUTCH", { e: "PogChamp", u: tw(305954156) }] },
    { p: "kick", a: "degenDan", c: "#1e90ff", parts: ["LETS GOOOO", { j: "🚀" }] },
    { p: "x", a: "@chrissy", c: "#ffffff", parts: ["first time catching you live, subbed everywhere"] },
    { p: "twitch", a: "lurker_99", c: "#00ced1", parts: ["been lurking 3 hours lol", { e: "LUL", u: tw(425618) }] },
    { p: "kick", a: "mod_maria", c: "#53fc18", b: ["MOD"], parts: ["keep it civil chat", { j: "🛡️" }] },
    { p: "x", a: "@late_night", c: "#ffffff", parts: ["one feed for all three is genuinely huge"] },
    { p: "twitch", a: "emoteLord", c: "#ff69b4", b: ["SUB"], parts: [{ e: "Kappa", u: tw(25) }, { e: "Kappa", u: tw(25) }, "perfectly balanced"] },
    { p: "kick", a: "streamsniper", c: "#ff4500", parts: ["behind you!!", { j: "😱" }] },
    { p: "twitch", a: "gigachadgg", c: "#daa520", b: ["VIP"], parts: ["GG well played", { j: "🔥" }] },
    { p: "x", a: "@quietfan", c: "#ffffff", parts: ["didn't know X had chat like this"] },
    { p: "kick", a: "copium_kev", c: "#9acd32", parts: ["we believe", { j: "🙏" }] },
    { p: "twitch", a: "saltyqueen", c: "#ff1493", b: ["MOD"], parts: ["chat be nice or timeout", { j: "⏰" }] },
    { p: "x", a: "@dropthebeat", c: "#ffffff", parts: ["the labels make this so readable"] },
  ];

  // ── DOM builders ─────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildPill(p) {
    var pill = el("span", "pill " + p);
    pill.insertAdjacentHTML("afterbegin", PLATFORM_LOGOS[p] || "");
    pill.appendChild(el("span", null, LABEL[p] || p));
    return pill;
  }

  function buildMessage(m) {
    var row = el("div", "msg " + m.p);
    row.appendChild(buildPill(m.p));
    if (m.b) {
      for (var i = 0; i < m.b.length; i++) row.appendChild(el("span", "badge", m.b[i]));
    }
    var author = el("span", "author", m.a);
    author.style.color = m.c;
    row.appendChild(author);
    row.appendChild(el("span", "colon", ":"));
    var text = el("span", "text");
    for (var k = 0; k < m.parts.length; k++) {
      var part = m.parts[k];
      if (k > 0) text.appendChild(document.createTextNode(" "));
      if (typeof part === "string") {
        text.appendChild(document.createTextNode(part));
      } else if (part.j) {
        text.appendChild(el("span", "emoji", part.j));
      } else if (part.e) {
        var img = document.createElement("img");
        img.className = "emote";
        img.src = part.u;
        img.alt = part.e;
        img.loading = "lazy";
        (function (code) {
          img.onerror = function () {
            img.replaceWith(document.createTextNode(code));
          };
        })(part.e);
        text.appendChild(img);
      }
    }
    row.appendChild(text);
    return row;
  }

  // ── Looping hero feed ────────────────────────────────────────────────────
  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function runFeed(feedEl, seedCount, animate) {
    if (!feedEl) return;
    var idx = 0;
    function push() {
      var m = MESSAGES[idx % MESSAGES.length];
      idx++;
      feedEl.appendChild(buildMessage(m));
      while (feedEl.childElementCount > 13) feedEl.removeChild(feedEl.firstElementChild);
    }
    // Seed so it's never empty.
    for (var s = 0; s < seedCount; s++) push();
    if (!animate) return;
    (function loop() {
      var delay = 1050 + Math.random() * 850;
      setTimeout(function () {
        push();
        loop();
      }, delay);
    })();
  }

  // ── Section content injection ────────────────────────────────────────────
  var FEATURE_ICONS = {
    merge:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#9146ff" stroke-width="2" stroke-linecap="round"><path d="M6 4v4a4 4 0 0 0 4 4h4"/><path d="M18 4v4a4 4 0 0 1-4 4h-4"/><path d="M12 12v8"/></svg>',
    pill:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#53fc18" stroke-width="2" stroke-linecap="round"><rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="8" cy="12" r="1.6" fill="#53fc18" stroke="none"/></svg>',
    shield:
      '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  };

  function injectCopy() {
    document.querySelectorAll("[data-copy]").forEach(function (node) {
      var v = COPY[node.getAttribute("data-copy")];
      if (v != null) node.textContent = v;
    });
    document.querySelectorAll("[data-copy-html]").forEach(function (node) {
      var v = COPY[node.getAttribute("data-copy-html")];
      if (v != null) node.innerHTML = v; // trusted constant copy
    });
    var trust = document.querySelector('[data-copy-list="trust"]');
    if (trust) COPY.trust.forEach(function (t) { trust.appendChild(el("li", null, t)); });
  }

  function injectFeatures() {
    var grid = document.getElementById("featureGrid");
    if (!grid) return;
    COPY.features.forEach(function (f) {
      var card = el("div", "feature " + f.cls);
      var icon = el("div", "ficon");
      icon.innerHTML = FEATURE_ICONS[f.icon] || "";
      card.appendChild(icon);
      card.appendChild(el("h3", null, f.title));
      card.appendChild(el("p", null, f.body));
      grid.appendChild(card);
    });
  }

  function injectSteps() {
    var ol = document.getElementById("steps");
    if (!ol) return;
    COPY.steps.forEach(function (s) {
      var li = document.createElement("li");
      li.appendChild(el("h3", null, s.title));
      li.appendChild(el("p", null, s.body));
      if (s.code) li.appendChild(el("code", null, s.code));
      ol.appendChild(li);
    });
  }

  function injectFaq() {
    var wrap = document.getElementById("faq");
    if (!wrap) return;
    COPY.faq.forEach(function (item) {
      var d = document.createElement("details");
      var sum = el("summary", null, item.q);
      var ans = el("div", "answer", item.a);
      d.appendChild(sum);
      d.appendChild(ans);
      wrap.appendChild(d);
    });
  }

  // ── Scroll reveal (subtle, opt-out on reduced motion) ────────────────────
  function setupReveal() {
    if (reduceMotion || !("IntersectionObserver" in window)) return;
    var targets = document.querySelectorAll(".feature, .steps li, .stream-frame, .faq details");
    targets.forEach(function (t) {
      t.style.opacity = "0";
      t.style.transform = "translateY(14px)";
      t.style.transition = "opacity .5s ease, transform .5s ease";
    });
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.style.opacity = "1";
            e.target.style.transform = "none";
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    targets.forEach(function (t) { io.observe(t); });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    injectCopy();
    injectFeatures();
    injectSteps();
    injectFaq();
    runFeed(document.getElementById("heroFeed"), reduceMotion ? 9 : 5, !reduceMotion);
    runFeed(document.getElementById("obsFeed"), 6, false);
    setupReveal();
  });
})();
