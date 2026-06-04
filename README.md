# CrossFeed.tv

A unified live-chat aggregator that merges **Twitch**, **Kick**, and **X (Twitter)
broadcast** chat into one real-time feed and renders it as a transparent overlay
you drop into OBS as a **Browser Source**. Stop tabbing between windows — read
everyone talking to you in one stream.

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

**Build status:** Steps 1–2 complete — **Twitch** is fully wired (live), and
**Kick** is implemented (library-first with a built-in Pusher fallback). X
(step 3) lands next; the architecture already routes it.

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
- **`src/ingesters/twitch.ts`** — anonymous Twitch IRC-over-WebSocket reader
  (`justinfan` login, `CAP REQ` tags/commands/membership, `JOIN`, parse
  `PRIVMSG` tags for color/badges/emotes).
- **`src/hub.ts`** — owns the running ingesters (reference-counted by connected
  clients), and routes each normalized message to exactly the clients that asked
  for that platform+channel. One backend serves many overlays.
- **`src/server.ts`** — serves the static overlay over HTTP and exposes the
  fan-out WebSocket at `/feed`.
- **`public/overlay.*`** — the transparent overlay; batches DOM writes per
  animation frame and caps the DOM for burst resilience.

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
