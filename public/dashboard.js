/* Crossfeed dashboard — manage channels, overlay URL, account. */
(function () {
  "use strict";

  // New user-facing strings live here (not inline).
  var COPY = {
    testSent: "Test messages sent to your feed.",
    testBusy: "Hang on — a test is already running.",
    testFail: "Couldn't send test messages.",
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
    renderPreview(user);
  }

  function renderPreview(user) {
    // Always connect the preview (even with no channels) so the test button has
    // a live client to render into — and so OBS-style status shows immediately.
    els.preview.innerHTML = "";
    var iframe = document.createElement("iframe");
    iframe.title = "Live overlay preview";
    // cache-bust so saving channels/settings refreshes the preview
    iframe.src = user.overlayPath + "&status=1&size=15&_=" + Date.now();
    els.preview.appendChild(iframe);
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
