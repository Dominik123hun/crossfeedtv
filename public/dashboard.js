/* Crossfeed dashboard — manage channels, overlay URL, account. */
(function () {
  "use strict";

  // New user-facing strings live here (not inline).
  var COPY = {
    testSent: "Test messages sent to your feed.",
    testBusy: "Hang on — a test is already running.",
    testFail: "Couldn't send test messages.",
    states: {
      connected: "Connected",
      connecting: "Connecting…",
      reconnecting: "Reconnecting…",
      error: "Error",
      disconnected: "Disconnected",
      idle: "No channel set",
    },
  };

  var els = {
    whoEmail: document.getElementById("whoEmail"),
    acctEmail: document.getElementById("acctEmail"),
    twitch: document.getElementById("twitchInput"),
    kick: document.getElementById("kickInput"),
    x: document.getElementById("xInput"),
    form: document.getElementById("channelsForm"),
    saveBtn: document.getElementById("saveBtn"),
    saveState: document.getElementById("saveState"),
    overlayUrl: document.getElementById("overlayUrl"),
    copyBtn: document.getElementById("copyBtn"),
    rotateBtn: document.getElementById("rotateBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    preview: document.getElementById("preview"),
    previewEmpty: document.getElementById("previewEmpty"),
    testBtn: document.getElementById("testBtn"),
    toast: document.getElementById("toast"),
    // settings controls
    setFont: document.getElementById("setFont"),
    setFontVal: document.getElementById("setFontVal"),
    setOpacity: document.getElementById("setOpacity"),
    setOpacityVal: document.getElementById("setOpacityVal"),
    setPosition: document.getElementById("setPosition"),
    showTwitch: document.getElementById("showTwitch"),
    showKick: document.getElementById("showKick"),
    showX: document.getElementById("showX"),
    setStatus: document.getElementById("setStatus"),
  };

  var current = null; // last known user object

  function api(method, path, body) {
    var opts = { method: method, headers: { "x-requested-with": "fetch" } };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (r) {
      return r
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!r.ok) {
            var err = new Error((data && data.error) || "Request failed");
            err.status = r.status;
            throw err;
          }
          return data;
        });
    });
  }

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.classList.remove("show");
    }, 2200);
  }

  function overlayAbsoluteUrl(user) {
    return location.origin + user.overlayPath;
  }

  function render(user) {
    current = user;
    els.whoEmail.textContent = user.email;
    els.acctEmail.textContent = user.email;
    els.twitch.value = user.channels.twitch || "";
    els.kick.value = user.channels.kick || "";
    els.x.value = user.channels.x || "";
    els.overlayUrl.value = overlayAbsoluteUrl(user);
    applySettingsToControls(user.settings);
    renderPreview(user);
    ensureStatusWs(user.token);
  }

  // ── Overlay settings ──
  function applySettingsToControls(s) {
    s = s || {};
    var font = typeof s.fontSize === "number" ? s.fontSize : 18;
    els.setFont.value = font;
    els.setFontVal.textContent = font + "px";
    var opPct = Math.round((typeof s.bgOpacity === "number" ? s.bgOpacity : 0) * 100);
    els.setOpacity.value = opPct;
    els.setOpacityVal.textContent = opPct === 0 ? "Off" : opPct + "%";
    els.setPosition.value = s.position || "bottom-left";
    var show = s.show || { twitch: true, kick: true, x: true };
    els.showTwitch.checked = show.twitch !== false;
    els.showKick.checked = show.kick !== false;
    els.showX.checked = show.x !== false;
    els.setStatus.checked = !!s.statusIndicator;
  }

  function readSettingsFromControls() {
    return {
      fontSize: parseInt(els.setFont.value, 10),
      bgOpacity: parseInt(els.setOpacity.value, 10) / 100,
      position: els.setPosition.value,
      show: {
        twitch: els.showTwitch.checked,
        kick: els.showKick.checked,
        x: els.showX.checked,
      },
      statusIndicator: els.setStatus.checked,
    };
  }

  var settingsTimer = null;
  function scheduleSaveSettings() {
    // live label feedback
    els.setFontVal.textContent = els.setFont.value + "px";
    var op = parseInt(els.setOpacity.value, 10);
    els.setOpacityVal.textContent = op === 0 ? "Off" : op + "%";
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () {
      // The server pushes the new settings to the live overlay/preview, so we do
      // NOT re-render here (that would reload the preview). Reuses the live push.
      api("PUT", "/api/settings", readSettingsFromControls())
        .then(function (data) {
          current = data.user;
        })
        .catch(function (err) {
          toast(err.message || "Couldn't save settings.");
        });
    }, 250);
  }

  ["setFont", "setOpacity"].forEach(function (k) {
    els[k].addEventListener("input", scheduleSaveSettings);
  });
  ["setPosition", "showTwitch", "showKick", "showX", "setStatus"].forEach(function (k) {
    els[k].addEventListener("change", scheduleSaveSettings);
  });

  var previewToken = null;
  function renderPreview(user) {
    // Build the preview ONCE per token. Channel + settings changes are pushed to
    // the already-connected overlay live (hub.resubscribe / settings push), so we
    // must NOT rebuild it on save — reloading drops the feed socket and would lose
    // any in-flight test burst (the cause of an empty preview right after saving).
    // It only rebuilds when the token changes (e.g. after "Reset link").
    if (previewToken === user.token && els.preview.querySelector("iframe")) return;
    previewToken = user.token;
    els.preview.innerHTML = "";
    var iframe = document.createElement("iframe");
    iframe.title = "Live overlay preview";
    iframe.src = user.overlayPath + "&status=1&size=15";
    els.preview.appendChild(iframe);
  }

  // ── Live per-platform connection status (over the existing /feed WS) ──
  var statusWs = null;
  var statusToken = null;

  function ensureStatusWs(token) {
    if (statusToken === token && statusWs && statusWs.readyState <= 1) return;
    statusToken = token;
    if (statusWs) {
      try { statusWs.close(); } catch (e) {}
      statusWs = null;
    }
    openStatusWs(token);
  }

  function openStatusWs(token) {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/feed?token=" + encodeURIComponent(token));
    statusWs = ws;
    ws.onmessage = function (ev) {
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.type === "status") setStatusRow(f.platform, f.state, f.detail);
    };
    ws.onclose = function () {
      if (statusWs === ws) {
        statusWs = null;
        setTimeout(function () { if (statusToken === token) openStatusWs(token); }, 2000);
      }
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function setStatusRow(platform, state, detail) {
    var dot = document.getElementById("dot-" + platform);
    var st = document.getElementById("state-" + platform);
    if (!dot || !st) return;
    dot.className = "dot " + String(state || "").replace(/[^a-z]/gi, "");
    var label = (COPY.states && COPY.states[state]) || state || "—";
    st.textContent = state === "error" && detail ? label + ": " + truncate(detail, 48) : label;
    st.title = detail || "";
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ── Load current user (gate the page) ──
  api("GET", "/api/me")
    .then(function (data) {
      render(data.user);
    })
    .catch(function (err) {
      if (err.status === 401) location.href = "/login";
      else toast(err.message || "Could not load your account.");
    });

  // ── Save channels ──
  els.form.addEventListener("submit", function (e) {
    e.preventDefault();
    els.saveBtn.disabled = true;
    els.saveState.textContent = "Saving…";
    api("PUT", "/api/channels", {
      twitch: els.twitch.value,
      kick: els.kick.value,
      x: els.x.value,
    })
      .then(function (data) {
        render(data.user);
        els.saveState.textContent = "Saved.";
        toast("Channels saved — overlay updated live.");
        setTimeout(function () {
          els.saveState.textContent = "";
        }, 2000);
      })
      .catch(function (err) {
        els.saveState.textContent = err.message || "Could not save.";
      })
      .then(function () {
        els.saveBtn.disabled = false;
      });
  });

  // ── Send test messages ──
  els.testBtn.addEventListener("click", function () {
    els.testBtn.disabled = true;
    api("POST", "/api/test")
      .then(function () {
        toast(COPY.testSent);
      })
      .catch(function (err) {
        toast(err.status === 429 ? COPY.testBusy : err.message || COPY.testFail);
      })
      .then(function () {
        setTimeout(function () {
          els.testBtn.disabled = false;
        }, 2300);
      });
  });

  // ── Copy overlay URL ──
  els.copyBtn.addEventListener("click", function () {
    var url = els.overlayUrl.value;
    var done = function () {
      toast("Overlay URL copied.");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      els.overlayUrl.removeAttribute("readonly");
      els.overlayUrl.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        toast("Press Ctrl/Cmd+C to copy.");
      }
      els.overlayUrl.setAttribute("readonly", "");
    }
  });

  // ── Reset (rotate) token ──
  els.rotateBtn.addEventListener("click", function () {
    if (!confirm("Reset your overlay link? The old URL will stop working and you'll need to update OBS.")) return;
    api("POST", "/api/token/rotate")
      .then(function (data) {
        render(data.user);
        toast("New overlay link generated.");
      })
      .catch(function (err) {
        toast(err.message || "Could not reset link.");
      });
  });

  // ── Logout ──
  els.logoutBtn.addEventListener("click", function () {
    api("POST", "/api/logout").then(function () {
      location.href = "/";
    });
  });

  // ── Delete account ──
  els.deleteBtn.addEventListener("click", function () {
    if (!confirm("Delete your account permanently? Your channels, overlay URL, and data will be removed.")) return;
    api("DELETE", "/api/account")
      .then(function () {
        location.href = "/";
      })
      .catch(function (err) {
        toast(err.message || "Could not delete account.");
      });
  });
})();
