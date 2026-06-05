/* Crossfeed auth — one page handles /signup, /login, /forgot and /reset. */
(function () {
  "use strict";

  var titleEl = document.getElementById("authTitle");
  var subEl = document.getElementById("authSubtitle");
  var infoEl = document.getElementById("info");
  var errorEl = document.getElementById("error");
  var form = document.getElementById("authForm");
  var emailField = document.getElementById("emailField");
  var passwordField = document.getElementById("passwordField");
  var emailEl = document.getElementById("email");
  var passwordEl = document.getElementById("password");
  var submitBtn = document.getElementById("submitBtn");
  var secondaryBtn = document.getElementById("secondaryBtn");
  var forgotLink = document.getElementById("forgotLink");
  var switcher = document.getElementById("switcher");

  var query = new URLSearchParams(location.search);
  var resetToken = query.get("token") || "";

  function modeFromPath() {
    if (location.pathname === "/login") return "login";
    if (location.pathname === "/forgot") return "forgot";
    if (location.pathname === "/reset") return "reset";
    return "signup";
  }
  var mode = modeFromPath();

  // ── small helpers ──────────────────────────────────────────────────────────
  function show(el) { el.classList.remove("hidden"); }
  function hide(el) { el.classList.add("hidden"); }
  function clearMsgs() { hide(infoEl); infoEl.textContent = ""; hide(errorEl); errorEl.textContent = ""; }
  function showError(msg) { errorEl.textContent = msg; show(errorEl); hide(infoEl); }
  function showInfo(msg) { infoEl.textContent = msg; show(infoEl); hide(errorEl); }
  function busy(on, label) { submitBtn.disabled = on; if (label) submitBtn.textContent = label; }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fetch" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        return { status: r.status, ok: r.ok, body: b };
      });
    });
  }

  // Secondary button action is swapped per context (resend / go-to-login).
  var secondaryAction = null;
  secondaryBtn.addEventListener("click", function () { if (secondaryAction) secondaryAction(); });

  function setSecondary(label, fn, primary) {
    secondaryBtn.textContent = label;
    secondaryBtn.className = "btn btn-block" + (primary ? " btn-primary" : "");
    secondaryAction = fn;
    show(secondaryBtn);
  }

  // ── render the chosen mode ───────────────────────────────────────────────────
  function render() {
    clearMsgs();
    show(form);
    show(emailField);
    show(passwordField);
    show(submitBtn);
    submitBtn.disabled = false;
    hide(secondaryBtn);
    secondaryAction = null;
    hide(forgotLink);

    if (mode === "signup") {
      titleEl.textContent = "Create your account";
      subEl.textContent = "Connect your channels and get your overlay URL in seconds.";
      submitBtn.textContent = "Create account";
      passwordEl.setAttribute("autocomplete", "new-password");
      passwordEl.setAttribute("placeholder", "At least 8 characters");
      switcher.innerHTML = 'Already have an account? <a href="/login" data-mode="login">Log in</a>';
      history.replaceState(null, "", "/signup");
    } else if (mode === "login") {
      titleEl.textContent = "Welcome back";
      subEl.textContent = "Log in to manage your channels and overlay.";
      submitBtn.textContent = "Log in";
      passwordEl.setAttribute("autocomplete", "current-password");
      passwordEl.setAttribute("placeholder", "Your password");
      show(forgotLink);
      switcher.innerHTML = 'New to Crossfeed? <a href="/signup" data-mode="signup">Create an account</a>';
      history.replaceState(null, "", "/login");
      if (query.get("verified") === "1") showInfo("Email verified — you can log in now.");
      else if (query.get("verify_error") === "1")
        showError("That verification link is invalid or has expired. Log in to get a new one.");
    } else if (mode === "forgot") {
      titleEl.textContent = "Reset your password";
      subEl.textContent = "Enter your email and we'll send you a reset link.";
      hide(passwordField);
      submitBtn.textContent = "Send reset link";
      switcher.innerHTML = 'Remembered it? <a href="/login" data-mode="login">Log in</a>';
      history.replaceState(null, "", "/forgot");
    } else if (mode === "reset") {
      titleEl.textContent = "Choose a new password";
      subEl.textContent = "Set a new password for your account.";
      hide(emailField);
      passwordEl.setAttribute("autocomplete", "new-password");
      passwordEl.setAttribute("placeholder", "New password (8+ characters)");
      submitBtn.textContent = "Update password";
      switcher.innerHTML = '<a href="/login" data-mode="login">Back to log in</a>';
      if (!resetToken) {
        showError("This reset link is invalid or has expired. Request a new one.");
        submitBtn.disabled = true;
      }
    }
  }

  // Mode switching via any [data-mode] link (switcher + forgot link).
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-mode]");
    if (!a) return;
    e.preventDefault();
    mode = a.getAttribute("data-mode");
    resetToken = ""; // leaving reset mode
    render();
  });

  // ── submit ───────────────────────────────────────────────────────────────────
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearMsgs();
    var email = emailEl.value.trim();
    var password = passwordEl.value;

    if (mode === "forgot") return doForgot(email);
    if (mode === "reset") return doReset(password);

    if (!email || !password) return showError("Please enter your email and password.");
    if ((mode === "signup" || mode === "reset") && password.length < 8)
      return showError("Password must be at least 8 characters.");

    if (mode === "signup") return doSignup(email, password);
    return doLogin(email, password);
  });

  function doSignup(email, password) {
    busy(true, "Creating…");
    post("/api/signup", { email: email, password: password })
      .then(function (res) {
        if (!res.ok) throw new Error(msgOf(res, "Could not create your account."));
        if (res.body.needsVerification) {
          showVerifySent(email);
        } else {
          location.href = "/dashboard";
        }
      })
      .catch(function (err) { showError(err.message); busy(false, "Create account"); });
  }

  function doLogin(email, password) {
    busy(true, "Logging in…");
    post("/api/login", { email: email, password: password })
      .then(function (res) {
        if (res.ok) { location.href = "/dashboard"; return; }
        if (res.status === 403 && res.body.needsVerification) {
          busy(false, "Log in");
          showError(res.body.error || "Please verify your email first.");
          setSecondary("Resend verification email", function () { resend(email); });
          return;
        }
        throw new Error(msgOf(res, "Could not log in."));
      })
      .catch(function (err) { showError(err.message); busy(false, "Log in"); });
  }

  function doForgot(email) {
    if (!email) return showError("Please enter your email address.");
    busy(true, "Sending…");
    post("/api/password/forgot", { email: email }).then(function () {
      hide(form);
      showInfo("If that email is registered, a reset link is on its way. Check your inbox.");
    });
  }

  function doReset(password) {
    if (password.length < 8) return showError("Password must be at least 8 characters.");
    busy(true, "Updating…");
    post("/api/password/reset", { token: resetToken, password: password })
      .then(function (res) {
        if (!res.ok) throw new Error(msgOf(res, "Could not reset your password."));
        hide(form);
        showInfo("Password updated. You can log in with your new password now.");
        setSecondary("Go to log in", function () { location.href = "/login"; }, true);
      })
      .catch(function (err) { showError(err.message); busy(false, "Update password"); });
  }

  function showVerifySent(email) {
    hide(form);
    showInfo("Almost there — we sent a verification link to " + email + ". Click it, then log in.");
    setSecondary("Resend email", function () { resend(email); });
    switcher.innerHTML = '<a href="/login" data-mode="login">Back to log in</a>';
  }

  function resend(email) {
    if (!email) return showError("Enter your email first.");
    secondaryBtn.disabled = true;
    post("/api/verify/resend", { email: email }).then(function () {
      secondaryBtn.disabled = false;
      showInfo("Sent. Check your inbox (and spam) for the verification link.");
    });
  }

  function msgOf(res, fallback) {
    return res.body && res.body.error ? res.body.error : fallback;
  }

  render();
})();
