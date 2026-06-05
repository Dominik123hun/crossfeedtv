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
