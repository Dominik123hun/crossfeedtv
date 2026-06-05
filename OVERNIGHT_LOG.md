# Overnight log

## SUMMARY (read me first)

- **Branch:** `overnight/2026-06-05` (off `main`; no commits to main, no
  force-push, no history rewrite). Pushed to origin for review.
- **Commits:** 8 (one per task; full suite green before each).
- **Test status: GREEN.** `npm run build` clean; `npm test` = **64 passing, 0
  failing**. There was no committed test suite before tonight — adding one (and
  running it) is the night's biggest win.
- **What got better:**
  - A real, repeatable **test suite** (`npm test`, Node's built-in runner via
    `tsx`, **zero new deps**): 64 tests over Store, auth, emote resolver, chat
    parsers, the `BaseIngester` lifecycle, and end-to-end API + feed behavior.
  - **2 real robustness bugs fixed** (found by the new tests): a malformed cookie
    returned 500 (now 401); an oversized body reset the socket (now a clean 413).
  - **Security hardening:** per-IP rate limiting on signup/login + `SECURITY.md`.
  - **Accessibility:** labels, a global reduced-motion safety net, AA contrast bump.
  - **Docs:** README testing/security sections; RECON Kick-official section.
  - **Official Kick API groundwork** (OAuth + webhooks) as a separate, tested,
    feature-flagged module — **OFF by default**, working WS ingester untouched.

### Top 3 things to review first
1. **The 2 production fixes** (`src/auth.ts` cookie parse, `src/api.ts` oversized
   body → 413 with `Connection: close`). Both correct + test-covered; just confirm
   the 413 close behavior suits your proxy/host.
2. **Official Kick adapter** (`src/ingesters/kick-official.ts`): it's OFF by
   default and inert, but before enabling, verify the `TODO(kick-official)` items
   against Kick's current docs (signed-content format, OAuth/subscribe endpoints,
   header/field names). Enablement checklist is under "Item 7" below.
3. **`SECURITY.md` → "Needs attention"**: the Store/sessions/rate-limiter are
   per-process (fine for one instance, not multi-instance); no email-verify/
   lockout yet; add HSTS/CSP at the proxy before real users.

### NEEDS HUMAN REVIEW / skipped (and why)
- **No headless-DOM tests** for overlay/landing/dashboard *visual* behavior
  (corner anchors, per-platform hide, panel, animations). That needs jsdom/
  Playwright — a heavy dep, against the rules — so I covered the **contracts**
  (the frames/settings the overlay consumes) and left a "eyeball in a browser"
  note. Overlay settings rendering is the main thing to glance at visually.
- **Official Kick OAuth/subscription network calls** are stubs (no credentials,
  can't test, would be guesswork) — structured with TODOs only.
- **Untouched on purpose:** working Kick/X ingesters, deploy/Docker/prod config,
  secrets/`DATA_DIR`, and all existing TODOs (move Kick/X to official APIs;
  no billing). No data deleted, nothing irreversible.
- **Not in this backlog (deferred):** the earlier scaling track — Kick lookup
  batching + X account/proxy rotation — is riskier and was a separate ask; left
  for a supervised session.

---

## Task log (append-only)

### Setup
- Created branch `overnight/2026-06-05` from `main`. Confirmed clean tree and that
  the baseline `npm run build` is green (there was no committed test suite before
  tonight — prior tests were throwaway scripts).

### Item 1a — Test infrastructure + unit tests
- **What:** Added a committed test suite using `node:test` + `node:assert` run via
  `tsx` (no new dependencies). Added `npm test` script. Added `test/helpers.ts`
  (spins up the real server in-process on an ephemeral port with deterministic
  **fake ingesters** so the suite never touches the real Twitch/Kick/X network).
  Unit tests: `store`, `auth`, `emotes`, `parsers` (twitch IRC/normalize, kick,
  x).
- **Why:** A green, repeatable suite is the safety net for everything else tonight.
- **Additive code change:** `AppServer` now exposes `port()` (returns the bound
  port) so tests can use port `0`. No behavior change for prod.
- **Files:** `package.json` (test script), `src/server.ts` (`port()`),
  `test/helpers.ts`, `test/store.test.ts`, `test/auth.test.ts`,
  `test/emotes.test.ts`, `test/parsers.test.ts`.
- **Tests:** `npm run build` green; `npm test` = 29 passing.
- **Review:** none required.

### Item 1b — Integration tests + 2 robustness fixes they surfaced
- **What:** Added `test/api.test.ts` and `test/feed.test.ts` covering the
  security-critical paths end-to-end (in-process server + fake ingesters):
  pages served; signup/login validation; session gating; **garbage/expired
  cookies**; CSRF on every state-changing endpoint; malformed/oversized bodies;
  channel sanitization; settings clamping; test-feed debounce; token-rotation +
  account-delete invalidation; token→channel resolution; per-user isolation;
  invalid/empty token → empty feed; per-platform status (idle/connected);
  live re-subscription; settings frame on connect + live push; **real chat
  routing isolation**; **test-message isolation + test:true flag** (never leaks
  across users; never persisted — they bypass the Store entirely).
- **Two real bugs caught & fixed (additive, low-risk):**
  1. `src/auth.ts` `parseCookies` threw on malformed percent-encoding (e.g.
     `cf_sess=%%%`) → surfaced as **HTTP 500**. Now caught → falls back to raw
     value → request is simply unauthenticated (**401**).
  2. `src/api.ts` `readJson` called `req.destroy()` on oversized bodies → client
     got a **socket reset** instead of **413**. Now it stops buffering, lets the
     stream drain, and returns a clean `413` with `Connection: close`.
- **Files:** `test/api.test.ts`, `test/feed.test.ts`, `src/auth.ts`, `src/api.ts`.
- **Tests:** build green; `npm test` = **51 passing**.
- **Review:** worth a glance — the two fixes are correct and covered by tests, but
  confirm the 413 `Connection: close` behavior is acceptable for your proxy.

### Item 2 — Security hardening (additive)
- **Audited** the existing posture (mostly already solid): tokens are 192-bit
  CSPRNG (`randomBytes(24)`); rotation invalidates the old token server-side;
  scrypt + timing-safe password compare; HttpOnly/SameSite=Lax/Secure cookies;
  CSRF via required `X-Requested-With`; channel/settings validation; body-size
  cap; output via `textContent` + http(s) emote-URL guard; per-user isolation;
  `.gitignore` covers `.env` + `data/` and **no secrets/DB files are tracked**.
- **Added (the one real gap): per-IP rate limiting on signup/login.** New
  `src/rate-limit.ts` (in-memory sliding window, no deps), wired into `api.ts`
  for `/api/signup` + `/api/login`, configurable via `AUTH_RATE_MAX` /
  `AUTH_RATE_WINDOW_MS` (default 20 / 5 min). Honors `X-Forwarded-For`.
- **Wrote `SECURITY.md`** documenting what's covered and a "Needs attention"
  list (multi-instance shared store/sessions/limiter, email-verify/lockout,
  HSTS/CSP at the proxy, Kick/X official APIs, billing/quotas).
- **Files:** `src/rate-limit.ts`, `src/api.ts`, `src/config.ts`, `.env.example`,
  `SECURITY.md`, `test/helpers.ts` (+`auth` cfg), `test/api.test.ts` (rate-limit test).
- **Tests:** build green; `npm test` = **52 passing**.
- **Review:** the rate limiter is per-process/in-memory — fine for one instance;
  see SECURITY.md "Needs attention" for the multi-instance note.

### Item 3 — Resilience (verify + strengthen tests)
- **Already well-covered**, so per the rules I verified rather than rebuilt:
  per-ingester exponential backoff + jitter + connect-watchdog with full per-
  ingester isolation (`BaseIngester`); emote-set load failures fail soft (shown
  as text, message never dropped — `test/emotes.test.ts`); overlay bounds memory
  with a 200-message DOM cap + a burst queue cap (`public/overlay.js`).
- **Added `test/base-ingester.test.ts`** (the previously-untested core): connect→
  connected, reconnect-after-drop with backoff, **stop() cancels pending
  reconnect**, the **connect watchdog** tears down a hung connect, throwing
  event handlers are **isolated** (never escape the ingester), and double-start /
  stop-before-start are safe.
- **Files:** `test/base-ingester.test.ts`. No production code changed.
- **Tests:** build green; `npm test` = **56 passing**.
- **Review:** none required.

### Item 4 — Feature QA
- All four features are **present and now covered by tests** (not stubbed):
  1. **Test/preview feed** — isolation (firing user only), debounce (429), all-3
     platforms, `test:true` flag, WS-triggered path, **and never persisted**.
  2. **Per-source connection status** — `idle` for unset platforms, `connected`
     when set, emitted live over the feed WS.
  3. **Overlay customization** — settings frame on connect, **live push** on
     change (no reconnect), persistence, clamping/enum validation.
  4. **Emote completeness** — 7TV/BTTV/FFZ global+channel precedence, fail-soft,
     native/3rd-party merge.
- **Added** an explicit "test messages are never persisted" test (store on disk
  holds only `users` + `sessions`; no test author/flag anywhere).
- No feature bugs found beyond the two already fixed in item 1b. Overlay-side DOM
  behavior (position/hide/panel CSS, status toggle) is applied from the verified
  settings frame; not unit-tested here to avoid adding a DOM/jsdom dependency
  (see review note).
- **Files:** `test/feed.test.ts`.
- **Tests:** build green; `npm test` = **57 passing**.
- **Review:** overlay DOM rendering of settings (corner anchors, per-platform
  hide, translucent panel) is covered by the contract test on the pushed frame
  but not by a headless-DOM test — eyeball it once in a browser.

### Item 5 — Accessibility, responsive & perf (additive)
- **Audited** landing + dashboard. Already good: semantic `header/main/section/
  nav/footer`, native links/buttons, `<details>` FAQ, `:focus-visible` styles,
  `lang="en"` on all pages, `aria-live` status regions, per-component
  reduced-motion guards, and existing mobile breakpoints.
- **Additive fixes:**
  - **Global reduced-motion safety net** in `theme.css` (neutralizes all
    animation/transition durations) so nothing slips through.
  - **Programmatic labels** added where missing: `aria-label` on the Twitch/Kick/X
    channel inputs and the overlay-URL input; `aria-describedby` linking the font/
    opacity sliders to their value readouts; `role="status" aria-live="polite"`
    on the toast.
  - **Contrast:** bumped `--text-faint` (`#6c7682` → `#7c8694`) for AA on the
    near-black base (affects hints/footer/placeholders).
- Did NOT make risky perf changes — rendering already uses rAF batching + DOM/queue
  caps; no obvious waste worth a risky edit.
- **Files:** `public/theme.css`, `public/dashboard.html`.
- **Tests:** build green; `npm test` = **57 passing** (static-only changes).
- **Review:** none required; a visual once-over on a phone is nice-to-have.

### Item 6 — Docs
- **README:** added a **Testing** section (`npm test` via Node's built-in runner
  through tsx, what's covered, "full suite" = build + test) and a **Security**
  pointer to `SECURITY.md`; tweaked the config-reference blurb.
- Existing code is already heavily commented; no non-obvious logic found lacking
  comments, so none were padded. (RECON.md gets the official-Kick capture note in
  item 7.)
- **Files:** `README.md`.
- **Tests:** unchanged; **57 passing**.
- **Review:** none required.

### Item 7 — Official Kick adapter groundwork (feature-flagged, OFF by default)
- **What:** Added `src/ingesters/kick-official.ts` — a SEPARATE official-API path
  (OAuth 2.1 + webhooks) alongside the untouched working WS/Pusher ingester. The
  **security-critical webhook signature verification** (RSA-SHA256) and the
  `chat.message.sent` → NormalizedMessage mapping are fully implemented; OAuth +
  event-subscription are structured stubs with clear `TODO(kick-official)` markers.
- **Wiring (inert by default):** config `kickOfficial` (env `KICK_OFFICIAL_*`,
  default `enabled=false`); a guarded webhook route in `server.ts` mounted ONLY
  when enabled; one additive `Hub.injectExternal()` to route a verified message
  to subscribers like any other. With the flag off, the route 404s and nothing
  changes.
- **Tested:** signature verify (valid / tampered / wrong-key / garbage — all via a
  self-generated keypair); event normalization; `handleKickWebhook` (200 chat /
  403 bad sig / 503 no key / 200 ignored non-chat); **OFF-by-default 404**; and a
  full **ENABLED end-to-end** test (signed webhook → routed to a live feed).
- **Files:** `src/ingesters/kick-official.ts`, `src/config.ts`, `src/hub.ts`
  (`injectExternal`), `src/server.ts` (guarded route + raw-body reader),
  `.env.example`, `RECON.md`, `test/kick-official.test.ts`, `test/helpers.ts`.
- **Tests:** build green; `npm test` = **64 passing**.

#### ▶ Enabling the official Kick adapter (what a human must do)
1. Register a Kick app → set `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`.
2. Expose a public HTTPS URL mapping to `KICK_WEBHOOK_PATH` (default
   `/webhooks/kick`) → set `KICK_WEBHOOK_PUBLIC_URL`.
3. Set `KICK_EVENT_PUBLIC_KEY` to Kick's event-signing public key (PEM).
4. Implement the two stubs (`exchangeCodeForToken`, `subscribeToChatEvents`) and
   complete OAuth 2.1 (PKCE) + a `chat.message.sent` subscription to your URL.
5. Confirm the `TODO(kick-official)` items against Kick's current docs (endpoint
   URLs, **signed-content format** — repo assumes `messageId.timestamp.rawBody` —,
   `Kick-Event-*` header names, payload field names).
6. Set `KICK_OFFICIAL_ENABLED=true` and restart. See RECON.md for details.
