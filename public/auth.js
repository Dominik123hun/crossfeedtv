/* Crossfeed auth — one page handles both /login and /signup. */
(function () {
  "use strict";

  // Default mode from the path; toggle without leaving the page.
  var mode = location.pathname === "/login" ? "login" : "signup";

  var titleEl = document.getElementById("authTitle");
  var subEl = document.getElementById("authSubtitle");
  var submitBtn = document.getElementById("submitBtn");
  var switcher = document.getElementById("switcher");
  var errorEl = document.getElementById("error");
  var form = document.getElementById("authForm");
  var passwordEl = document.getElementById("password");

  function render() {
    if (mode === "signup") {
      titleEl.textContent = "Create your account";
      subEl.textContent = "Connect your channels and get your overlay URL in seconds.";
      submitBtn.textContent = "Create account";
      passwordEl.setAttribute("autocomplete", "new-password");
      switcher.innerHTML = 'Already have an account? <a href="/login" data-mode="login">Log in</a>';
      history.replaceState(null, "", "/signup");
    } else {
      titleEl.textContent = "Welcome back";
      subEl.textContent = "Log in to manage your channels and overlay.";
      submitBtn.textContent = "Log in";
      passwordEl.setAttribute("autocomplete", "current-password");
      switcher.innerHTML = "New to Crossfeed? <a href=\"/signup\" data-mode=\"signup\">Create an account</a>";
      history.replaceState(null, "", "/login");
    }
    hideError();
  }

  switcher.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-mode]");
    if (!a) return;
    e.preventDefault();
    mode = a.getAttribute("data-mode");
    render();
  });

  function hideError() {
    errorEl.classList.add("hidden");
    errorEl.textContent = "";
  }
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    hideError();
    var email = document.getElementById("email").value.trim();
    var password = passwordEl.value;
    if (!email || !password) return showError("Please enter your email and password.");
    if (mode === "signup" && password.length < 8)
      return showError("Password must be at least 8 characters.");

    submitBtn.disabled = true;
    submitBtn.textContent = mode === "signup" ? "Creating…" : "Logging in…";

    fetch("/api/" + mode, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "fetch" },
      body: JSON.stringify({ email: email, password: password }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, body: body };
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body && res.body.error ? res.body.error : "Something went wrong.");
        location.href = "/dashboard";
      })
      .catch(function (err) {
        showError(err.message || "Something went wrong.");
        submitBtn.disabled = false;
        render();
      });
  });

  render();
})();
