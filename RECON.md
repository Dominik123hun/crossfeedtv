# RECON — capturing the unofficial Kick & X values

Twitch is fully documented and needs nothing here. **Kick** and **X broadcasts**
use undocumented endpoints. This guide shows how to capture the real values from
Chrome DevTools and where to plug them in.

General DevTools setup (used for both):

1. Open Chrome → `F12` (DevTools) → **Network** tab.
2. Click the **WS** filter to show only WebSocket connections.
3. Check **Preserve log** so frames survive navigations.
4. Load the page, then watch the requests appear.

---

## Kick

The backend prefers the `@retconned/kick-js` library and falls back to a
built-in **Pusher** adapter. The Pusher adapter needs two things: the
**chatroom id** for the channel and the **Pusher app key/cluster**. Defaults
ship in [`.env.example`](./.env.example); capture fresh values if Kick changes
them or Cloudflare blocks your server.

### 1. Chatroom id

The backend looks this up automatically at
`https://kick.com/api/v2/channels/<slug>` (see
[`src/ingesters/kick-lookup.ts`](./src/ingesters/kick-lookup.ts)). Cloudflare
sometimes blocks datacenter IPs with a `403`/`503`. To grab the id by hand:

1. Visit `https://kick.com/<channel>` while it's **live**.
2. DevTools → **Network** → filter `channels`.
3. Open the `…/api/v2/channels/<channel>` request → **Response** (or **Preview**).
4. Find `chatroom.id` (e.g. `chatroom: { id: 123456, … }`).

That number is the chatroom id. The Pusher channel the adapter subscribes to is
`chatrooms.<chatroomId>.v2`.

> If Cloudflare blocks your server, run the backend somewhere it's allowed, put a
> proxy in front via `KICK_API_BASE`, or hard-pin the id (see TODO in
> `kick-lookup.ts`).

### 2. Pusher app key / cluster

1. On the live channel page, DevTools → **Network** → **WS** filter.
2. Find the socket to `wss://ws-<cluster>.pusher.com/app/<APP_KEY>?...`.
3. Read the values straight out of the URL:
   - `<cluster>` is in the host, e.g. `ws-us2.pusher.com` → cluster `us2`.
   - `<APP_KEY>` is the path segment after `/app/`.
4. Click the socket → **Messages** tab to confirm the protocol:
   - A `pusher:connection_established` frame on connect.
   - You send `pusher:subscribe` with `{ channel: "chatrooms.<id>.v2" }`.
   - Chat arrives as `App\Events\ChatMessageEvent` frames whose `data` is a
     JSON **string** (the message object the normalizer parses).

Map the captured values to env vars:

| Captured                         | Env var                | Used in                  |
| -------------------------------- | ---------------------- | ------------------------ |
| `ws-<cluster>.pusher.com`        | `KICK_PUSHER_CLUSTER`  | `kick.ts` socket URL     |
| `/app/<APP_KEY>`                 | `KICK_PUSHER_APP_KEY`  | `kick.ts` socket URL     |
| `version=<n>` in the socket URL  | `KICK_PUSHER_VERSION`  | `kick.ts` socket URL     |
| `chatroom.id` from the v2 API    | (looked up at runtime) | `kick-lookup.ts`         |

### Kick OFFICIAL API (optional, the "right" way) — groundwork is in the repo

The unofficial Pusher path above works today, but the proper path is Kick's
official API: **OAuth 2.1 (PKCE) → subscribe to `chat.message.sent` → Kick POSTs
signed webhooks to your public URL**. A separate, feature-flagged adapter is
already drafted in [`src/ingesters/kick-official.ts`](./src/ingesters/kick-official.ts)
(signature verification + event→message mapping implemented and tested; OAuth/
subscription endpoints stubbed with TODOs). It is **OFF by default** and does not
touch the working ingester.

To enable it:

1. **Register an app** in Kick's developer portal → get a **client id/secret**
   (`KICK_CLIENT_ID` / `KICK_CLIENT_SECRET`).
2. **Expose a public HTTPS URL** that maps to `KICK_WEBHOOK_PATH` (default
   `/webhooks/kick`) → set `KICK_WEBHOOK_PUBLIC_URL`.
3. **Get Kick's event-signing public key** (PEM, from the portal/docs) →
   `KICK_EVENT_PUBLIC_KEY` (use `\n` for newlines when inline).
4. **OAuth + subscribe:** complete the OAuth 2.1 + PKCE flow and create a
   `chat.message.sent` subscription pointing at your webhook URL. (The
   `exchangeCodeForToken` / `subscribeToChatEvents` stubs mark exactly where.)
5. Set `KICK_OFFICIAL_ENABLED=true` and restart.

While wiring it, confirm the `TODO(kick-official)` items against the current docs:
OAuth/subscribe endpoint URLs, the **signed-content concatenation** used for the
signature (this repo assumes `messageId.timestamp.rawBody`), the webhook **header
names** (`Kick-Event-*`), and the **payload field names** in `chat.message.sent`.

---

## X (Twitter) broadcasts — EXPERIMENTAL / BETA (unofficial)

X has **no official** broadcast-chat API; broadcasts run on the **Periscope**
backend, resolved through the modern **x.com guest API**. The ingester implements
this as testable functions in
[`src/ingesters/x-periscope.ts`](./src/ingesters/x-periscope.ts):

0. `getGuestToken()` → `POST https://api.twitter.com/1.1/guest/activate.json` (public web bearer) → `guest_token` — **best-effort**; deprecated, so a failure is non-fatal and resolution falls back to bearer-only.
1. `resolveBroadcast(id)` → `GET https://api.x.com/1.1/broadcasts/show.json?ids={id}&include_events=true` (bearer, plus `x-guest-token` when available) → `chat_token`
2. `getChatAccess(chatToken)` → `GET https://proxsee.pscp.tv/api/v2/accessChatPublic?chat_token={chat_token}` → `{ endpoint, access_token }`
3. `connectChat({ wsUrl, accessToken, broadcastId })` → open `wss://{endpoint}/chatapi/v1/chatnow`, send the **auth** then **join** frame, parse `{ kind, payload }` frames.

The resolve host/endpoint (`api.x.com/1.1/broadcasts/show.json`) is from the
current **offish/twitter-x-broadcast-downloader**; the chat access + socket flow
is from **IgnatBeresnev/periscope-chat-downloader** (`accessChatPublic → {endpoint,
access_token}`) and **jferas/ScopeSpeaker** (the `…/chatapi/v1/chatnow` wss path +
the exact `kind:3` auth / `kind:2` join frames). Unofficial — this section is how
to **verify/refresh** each step.

> **The legacy public `proxsee.pscp.tv/accessVideoPublic` path 404s for modern
> x.com broadcasts** — that's why resolution now goes through the guest API. A
> `broadcasts/show HTTP 404` usually means the broadcast isn't live/public.

**Verify a single broadcast in one command** (no need to enable X or open OBS):

```
npm run x:probe -- <broadcastId | x.com/i/broadcasts/… URL>
```

It runs steps 0→2 and prints each result or the exact failing step.

### Beta flag (required to turn it on)

X is **OFF by default**. The dashboard and overlay label it
"experimental / beta (unofficial, may break)". To enable the backend connection:

```
X_ENABLED=true
```

A user enters a **broadcast id** or pastes the `x.com/i/broadcasts/<id>` URL
(the id is parsed out). For a quick single-broadcast smoke test you can also set
`X_BROADCAST_ID` and run with `X_ENABLED=true`.

### Authentication — the guest path is dead; use a logged-in session

X **deprecated the anonymous guest-token endpoint** (`guest/activate.json` now
404s), and `broadcasts/show.json` then returns 404 without auth. The working path
is **one shared logged-in session** (your account) — it resolves *every* user's
public broadcast, so it still scales. Capture two cookies from a logged-in
`x.com` tab (DevTools → **Application → Cookies → https://x.com**):

| Cookie       | Env var        |
| ------------ | -------------- |
| `auth_token` | `X_AUTH_TOKEN` |
| `ct0`        | `X_CSRF`       |

Set both (keep `X_MODE=auto`) and the resolver authenticates as your account.
Treat `auth_token` like a password — it's a full session token; it expires
(re-capture when resolution starts 401ing), and automating a logged-in session is
against X's ToS, so this stays a **beta/at-your-own-risk** capability.

### If it breaks — verify each step in DevTools

Run `npm run x:probe -- <id>` first; it tells you which step fails. Then:

1. Open a **currently-live** broadcast on `x.com` → DevTools (`F12`) → **Network**
   → enable **Preserve log**.
2. **Guest token:** if the probe fails at `guest/activate` with 401/403, x.com has
   rotated the public bearer → grab the `authorization: Bearer …` header from any
   guest request and set `X_BEARER`. (Or paste an `x-guest-token` value into
   `X_GUEST_TOKEN` to skip activation.)
3. **Resolve:** find `broadcasts/show.json` → **Response** → confirm the
   `chat_token` field's location. `extractChatToken` searches `broadcasts[id]`,
   the top level, then deep — but if the key was renamed, update it in
   `x-periscope.ts`. Host moved? set `X_API_BASE`.
4. **Access:** find `accessChatPublic` → **Response** → confirm `endpoint` +
   `access_token`. Host moved? set `X_PSCP_BASE`.
5. **WebSocket:** **WS** filter → open the chat socket → confirm the URL is the
   `endpoint` host + `/chatapi/v1/chatnow` (https→wss). On the **Messages** tab,
   the **first two client→server** frames are the auth (`{"kind":3,…}`) then join
   (`{"kind":2,…}`). If they differ, set a single replacement via
   `X_SUBSCRIBE_FRAME` (sent verbatim instead of auth+join).
6. **Chat frames:** an incoming chat frame is `{ "kind":1, "payload":"…json…" }`.
   Decode `payload`: `payload.body` is a JSON string whose `.body` is the message
   text; `payload.sender` is a JSON string with `username` / `display_name`.
   Confirm the still-`TODO(recon)` keys in
   [`x-normalize.ts`](./src/ingesters/x-normalize.ts): `SENDER_COLOR`, `PAYLOAD_ID`
   (`uuid`?), `PAYLOAD_TS` (timestamp + units).

### Env vars

| Env var            | Meaning                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `X_ENABLED`        | Beta flag — must be `true` for X to connect (default off).        |
| `X_API_BASE`       | x.com API base for resolve (default `https://api.x.com/1.1`).     |
| `X_GUEST_API_BASE` | Guest-token host (default `https://api.twitter.com/1.1`).         |
| `X_PSCP_BASE`      | Periscope chat base (default `https://proxsee.pscp.tv/api/v2`).   |
| `X_AUTH_TOKEN`     | **Logged-in `auth_token` cookie** — needed now that guest auth is dead. |
| `X_CSRF`           | **Logged-in `ct0` cookie** (also sent as `x-csrf-token`).         |
| `X_BEARER`         | Override the public web bearer if guest auth 401s.                |
| `X_GUEST_TOKEN`    | Pre-minted guest token (skips `activate.json`).                   |
| `X_BROADCAST_ID`   | A broadcast id to connect on startup (or use the dashboard).      |
| `X_SUBSCRIBE_FRAME`| Override the on-open frame(s) if the protocol changes.            |

### Still-`TODO(recon)` constants

| Constant (file)                         | Meaning / how to confirm                          |
| --------------------------------------- | ------------------------------------------------- |
| `DEFAULT_WEB_BEARER` (`x-periscope.ts`) | public web bearer; X may rotate it (→ `X_BEARER`) |
| `extractChatToken` (`x-periscope.ts`)   | exact `chat_token` location in show.json          |
| `SENDER_COLOR` (`x-normalize.ts`)       | sender color key, if X sends one                  |
| `PAYLOAD_ID` (`x-normalize.ts`)         | stable per-message id key (assumed `uuid`)        |
| `PAYLOAD_TS` (`x-normalize.ts`)         | timestamp key + units (assumed ms)                |

### Legacy access overrides (still supported)

The shared `XAccessManager` defaults to the public `periscope` provider above,
but the earlier `static` / `http` / `browser` providers remain for captured
values or a logged-in Puppeteer token-minter — set `X_MODE` plus the matching
`X_CHAT_WS_URL`/`X_ACCESS_TOKEN`, `X_ACCESS_URL`/`X_AUTH_BEARER`, or
`X_AUTH_TOKEN`/`X_CSRF`. (See `x-access.ts`.)
