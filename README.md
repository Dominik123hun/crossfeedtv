# CrossFeed.tv

A unified live-chat aggregator that merges **Twitch**, **Kick**, and **X (Twitter)
broadcast** chat into one real-time feed and renders it as a transparent overlay
you drop into OBS as a **Browser Source**. Stop tabbing between windows — read
everyone talking to you in one stream.

It ships as a hosted, **multi-tenant SaaS**: a marketing landing page at `/`, an
authenticated dashboard at `/dashboard` where streamers connect their channels and
get a unique overlay URL, and the functional overlay at `/overlay`.

```
 ┌──────────┐   ┌──────────┐   ┌──────────┐
 │ Twitch   │   │ Kick     │   │ X        │   3 isolated ingesters
 │ ingester │   │ ingester │   │ ingester │   (one drops → others keep flowing)
 └────┬─────┘   └────┬─────┘   └────┬─────┘
      └─────── normalize ───────────┘          one shared message schema
                   │
            ┌──────▼───────┐
            │  fan-out WS  │                   single /feed socket
            └──────┬───────┘
                   │
            ┌──────▼───────┐
            │   overlay    │                   static page = OBS Browser Source
            └──────────────┘
```

**Build status:** All steps complete. **Twitch** is fully wired (live), **Kick**
is implemented (library-first with a built-in Pusher fallback), and **X** ships
as a scalable adapter — a shared token-minting access provider feeding lightweight
raw-WS ingesters (handles 20+ chats), with all undocumented values isolated as
TODO constants / env overrides (fill them in via [`RECON.md`](./RECON.md)). Plus
emote/pill/perf/reconnect polish.

---

## Requirements

- Node.js **>= 20.6** (uses the built-in `.env` loader; v22 recommended)

## Install

```bash
npm install
```

## Configure

Copy the example env file and edit it (all values are optional):

```bash
cp .env.example .env
```

Channels can be set two ways:

- **Env vars** (`TWITCH_CHANNEL=…`) — the backend connects to these on startup.
- **Overlay query params** (`overlay.html?twitch=…`) — the overlay tells the
  backend what to ingest when it connects. This is the quick path and needs no
  code or config changes.

You don't need any API keys for Twitch — it connects anonymously (read-only).

### Kick notes

Kick has no public chat API, so the Kick ingester tries two paths:

1. **`@retconned/kick-js`** (the maintained community library) in readOnly mode —
   it handles the Cloudflare chatroom-id lookup and Pusher socket. It's an
   **optional** dependency because it pulls in Puppeteer/Chromium. Install it
   only if you want this path:
   ```bash
   npm install @retconned/kick-js
   ```
2. **Built-in Pusher fallback** (no extra deps) — used automatically if the
   library isn't installed, errors, or never connects. Set `KICK_FORCE_PUSHER=true`
   to always use it.

The Pusher fallback needs Kick's chatroom id (looked up at runtime) and the
Pusher app key/cluster (defaults ship in `.env.example`). Cloudflare blocks the
lookup from many datacenter IPs (`403`) — see [`RECON.md`](./RECON.md) to capture
working values or front it with a proxy via `KICK_API_BASE`.

### X (Twitter) broadcast notes

X broadcast chat (descended from Periscope) is **not** in the documented X API —
[confirmed against the docs](https://docs.x.com/x-api/introduction): the Spaces
API is metadata-only and the broadcast/Periscope chat API was decommissioned. So
its endpoints/tokens are not shipped.

The design separates the auth-hard part from the cheap part so it **scales to
20+ chats**:

- A single shared **access provider** mints/caches/refreshes the short-lived
  `{chatWsUrl, accessToken}` (see `src/ingesters/x-access.ts`). Pick via `X_MODE`:
  - `static` — paste captured `X_CHAT_WS_URL` + `X_ACCESS_TOKEN` (one broadcast)
  - `http` — replicate the access XHR (`X_ACCESS_URL` + auth)
  - `browser` — optional Puppeteer token-minter: **one** logged-in session mints
    tokens for **many** broadcasts (the scalable path; needs `npm i puppeteer`)
  - `auto` — first of the above that's configured
- Each chat is then a **lightweight raw WebSocket** ingester consuming that
  token — 20+ chats = 20+ cheap sockets sharing one minter.

All X-specific unknowns remain clearly-named `TODO_X_*` constants; fill them from
DevTools per [`RECON.md`](./RECON.md). Until configured, X sits in a harmless
"not configured" backoff loop and never affects the Twitch/Kick feeds.

## Run

Development (auto-reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

You should see logs like:

```
… INFO  [main] CrossFeed.tv starting…
… INFO  [http] HTTP + WS listening on http://0.0.0.0:8080
```

Open the overlay in a browser to confirm it works before wiring OBS:

```
http://localhost:8080/overlay.html?twitch=xqc&status=1
```

Pick a channel that's **currently live** (e.g. a big streamer) so chat is
flowing. `&status=1` shows a small connection HUD in the top-right. You should
see messages appear within seconds.

Health check / diagnostics:

```
http://localhost:8080/healthz
```

---

## Accounts & dashboard (multi-tenant SaaS)

Crossfeed runs as one hosted service for many streamers. Each user signs up,
connects their channels in the dashboard, and gets a **unique overlay URL** that
streams only their own merged feed.

The flow:

1. Visit `/` (landing) → **Get started** → `/signup`.
2. Sign up with email + password (`/login` to return later).
3. In `/dashboard`, enter your Twitch / Kick / X handles and **Save**.
4. Copy your overlay URL — `https://<host>/overlay?token=•••` — and paste it into
   an OBS **Browser Source**. The dashboard shows a live preview and OBS steps.

Changing channels in the dashboard updates any already-connected overlay **live**
(no OBS refresh). Each user's ingesters are isolated — one user's failing source
never touches another's feed.

**How it's wired (reused the existing vanilla stack — no framework, light deps):**

- **Auth:** email + password hashed with Node's `crypto` **scrypt**; a random
  session id in an `HttpOnly`, `SameSite=Lax` cookie (`src/auth.ts`). State-changing
  API calls also require an `X-Requested-With` header (CSRF).
- **Store:** a small, atomic **JSON file store** at `DATA_DIR` (`src/store.ts`),
  hidden behind a `Store` interface. _TODO: swap for Postgres/SQLite for
  multi-instance hosting or durable data on ephemeral hosts._
- **API:** `POST /api/signup` · `POST /api/login` · `POST /api/logout` ·
  `GET /api/me` · `PUT /api/channels` · `POST /api/token/rotate` ·
  `DELETE /api/account` (`src/api.ts`).
- **Token → feed:** `/feed?token=…` resolves the token to the user's channels and
  subscribes them via the same `Hub` fan-out (`src/server.ts`, `src/hub.ts`).

> ⚠️ **Before real paying users:** Kick and X currently use **unofficial**
> connections. Move them to official APIs first. Billing, paid tiers, and usage
> limits are intentionally **not** built yet (clear TODOs in the dashboard/code).

Marketing copy lives in one place: the `COPY` object at the top of
[`public/landing.js`](./public/landing.js).

---

## Add the overlay to OBS (Browser Source)

1. In OBS: **Sources → ➕ → Browser**, create new, name it `CrossFeed`.
2. Set the **URL** to your overlay address with the channels you want, e.g.:
   ```
   http://localhost:8080/overlay.html?twitch=xqc
   ```
3. Recommended size: **Width `460`**, **Height `900`** (a tall, narrow chat
   column). Tune to taste.
4. Leave **"Shutdown source when not visible"** unchecked so chat keeps flowing,
   and check **"Refresh browser when scene becomes active"** if you want a clean
   reset on scene switches.
5. The overlay background is **transparent** by design — no green-screen/chroma
   key needed. It draws directly over your video.

> Running OBS on a different machine than the backend? Point the URL at the
> backend host, e.g. `http://192.168.1.50:8080/overlay.html?twitch=xqc`, or use
> the `server=` param (see below).

---

## Deploy it once → streamers run nothing (hosted)

Host the backend on a public URL and a streamer only pastes an overlay link into
OBS — no install, no local backend. The Hub spins up ingesters **on demand** from
the overlay's query params, so one deployment serves everyone.

A `Dockerfile` and `render.yaml` are included. The image is light (the optional
Kick/Puppeteer deps are skipped — Kick uses the built-in Pusher fallback).

**Render (Blueprint):**
1. Push this repo to GitHub.
2. Render → **New + → Blueprint** → pick the repo. It reads `render.yaml`, builds
   the Dockerfile, terminates **TLS**, and proxies the `/feed` WebSocket.
3. Your overlay is then live at:
   ```
   https://<your-app>.onrender.com/overlay.html?twitch=xqc&kick=xqc
   ```
   Give that URL to streamers; they add it as an OBS **Browser Source** (≈460×900,
   transparent). That's it.

**Railway:** New project → **Deploy from GitHub repo**. Railway auto-detects the
`Dockerfile`, injects `PORT`, and gives an HTTPS URL with WebSocket support.

**Any Docker host:**
```bash
docker build -t crossfeedtv .
docker run -p 8080:8080 crossfeedtv
```
Put it behind a TLS reverse proxy (e.g. Caddy for automatic HTTPS) so the overlay
can use `wss://` — OBS (Chromium) requires secure WebSockets on an HTTPS page. The
overlay auto-selects `wss://` when served over HTTPS, so same-origin "just works".

Notes:
- Render's **free** plan sleeps when idle (cold start on first hit); use a paid
  plan for always-on.
- The backend is **open** by default (it'll join any channel in a URL). Fine for
  personal/contest use; add an allowlist before exposing it widely.
- Twitch channels are **multiplexed** onto shared connections by default, so one
  host can serve many distinct channels. At very large scale you may still hit
  **platform** rate limits (especially Kick lookups and X auth from one IP)
  before the server itself strains.

---

## Overlay query params

| Param    | Example                 | Default      | Meaning                                        |
| -------- | ----------------------- | ------------ | ---------------------------------------------- |
| `twitch` | `twitch=xqc`            | —            | Twitch channel login (no `#`)                  |
| `kick`   | `kick=xqc`              | —            | Kick channel slug (step 2)                     |
| `x`      | `x=1AbC…`               | —            | X broadcast id (step 3)                        |
| `size`   | `size=22`               | `18`         | Base font size in px                           |
| `max`    | `max=150`               | `200`        | Max messages kept in the DOM                   |
| `font`   | `font=Arial`            | system stack | Font family                                    |
| `badges` | `badges=0`              | `1`          | Show/hide badges                               |
| `status` | `status=1`              | `0`          | Show the per-platform connection HUD           |
| `server` | `server=ws://host:8080` | same origin  | Point the overlay at a backend on another host |

Example combining several:

```
http://localhost:8080/overlay.html?twitch=xqc&size=22&max=150&status=1
```

---

## How it works (architecture)

- **`src/ingesters/base.ts`** — shared lifecycle for every platform:
  `connect → handshake → parse → normalize → emit → auto-reconnect (backoff)`.
  Subclasses implement only the transport. Every callback is wrapped so one
  ingester can never throw out and take down the others.
- **`src/ingesters/twitch.ts` / `twitch-pool.ts`** — anonymous Twitch
  IRC-over-WebSocket reader (`justinfan` login, `CAP REQ` tags/commands/membership,
  `JOIN`, parse `PRIVMSG` tags for color/badges/emotes). By default channels are
  **multiplexed** onto a few shared connections (rate-limited JOINs, per-channel
  routing) so one host can serve many distinct channels without hitting Twitch's
  connection limits. Set `TWITCH_MULTIPLEX=false` for one connection per channel.
- **`src/hub.ts`** — owns the running ingesters (reference-counted by connected
  clients), and routes each normalized message to exactly the clients that asked
  for that platform+channel. One backend serves many overlays.
- **`src/server.ts`** — serves the static overlay over HTTP and exposes the
  fan-out WebSocket at `/feed`.
- **`public/overlay.*`** — the transparent overlay; batches DOM writes per
  animation frame and caps the DOM for burst resilience.

### Polish & resilience

- **Emotes:** resolved in the **ingester**, not the render path — the overlay is
  a dumb image-swapper that only reads `msg.emotes`. Twitch messages are augmented
  with **7TV / BTTV / FFZ** (global + per-channel, keyed off the IRC `room-id`);
  Kick emotes come inline from the message; X stays text. Sets are fetched on
  channel connect, cached, refreshed periodically, and **fail soft** (a set that
  won't load just shows the code as text). Precedence on collisions:
  channel > global, and within a scope `7TV > BTTV > FFZ > Twitch-native`
  (see `src/emotes.ts`).
- **Source pills:** colored Twitch/Kick/X pills with inline brand logos.
- **Performance:** rAF-batched rendering, `contain` per row, a 200-message DOM
  cap, async image decoding, and a queue cap so bursts on a hidden tab can't grow
  memory unbounded.
- **Reconnect hardening:** every ingester has exponential backoff + jitter **and**
  a connect watchdog (no half-open hangs); the server pings overlay clients and
  reaps dead sockets; the overlay reconnects with backoff and its own connect
  timeout. One source failing never affects the others.

### Normalized message schema

```ts
{ id, platform: "twitch" | "kick" | "x", author, color, badges: string[],
  text, emotes: { code, url }[], timestamp }
```

(`channel` is also included as a routing field; clients may ignore it.)

---

## Configuration reference

See [`.env.example`](./.env.example) for every key (server host/port, default
channels, Twitch endpoint, reconnect backoff, log level).

## Capturing unofficial values

Kick and X rely on undocumented endpoints. See [`RECON.md`](./RECON.md) for how
to capture the real values from Chrome DevTools (added with steps 2 and 3).

## License

MIT
