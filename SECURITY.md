# Security notes

A summary of what's covered today and what still needs attention. This is a
hobby/contest-grade SaaS; treat the "Needs attention" list as required before
onboarding real paying users.

## Covered

### Tokens & passwords
- **Overlay tokens** are generated with a CSPRNG — `crypto.randomBytes(24)` →
  48 hex chars (192 bits of entropy), unguessable. Each is unique per user
  (`src/store.ts`).
- **Token rotation** (`POST /api/token/rotate`) replaces the token and removes
  the old one from the lookup index, so the old overlay URL stops resolving
  immediately, server-side.
- **Passwords** are hashed with **scrypt** and a per-user 16-byte random salt;
  verification uses a constant-time compare (`crypto.timingSafeEqual`). Hashes/
  salts are never returned by the API (`publicUser`). (`src/auth.ts`)

### Sessions & cookies
- Session id is a random 24-byte hex value stored server-side with an expiry;
  expired sessions don't authenticate.
- The cookie is **HttpOnly**, **SameSite=Lax**, and **Secure** when the request
  is HTTPS (inferred from `x-forwarded-proto`, or forced via `COOKIE_SECURE`).
- **Logout** deletes the session; **account delete** removes the user, all their
  sessions, and disconnects their live overlays.

### CSRF
- `SameSite=Lax` already blocks cross-site cookie sending on state-changing
  methods. In addition, every non-GET `/api/*` endpoint requires an
  `X-Requested-With` header (a cross-site `<form>` cannot set custom headers
  without a CORS preflight, which the server does not grant). (`src/api.ts`)

### Rate limiting
- Per-IP sliding-window limiter on `POST /api/signup` and `POST /api/login`
  (brute-force / signup-spam). Configurable via `AUTH_RATE_MAX` /
  `AUTH_RATE_WINDOW_MS` (default 20 / 5 min). Honors `X-Forwarded-For` first hop.
  (`src/rate-limit.ts`, `src/api.ts`)

### Input validation
- Email format + length; password minimum length (8).
- Channel handles are sanitized: strip a leading `#`/`@`, allow only
  `[A-Za-z0-9_-]`, length-capped; anything else becomes "unset".
- Overlay settings are clamped (font size 8–96, opacity 0–1) and enum-validated
  (bad `position` falls back to the current value).
- JSON body size cap (64 KB) → `413`; malformed JSON → `400`; malformed cookies
  are handled gracefully (no `500`).

### Output / rendering (no injection)
- The overlay, landing page, and dashboard render all user-controlled text via
  `textContent` / `createTextNode` — never `innerHTML` for user data. `innerHTML`
  is used only for trusted constants (brand SVGs, marketing copy).
- Emote image URLs are guarded to `http(s)://` before being used as `<img src>`
  (blocks `javascript:` / `data:` payloads). (`public/overlay.js`)

### Multi-tenant isolation
- Feeds are scoped by token → user id. One user's channels and chat never reach
  another user. Test/preview messages are flagged `test: true`, delivered only to
  the firing user's own clients, and are **never persisted** (they bypass the
  Store entirely). All covered by `test/feed.test.ts`.

### Secrets & data hygiene
- `.gitignore` covers `.env`, `.env.local`, and `data/`. No secrets or database
  files are tracked; `.env.example` contains placeholders only (the Kick Pusher
  app key is a public, browser-observable value, not a secret).

## Needs attention (before real/paying users)

- **Single-instance assumptions:** the Store (JSON file), sessions, and the rate
  limiter are per-process/in-memory. For horizontal scaling move them to a shared
  backend (Postgres + Redis). _(Store interface is already swappable.)_
- **Account safety gaps:** no email verification, password reset, or account
  lockout after repeated failures yet.
- **Transport headers:** add **HSTS** and a **Content-Security-Policy** at the
  proxy/host. (The overlay loads third-party emote CDNs — scope CSP accordingly.)
- **Unofficial platform access:** Kick and X use undocumented endpoints. Move to
  official APIs before real users (tracked TODOs; see `RECON.md` and the
  feature-flagged official Kick adapter groundwork).
- **No billing / quotas** yet (intentional) — add usage limits before exposing
  ingestion publicly to avoid abuse of the open feed.
- **Overlay token** is a bearer embedded in a URL (read-only access to public
  chat). Rotation is supported; consider short-lived/scoped tokens if the feed
  ever carries anything sensitive.
