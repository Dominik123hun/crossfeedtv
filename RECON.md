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

X has **no official** broadcast-chat API; broadcasts still run on the legacy
**Periscope (pscp.tv)** backend. The ingester now implements the **real public
handshake** the web player uses, as three testable functions in
[`src/ingesters/x-periscope.ts`](./src/ingesters/x-periscope.ts):

1. `resolveBroadcast(id)` → `GET https://proxsee.pscp.tv/api/v2/accessVideoPublic?broadcast_id={id}&replay_redirect=false` → `chat_token`
2. `getChatAccess(chatToken)` → `GET https://proxsee.pscp.tv/api/v2/accessChatPublic?chat_token={chat_token}` → `{ endpoint, access_token }`
3. `connectChat({ wsUrl, accessToken, broadcastId })` → open `wss://{endpoint}/chatapi/v1/chatnow`, send the **auth** then **join** frame, parse `{ kind, payload }` frames.

These endpoints, field names, the `wss` path, and the auth/join frame shapes were
taken from the live-reader references — **IgnatBeresnev/periscope-chat-downloader**
(the `accessVideoPublic → chat_token`, `accessChatPublic → {endpoint, access_token}`
flow) and **jferas/ScopeSpeaker** (the `…/chatapi/v1/chatnow` wss path and the
exact `kind:3` auth + `kind:2` join frames). They are unofficial and can change —
this section is how to **verify/refresh** them, and how to handle gated broadcasts.

### Beta flag (required to turn it on)

X is **OFF by default**. The dashboard and overlay label it
"experimental / beta (unofficial, may break)". To enable the backend connection:

```
X_ENABLED=true
```

A user enters a **broadcast id** or pastes the `x.com/i/broadcasts/<id>` URL
(the id is parsed out). For a quick single-broadcast smoke test you can also set
`X_BROADCAST_ID` and run with `X_ENABLED=true`.

### If it breaks — verify the handshake in DevTools

1. Open a **currently-live** broadcast on `x.com` → DevTools (`F12`) → **Network**
   → enable **Preserve log**.
2. **Resolve:** find the `accessVideoPublic` (or equivalent) XHR → **Response** →
   confirm the field that carries the chat token is still `chat_token`. If the
   host changed, set `X_API_BASE` (default `https://proxsee.pscp.tv/api/v2`).
   If a **guest token** / `Authorization` header is now required, capture it →
   `X_GUEST_TOKEN` (the `TODO(recon)` auth header in `x-periscope.ts`).
3. **Access:** find `accessChatPublic` → **Response** → confirm `endpoint` and
   `access_token`.
4. **WebSocket:** **WS** filter → open the chat socket → confirm the URL is the
   `endpoint` host + `/chatapi/v1/chatnow` (https→wss). On the **Messages** tab,
   the **first two client→server** frames are the auth (`{"kind":3,…}`) then join
   (`{"kind":2,…}`). If they differ, set a single replacement via
   `X_SUBSCRIBE_FRAME` (sent verbatim instead of auth+join).
5. **Chat frames:** an incoming chat frame is `{ "kind":1, "payload":"…json…" }`.
   Decode `payload`: `payload.body` is a JSON string whose `.body` is the message
   text; `payload.sender` is a JSON string with `username` / `display_name`.
   Confirm the still-`TODO(recon)` keys in
   [`x-normalize.ts`](./src/ingesters/x-normalize.ts): `SENDER_COLOR`, `PAYLOAD_ID`
   (`uuid`?), `PAYLOAD_TS` (timestamp + units).

### Env vars

| Env var            | Meaning                                                            |
| ------------------ | ----------------------------------------------------------------- |
| `X_ENABLED`        | Beta flag — must be `true` for X to connect (default off).        |
| `X_API_BASE`       | Periscope API base (default `https://proxsee.pscp.tv/api/v2`).    |
| `X_GUEST_TOKEN`    | Optional bearer for **gated** broadcasts (TODO recon header).     |
| `X_BROADCAST_ID`   | A broadcast id to connect on startup (or use the dashboard).      |
| `X_SUBSCRIBE_FRAME`| Override the on-open frame(s) if the protocol changes.            |

### Still-`TODO(recon)` constants

| Constant (file)                         | Meaning / how to confirm                          |
| --------------------------------------- | ------------------------------------------------- |
| `guestToken` header (`x-periscope.ts`)  | exact auth header for gated broadcasts            |
| `SENDER_COLOR` (`x-normalize.ts`)       | sender color key, if X sends one                  |
| `PAYLOAD_ID` (`x-normalize.ts`)         | stable per-message id key (assumed `uuid`)        |
| `PAYLOAD_TS` (`x-normalize.ts`)         | timestamp key + units (assumed ms)                |

### Legacy access overrides (still supported)

The shared `XAccessManager` defaults to the public `periscope` provider above,
but the earlier `static` / `http` / `browser` providers remain for captured
values or a logged-in Puppeteer token-minter — set `X_MODE` plus the matching
`X_CHAT_WS_URL`/`X_ACCESS_TOKEN`, `X_ACCESS_URL`/`X_AUTH_BEARER`, or
`X_AUTH_TOKEN`/`X_CSRF`. (See `x-access.ts`.)
