# Overnight log

## SUMMARY (read me first)

- **Branch:** `overnight/2026-06-05` (never touches `main`; no force-push/history rewrite)
- **Status:** in progress — updated as work proceeds.
- **Test suite:** a real, repeatable suite was added (`npm test`, Node's built-in
  test runner via `tsx`, zero new deps) alongside `npm run build`. "Full suite" =
  `npm run build` + `npm test`, run before every commit.
- **What got better / commits / review items / skipped:** filled in below and
  finalized at the end.

### Top things to review first
- _TBD at end._

### NEEDS HUMAN REVIEW
- _TBD — appended as encountered._

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
